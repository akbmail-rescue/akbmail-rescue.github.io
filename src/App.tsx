/**
 * AKB48 Mail レスキューツール — 本番 UI(S-5)。
 * 録画ガイド / 動画投入(複数可、順次処理)/ 進捗 / 結果プレビュー(除外・日時修正)/ ZIP 出力 /
 * IndexedDB による処理済み結果の復元(NF-4)。
 * 本ツールはご自身の端末内でのみ動作し、動画をどこにもアップロードしません(INV-1 / INV-6)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import type { OutputItem, WorkerResponse } from './worker/messages'
import { formatTimestamp, normalizeTimestampInput } from './core/ocr'
import { ResultStore, fingerprintFor, newJobId, type JobRecord, type StoredSegMeta } from './core/store'
import { assignFinalNames } from './core/naming'
import { acceptsMessage } from './core/jobEvents'
import { RecordingGuide } from './ui/RecordingGuide'
import './ui/app.css'

interface LogLine {
  key: number
  text: string
  kind: 'frame' | 'event' | 'info' | 'error'
}

type Output = OutputItem & { key: string; seq: number; url: string; included: boolean; editedTimestamp: string | null }

const store = ResultStore.available() ? new ResultStore() : null
/** このタブの識別子(処理中ジョブの所有者) */
const OWNER_ID = newJobId()
/** Worker から一定時間メッセージが無ければ停止の疑いを表示する */
const STALL_WARN_MS = 180_000
/** さらにこの時間メッセージが無ければ自動で中止する(ハング対策、R2 #5) */
const STALL_ABORT_MS = 600_000

const STATUS_LABEL: Record<JobRecord['status'], string> = { running: '処理中', done: '完了', error: 'エラー', interrupted: '中断' }

export default function App() {
  const workerRef = useRef<Worker | null>(null)
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<string>('待機中')
  const [progress, setProgress] = useState<number>(0)
  const [summary, setSummary] = useState<string>('')
  const [outputs, setOutputs] = useState<Output[]>([])
  const [segMeta, setSegMeta] = useState<Record<number, StoredSegMeta>>({})
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [currentJob, setCurrentJob] = useState<JobRecord | null>(null)
  const [queue, setQueue] = useState<File[]>([])
  const [zipBusy, setZipBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const [persistFailures, setPersistFailures] = useState(0)
  const [storageNote, setStorageNote] = useState<string>('')
  const [workerGen, setWorkerGen] = useState(0)
  const lastMsgRef = useRef<number>(Date.now())
  const keyRef = useRef(0)
  const seqRef = useRef(0)
  const jobRef = useRef<JobRecord | null>(null)
  const segMetaRef = useRef<Record<number, StoredSegMeta>>({})
  const busyRef = useRef(false)
  const cancelCurrentRef = useRef<((reason?: string) => void) | null>(null)
  /** 復元中フラグと世代(復元中は投入・開始・削除を止め、完了時に世代を再確認する。R5 #2) */
  const [restoring, setRestoring] = useState(false)
  const restoreGenRef = useRef(0)

  const append = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLines((prev) => (prev.length > 5000 ? prev.slice(-4000) : prev).concat({ key: keyRef.current++, text, kind }))
  }, [])

  const refreshJobs = useCallback(async () => {
    if (!store) return
    setJobs(await store.listJobs())
  }, [])

  const notePersistFailure = useCallback((what: string, e: unknown) => {
    setPersistFailures((n) => n + 1)
    append(`SAVE FAILED (${what}): ${e instanceof Error ? e.message : String(e)} — この結果はブラウザに保存されていません。ZIP を必ずダウンロードしてください`, 'error')
  }, [append])

  const persistJob = useCallback(async (patch: Partial<JobRecord>) => {
    if (!jobRef.current) return
    jobRef.current = { ...jobRef.current, ...patch }
    setCurrentJob(jobRef.current)
    // 部分更新: DB 上の heartbeat を古い値で巻き戻さない(R2 #4)
    const saved = await store?.patchJob(jobRef.current.id, patch, jobRef.current).catch((e) => {
      notePersistFailure('job', e)
      return undefined
    })
    if (saved && jobRef.current && saved.id === jobRef.current.id) jobRef.current = { ...jobRef.current, heartbeatAt: saved.heartbeatAt }
  }, [notePersistFailure])

  const updateSegMeta = useCallback(
    (id: number, patch: Partial<StoredSegMeta>) => {
      const next = { ...segMetaRef.current, [id]: { ...(segMetaRef.current[id] ?? { timestamp: null, sender: null }), ...patch } }
      segMetaRef.current = next
      setSegMeta(next)
      void persistJob({ segMeta: next })
    },
    [persistJob],
  )

  // 起動時: 前回 running のまま残ったジョブ(heartbeat が古いもの)を interrupted に。保存領域も確認
  useEffect(() => {
    if (!store) return
    store
      .markInterrupted(OWNER_ID)
      .then(refreshJobs)
      .catch((e) => append(`履歴の読み込みに失敗: ${e instanceof Error ? e.message : String(e)}`, 'error'))
    void ResultStore.estimate().then((e) => {
      if (!e) return
      const freeMB = (e.quota - e.usage) / 1024 / 1024
      if (freeMB < 500) setStorageNote(`ブラウザの保存領域の空きが約 ${Math.round(freeMB)}MB です。結果が保存できない場合があるので、動画ごとに ZIP を保存し履歴を削除してください`)
    })
  }, [append, refreshJobs])

  // 処理中は 10 秒ごとに heartbeat(他タブの誤中断を防ぐ)
  useEffect(() => {
    const t = setInterval(() => {
      const j = jobRef.current
      if (store && j && j.status === 'running' && busyRef.current) void store.heartbeat(j.id, OWNER_ID).catch(() => {})
    }, 10_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // 無応答が STALL_ABORT_MS を超えたら自動中止(R2 #5)
  useEffect(() => {
    if (!(status === '読み込み中' || status === '解析中')) return
    if (now - lastMsgRef.current > STALL_ABORT_MS) cancelCurrentRef.current?.('無応答のため自動で中止しました')
  }, [now, status])

  useEffect(() => {
    const w = new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    lastMsgRef.current = Date.now()
    const fail = (msg: string) => {
      append(msg, 'error')
      setStatus('エラー')
      void persistJob({ status: 'error', error: msg }).then(refreshJobs)
      busyRef.current = false
      // 異常状態の Worker を次の動画に使い回さない(R3 #3): 作り直す
      setWorkerGen((g) => g + 1)
    }
    // 旧 Worker インスタンスからの遅延イベントは無視する(R5 #3)
    const isCurrent = () => workerRef.current === w
    w.onerror = (ev) => {
      if (!isCurrent()) return
      fail(`WORKER ERROR: ${ev.message ?? 'unknown'} (${ev.filename ?? ''}:${ev.lineno ?? ''})`)
    }
    // デシリアライズ失敗も致命エラー扱い(R4 #3): ジョブを error にして Worker を作り直す
    w.onmessageerror = () => {
      if (!isCurrent()) return
      fail('WORKER MESSAGE ERROR: 応答を受け取れませんでした')
    }
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (!isCurrent()) return
      const m = e.data
      // 世代判定(R4 #2): 現在のジョブ宛てでない応答(旧 Worker の遅延イベント)は捨てる
      if (!acceptsMessage(m.jobId, jobRef.current?.id ?? null)) {
        append(`(ignored stale worker message: ${m.type} for job ${m.jobId ?? '-'})`)
        return
      }
      lastMsgRef.current = Date.now()
      switch (m.type) {
        case 'track':
          append(`track: codec=${m.info.codec} ${m.info.codedWidth}x${m.info.codedHeight} timescale=${m.info.timescale} duration=${m.info.durationSec.toFixed(3)}s samples=${m.info.nbSamples} webcodecs_supported=${m.supported}`)
          setStatus('解析中')
          break
        case 'unsupported':
          fail(`UNSUPPORTED: ${m.message}`)
          break
        case 'stage':
          append(`stage: ${m.stage}`)
          break
        case 'frame':
          append(`${String(m.frame.index).padStart(4)} t=${m.frame.t.toFixed(3).padStart(7)} bm=${m.frame.bm.toFixed(4)} dk=${m.frame.dk.toFixed(4)} hd=${m.frame.hd.toFixed(4)} ${m.frame.cat}${m.frame.boundary ? ' [boundary]' : ''}`, 'frame')
          break
        case 'boundary_rise':
          append(`>>> boundary_rise #${m.riseCount} at frame ${m.frame.index} (t=${m.frame.t.toFixed(3)}s)`, 'event')
          break
        case 'segment_closed':
          append(`=== segment ${m.id} closed: t=${m.tStart.toFixed(3)}–${m.tEnd.toFixed(3)}s frames=${m.frames} (index ${m.indexStart}–${m.indexEnd})`, 'event')
          updateSegMeta(m.id, { indexStart: m.indexStart, indexEnd: m.indexEnd, tStart: m.tStart, tEnd: m.tEnd })
          break
        case 'ocr':
          append(`ocr seg=${m.seg} frame=${m.index} attempt=${m.attempt} ts=${m.timestamp ?? '-'} sender=${m.sender ?? '-'} raw="${m.rawTimestamp}"`, m.timestamp ? 'event' : 'info')
          if (m.timestamp) updateSegMeta(m.seg, { timestamp: m.timestamp, sender: m.sender })
          break
        case 'output': {
          append(`*** output ${m.item.kind}: ${m.item.name} seg=${m.item.seg} frame=${m.item.index} t=${m.item.t.toFixed(3)} bm=${m.item.bm.toFixed(4)} hash=${m.item.hash} stable=${m.item.fromStable} ${m.item.width}x${m.item.height} ${(m.item.blob.size / 1024).toFixed(0)}KB${m.item.stitched ? ` STITCHED(accepted=${m.item.stitchAccepted})` : ''}`, 'event')
          const jobId = jobRef.current?.id ?? 'no-job'
          const seq = seqRef.current++
          const key = `${jobId}/${m.item.name}`
          setOutputs((prev) => [...prev, { ...m.item, key, seq, url: URL.createObjectURL(m.item.blob), included: true, editedTimestamp: null }])
          void store?.putOutput({ key, jobId, seq, item: m.item, included: true, editedTimestamp: null }).catch((e) => {
            notePersistFailure(`output ${m.item.name}`, e)
            void persistJob({ persistFailures: (jobRef.current?.persistFailures ?? 0) + 1 })
          })
          break
        }
        case 'skipped':
          append(`--- skipped ${m.what} (${m.reason}): seg=${m.seg} frame=${m.index} t=${m.t.toFixed(3)} hash=${m.hash}`, 'error')
          break
        case 'progress':
          setProgress(m.bytesTotal ? m.bytesRead / m.bytesTotal : 0)
          break
        case 'done': {
          const s = m.summary
          const per = s.perSegment
            .map((p) => `  seg${p.id} t=${p.tStart.toFixed(3)}–${p.tEnd.toFixed(3)} list=${p.counts.list} detail=${p.counts.detail} fullscreen=${p.counts.fullscreen_image}`)
            .join('\n')
          const txt = `DONE path=${m.path} boundary_rises=${s.boundaryRises} segments=${s.segments} mail_segments=${s.mailSegments} mails=${m.outputs.mails} (stitched ${m.outputs.stitchedMails}) images=${m.outputs.images} skipped=${m.outputs.skipped} stitch_ms_per_frame=${m.outputs.stitchMsPerFrame.toFixed(0)} decoded=${m.stats.decoded} sampled=${m.stats.sampled} peak_retained_frames=${m.stats.peakRetainedFrames} peak_retained_images=${m.outputs.peakRetainedImages} elapsed=${(m.elapsedMs / 1000).toFixed(1)}s\n${per}`
          append(txt, 'event')
          setSummary(txt)
          setStatus('完了')
          setProgress(1)
          void persistJob({ status: 'done', summaryText: txt, path: m.path }).then(refreshJobs)
          busyRef.current = false
          break
        }
        case 'error':
          fail(`ERROR: ${m.message}`)
          break
      }
    }
    return () => {
      if (workerRef.current === w) workerRef.current = null
      w.terminate()
    }
  }, [append, notePersistFailure, persistJob, refreshJobs, updateSegMeta, workerGen])

  /** 処理を中止: Worker を破棄して作り直し、ジョブは interrupted(処理済み分は残る) */
  const cancelCurrent = useCallback((reason?: string) => {
    if (!busyRef.current) return
    busyRef.current = false
    append(`${reason ?? 'キャンセルしました'}(処理済みの結果は残ります)`, 'error')
    setStatus('中断(処理済み分を復元)')
    void persistJob({ status: 'interrupted' }).then(refreshJobs)
    setWorkerGen((g) => g + 1)
  }, [append, persistJob, refreshJobs])

  cancelCurrentRef.current = cancelCurrent

  const resetView = useCallback(() => {
    setLines([])
    setSummary('')
    setSegMeta({})
    segMetaRef.current = {}
    setOutputs((prev) => {
      for (const o of prev) URL.revokeObjectURL(o.url)
      return []
    })
    setProgress(0)
    seqRef.current = 0
  }, [])

  const startFile = useCallback(
    async (file: File) => {
      if (!workerRef.current) return
      busyRef.current = true
      restoreGenRef.current++ // 進行中の復元を無効化(R5 #2)
      resetView()
      setStatus('読み込み中')
      setStartedAt(Date.now())
      setPersistFailures(0)
      const job: JobRecord = {
        id: newJobId(),
        fingerprint: fingerprintFor(file),
        ownerId: OWNER_ID,
        heartbeatAt: Date.now(),
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        segMeta: {},
      }
      jobRef.current = job
      setCurrentJob(job)
      if (store) {
        await store.putJob(job).catch((e) => notePersistFailure('job', e))
        await refreshJobs()
      }
      append(`file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) type=${file.type || '-'}`)
      append(`env: ${navigator.userAgent} / WebCodecs=${typeof VideoDecoder !== 'undefined'} / OffscreenCanvas=${typeof OffscreenCanvas !== 'undefined'}`)
      // 静的アセット(ffmpeg.wasm / tesseract)の基準 URL。ページ基準で解決するとサブパス配信でも正しい
      const assetBase = new URL(import.meta.env.BASE_URL, document.baseURI).href
      workerRef.current.postMessage({ type: 'analyze', file, assetBase, jobId: job.id })
    },
    [append, notePersistFailure, refreshJobs, resetView],
  )

  // キュー: 1 本ずつ順に処理(status が変わるたびに次を確認)。復元中は開始しない
  useEffect(() => {
    if (busyRef.current || restoring || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void startFile(next)
  }, [queue, status, restoring, startFile])

  const enqueueFiles = (files: FileList | File[] | null | undefined) => {
    if (!files || restoring) return
    restoreGenRef.current++ // 進行中の復元があれば無効化
    const list = Array.from(files).filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name) || f.type.startsWith('video/'))
    if (list.length === 0) return
    setQueue((q) => [...q, ...list])
    setShowGuide(false)
  }

  /** 保存済みジョブの結果を IndexedDB から復元して表示 */
  /** 保存済みジョブの結果を IndexedDB から復元して表示。読み込みが成功してから画面を一括更新する(R6 #4) */
  const restoreJob = async (job: JobRecord) => {
    if (!store || busyRef.current || restoring) return
    const gen = ++restoreGenRef.current
    setRestoring(true)
    setStatus(`復元中: ${job.fileName}`)
    try {
      const outs = await store.listOutputs(job.id)
      // 読み込み中に別の操作(削除・別ジョブ開始)が起きていたら結果を捨てる(R5 #2)
      if (gen !== restoreGenRef.current) {
        append(`restore of ${job.fileName} discarded (superseded)`)
        return
      }
      resetView()
      jobRef.current = job
      setCurrentJob(job)
      segMetaRef.current = job.segMeta ?? {}
      setSegMeta(job.segMeta ?? {})
      setSummary(job.summaryText ?? '')
      seqRef.current = outs.length
      setOutputs(outs.map((o) => ({ ...o.item, key: o.key, seq: o.seq, url: URL.createObjectURL(o.item.blob), included: o.included, editedTimestamp: o.editedTimestamp })))
      setStatus(job.status === 'done' ? '完了' : `${STATUS_LABEL[job.status]}(処理済み分を復元)`)
      append(`restored ${outs.length} outputs for ${job.fileName} (status=${job.status})`)
    } catch (e) {
      // 直前の表示は保ったまま、復元エラーだけを明示する
      append(`復元に失敗: ${e instanceof Error ? e.message : String(e)}`, 'error')
      if (gen === restoreGenRef.current) setStatus(`復元エラー: ${job.fileName}(ブラウザの保存領域を読めませんでした)`)
    } finally {
      if (gen === restoreGenRef.current) setRestoring(false)
    }
  }

  const deleteJob = async (job: JobRecord) => {
    if (!store || restoring) return
    restoreGenRef.current++ // 進行中の復元があれば無効化
    if (!window.confirm(`「${job.fileName}」の処理結果を端末から削除します。よろしいですか?`)) return
    await store.deleteJob(job.id)
    if (jobRef.current?.id === job.id) {
      jobRef.current = null
      setCurrentJob(null)
      resetView()
      setStatus('待機中')
    }
    await refreshJobs()
  }

  /** 最終ファイル名(出現順・分割は 1 通扱い。src/core/naming.ts) */
  const finalNames = useMemo(() => assignFinalNames(outputs, (seg) => segMeta[seg]?.timestamp ?? null), [outputs, segMeta])

  const setOutputPatch = (key: string, patch: Partial<Pick<Output, 'included' | 'editedTimestamp'>>) => {
    setOutputs((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)))
    void store?.updateOutput(key, patch).catch((e) => notePersistFailure('edit', e))
  }

  const downloadZip = async () => {
    setZipBusy(true)
    try {
      const zip = new JSZip()
      const meta: Array<Record<string, unknown>> = []
      const fileName = currentJob?.fileName ?? 'akbmail'
      for (const o of outputs) {
        if (!o.included) continue
        const name = finalNames.get(o.key)!
        zip.file(name, o.blob)
        const sm = segMeta[o.seg]
        const ts = o.kind === 'mail' ? (o.editedTimestamp ?? sm?.timestamp ?? null) : null
        meta.push({
          file: name,
          kind: o.kind,
          timestamp: ts ? formatTimestamp(ts) : null,
          sender: o.kind === 'mail' ? (sm?.sender ?? null) : null,
          source_video: fileName,
          frame_range: sm ? [sm.indexStart, sm.indexEnd] : null,
          time_range_sec: sm ? [sm.tStart, sm.tEnd] : null,
          representative_frame: o.index,
          stitched: o.stitched,
        })
      }
      zip.file('metadata.json', JSON.stringify(meta, null, 2))
      const blob = await zip.generateAsync({ type: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${fileName.replace(/\.[^.]+$/, '') || 'akbmail'}_rescue.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } finally {
      setZipBusy(false)
    }
  }

  const includedCount = outputs.filter((o) => o.included).length
  const running = status === '読み込み中' || status === '解析中'
  const stalled = running && now - lastMsgRef.current > STALL_WARN_MS
  const elapsedSec = startedAt && running ? (now - startedAt) / 1000 : 0
  const remainingSec = running && progress > 0.02 ? (elapsedSec / progress) * (1 - progress) : null

  return (
    <main className="app">
      <header className="app-header">
        <h1>AKB48 Mail レスキューツール</h1>
        <p className="notice">本ツールはご自身の端末内でのみ動作し、動画をどこにもアップロードしません。</p>
        <p className="sub">画面収録した動画から、メール本文を 1 通ずつ PNG 画像として保存します。</p>
      </header>

      <section className="card">
        <button className="link" onClick={() => setShowGuide((v) => !v)}>
          {showGuide ? '▼' : '▶'} 録画手順ガイド(精度のために必ずお読みください)
        </button>
        {showGuide && <RecordingGuide />}
      </section>

      <section
        className="card dropzone"
        onDragOver={(e) => {
          e.preventDefault()
          e.currentTarget.classList.add('over')
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('over')}
        onDrop={(e) => {
          e.preventDefault()
          e.currentTarget.classList.remove('over')
          enqueueFiles(e.dataTransfer.files)
        }}
      >
        <p>動画ファイル(MP4 / MOV)をここにドラッグ&ドロップ、または選択してください(複数可・順番に処理します)</p>
        <input id="file" type="file" multiple accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" disabled={restoring} onChange={(e) => enqueueFiles(e.target.files)} />
        <div className="status-row">
          状態: <strong id="status">{status}</strong>
          {currentJob && <span> / {currentJob.fileName}</span>}
          {running && (
            <span>
              {' '}
              / 進捗 {Math.round(progress * 100)}% / 経過 {Math.round(elapsedSec)} 秒{remainingSec !== null ? ` / 残り約 ${Math.max(1, Math.round(remainingSec))} 秒` : ''}
            </span>
          )}
          {queue.length > 0 && <span> / 待機中 {queue.length} 本</span>}
          {running && (
            <button style={{ marginLeft: 12 }} onClick={() => cancelCurrent()}>
              中止
            </button>
          )}
        </div>
        {stalled && <p className="warn">{Math.round((now - lastMsgRef.current) / 1000)} 秒間、処理の進行がありません。動画が壊れているか、ブラウザが対応していない可能性があります。「中止」で止められます(処理済みの結果は残ります)</p>}
        {persistFailures > 0 && <p className="warn">結果の保存に {persistFailures} 件失敗しました。この結果はブラウザを閉じると消えるので、必ず ZIP をダウンロードしてください。</p>}
        {storageNote && <p className="warn">{storageNote}</p>}
        <progress value={progress} max={1} />
      </section>

      {store && jobs.length > 0 && (
        <section className="card">
          <h2>処理履歴(この端末内に保存)</h2>
          <ul className="jobs">
            {jobs.map((j) => (
              <li key={j.id} className={currentJob?.id === j.id ? 'current' : ''}>
                <span className="name">{j.fileName}</span>
                <span className={`badge ${j.status}`}>{STATUS_LABEL[j.status]}</span>
                {j.persistFailures ? <span className="warn">保存失敗 {j.persistFailures} 件</span> : null}
                <span className="time">{new Date(j.updatedAt).toLocaleString()}</span>
                <button disabled={running || restoring} onClick={() => restoreJob(j)}>
                  結果を開く
                </button>
                <button disabled={running || restoring} onClick={() => deleteJob(j)}>
                  削除
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">タブを閉じたり落ちたりしても、処理済みの分はここから復元できます。復元した結果も ZIP にできます。</p>
        </section>
      )}

      {outputs.length > 0 && (
        <section id="outputs" className="card">
          <h2>
            結果 {outputs.length} 件(メール {outputs.filter((o) => o.kind === 'mail').length} / 画像 {outputs.filter((o) => o.kind === 'image').length})、出力対象 {includedCount} 件
          </h2>
          <p className="hint">不要なものはチェックを外してください。日時が読み取れなかったメール(赤枠)は、画像を見て日時を入力するとファイル名に反映されます。</p>
          <button id="zip" className="primary" disabled={zipBusy || includedCount === 0 || running} onClick={downloadZip}>
            {zipBusy ? 'ZIP 作成中…' : 'ZIP ダウンロード(PNG + metadata.json)'}
          </button>
          <div className="grid">
            {outputs.map((o) => {
              const sm = segMeta[o.seg]
              const ts = o.editedTimestamp ?? sm?.timestamp ?? null
              return (
                <figure key={o.key} className={`output ${o.included ? '' : 'excluded'}`} data-final={finalNames.get(o.key) ?? ''}>
                  <a href={o.url} download={finalNames.get(o.key) ?? o.name} target="_blank" rel="noreferrer">
                    <img src={o.url} alt={o.name} loading="lazy" />
                  </a>
                  <figcaption>
                    <label>
                      <input type="checkbox" checked={o.included} onChange={(e) => setOutputPatch(o.key, { included: e.target.checked })} /> 出力する
                    </label>
                    <div className="fname">{finalNames.get(o.key) ?? '(除外)'}</div>
                    {o.kind === 'mail' && (
                      <>
                        <div>差出人: {sm?.sender ?? <span className="warn">不明</span>}</div>
                        <input
                          className={`ts ${ts ? '' : 'missing'}`}
                          type="text"
                          placeholder="日時 例: 2026-08-25 22:59"
                          defaultValue={ts ? formatTimestamp(ts) : ''}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            const n = v ? normalizeTimestampInput(v) : null
                            if (v && !n) {
                              e.target.classList.add('invalid')
                              return
                            }
                            e.target.classList.remove('invalid')
                            setOutputPatch(o.key, { editedTimestamp: n })
                          }}
                        />
                      </>
                    )}
                    <div className="meta">
                      {o.t.toFixed(1)}秒 {o.width}×{o.height}
                      {o.stitched ? ' / 縦結合' : ''}
                    </div>
                  </figcaption>
                </figure>
              )
            })}
          </div>
        </section>
      )}

      <section className="card">
        <button className="link" onClick={() => setShowLog((v) => !v)}>
          {showLog ? '▼' : '▶'} 詳細ログ(開発・不具合報告用)
        </button>
        {summary && (
          <pre id="summary" className="summary">
            {summary}
          </pre>
        )}
        <pre id="log" className={`log ${showLog ? '' : 'collapsed'}`}>
          {lines.map((l) => (
            <div key={l.key} className={`l-${l.kind}`}>
              {l.text}
            </div>
          ))}
        </pre>
      </section>

      <footer className="app-footer">
        <p>処理はすべてこの端末の中で行われ、動画・画像・文字情報が外部に送られることはありません。保存した画像の取り扱いはご自身の責任でお願いします。</p>
        <p>
          このツールはオープンソース(GPL-3.0)で公開しています。動画の読み込みに ffmpeg.wasm(GPL)、文字の読み取りに tesseract.js(Apache-2.0)ほかを使用しています。{' '}
          <a href="THIRD_PARTY_NOTICES.txt" target="_blank" rel="noreferrer">
            使用しているソフトウェアとライセンス
          </a>
        </p>
      </footer>
    </main>
  )
}
