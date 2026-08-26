/**
 * AKB48 Mail レスキューツール — 本番 UI(S-5)。
 * 録画ガイド / 動画投入(複数可、順次処理)/ 進捗 / 結果プレビュー(除外・日時修正)/ ZIP 出力 /
 * IndexedDB による処理済み結果の復元(NF-4)。
 * 本ツールはご自身の端末内でのみ動作し、動画をどこにもアップロードしません(INV-1 / INV-6)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import type { OutputItem, WorkerResponse } from './worker/messages'
import { formatTimestamp, imageFileName, mailFileName, normalizeTimestampInput } from './core/ocr'
import { ResultStore, jobIdFor, type JobRecord, type StoredSegMeta } from './core/store'
import { RecordingGuide } from './ui/RecordingGuide'
import './ui/app.css'

interface LogLine {
  key: number
  text: string
  kind: 'frame' | 'event' | 'info' | 'error'
}

type Output = OutputItem & { key: string; seq: number; url: string; included: boolean; editedTimestamp: string | null }

const store = ResultStore.available() ? new ResultStore() : null

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
  const [showGuide, setShowGuide] = useState(true)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState<number>(Date.now())
  const keyRef = useRef(0)
  const seqRef = useRef(0)
  const jobRef = useRef<JobRecord | null>(null)
  const segMetaRef = useRef<Record<number, StoredSegMeta>>({})
  const busyRef = useRef(false)

  const append = useCallback((text: string, kind: LogLine['kind'] = 'info') => {
    setLines((prev) => (prev.length > 5000 ? prev.slice(-4000) : prev).concat({ key: keyRef.current++, text, kind }))
  }, [])

  const refreshJobs = useCallback(async () => {
    if (!store) return
    setJobs(await store.listJobs())
  }, [])

  const persistJob = useCallback(async (patch: Partial<JobRecord>) => {
    if (!jobRef.current) return
    jobRef.current = { ...jobRef.current, ...patch }
    setCurrentJob(jobRef.current)
    await store?.putJob(jobRef.current).catch(() => {})
  }, [])

  const updateSegMeta = useCallback(
    (id: number, patch: Partial<StoredSegMeta>) => {
      const next = { ...segMetaRef.current, [id]: { ...(segMetaRef.current[id] ?? { timestamp: null, sender: null }), ...patch } }
      segMetaRef.current = next
      setSegMeta(next)
      void persistJob({ segMeta: next })
    },
    [persistJob],
  )

  // 起動時: 前回 running のまま残ったジョブを interrupted に
  useEffect(() => {
    if (!store) return
    store
      .markInterrupted()
      .then(refreshJobs)
      .catch(() => {})
  }, [refreshJobs])

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const w = new Worker(new URL('./worker/pipeline.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    const fail = (msg: string) => {
      append(msg, 'error')
      setStatus('エラー')
      void persistJob({ status: 'error', error: msg }).then(refreshJobs)
      busyRef.current = false
    }
    w.onerror = (ev) => fail(`WORKER ERROR: ${ev.message ?? 'unknown'} (${ev.filename ?? ''}:${ev.lineno ?? ''})`)
    w.onmessageerror = () => append('WORKER MESSAGE ERROR', 'error')
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data
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
          void store?.putOutput({ key, jobId, seq, item: m.item, included: true, editedTimestamp: null }).catch(() => {})
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
    return () => w.terminate()
  }, [append, persistJob, refreshJobs, updateSegMeta])

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
      resetView()
      setStatus('読み込み中')
      setStartedAt(Date.now())
      const job: JobRecord = {
        id: jobIdFor(file),
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
        await store.deleteJob(job.id).catch(() => {})
        await store.putJob(job).catch(() => {})
        await refreshJobs()
      }
      append(`file: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) type=${file.type || '-'}`)
      append(`env: ${navigator.userAgent} / WebCodecs=${typeof VideoDecoder !== 'undefined'} / OffscreenCanvas=${typeof OffscreenCanvas !== 'undefined'}`)
      // 静的アセット(ffmpeg.wasm / tesseract)の基準 URL。ページ基準で解決するとサブパス配信でも正しい
      const assetBase = new URL(import.meta.env.BASE_URL, document.baseURI).href
      workerRef.current.postMessage({ type: 'analyze', file, assetBase })
    },
    [append, refreshJobs, resetView],
  )

  // キュー: 1 本ずつ順に処理(status が変わるたびに次を確認)
  useEffect(() => {
    if (busyRef.current || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void startFile(next)
  }, [queue, status, startFile])

  const enqueueFiles = (files: FileList | File[] | null | undefined) => {
    if (!files) return
    const list = Array.from(files).filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name) || f.type.startsWith('video/'))
    if (list.length === 0) return
    setQueue((q) => [...q, ...list])
    setShowGuide(false)
  }

  /** 保存済みジョブの結果を IndexedDB から復元して表示 */
  const restoreJob = async (job: JobRecord) => {
    if (!store || busyRef.current) return
    resetView()
    jobRef.current = job
    setCurrentJob(job)
    segMetaRef.current = job.segMeta ?? {}
    setSegMeta(job.segMeta ?? {})
    setSummary(job.summaryText ?? '')
    setStatus(job.status === 'done' ? '完了' : `${STATUS_LABEL[job.status]}(処理済み分を復元)`)
    const outs = await store.listOutputs(job.id)
    seqRef.current = outs.length
    setOutputs(outs.map((o) => ({ ...o.item, key: o.key, seq: o.seq, url: URL.createObjectURL(o.item.blob), included: o.included, editedTimestamp: o.editedTimestamp })))
    append(`restored ${outs.length} outputs for ${job.fileName} (status=${job.status})`)
  }

  const deleteJob = async (job: JobRecord) => {
    if (!store) return
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

  /** 最終ファイル名(出現順。同一日時は _2, _3 …、unknown の番号は何通目か) */
  const finalNames = useMemo(() => {
    const names = new Map<string, string>()
    const seen = new Map<string, number>()
    let mails = 0
    let images = 0
    for (const o of outputs) {
      if (!o.included) continue
      if (o.kind === 'image') {
        names.set(o.key, imageFileName(++images))
        continue
      }
      if (!o.part || o.part.index === 1) mails++
      const ts = o.editedTimestamp ?? segMeta[o.seg]?.timestamp ?? null
      let base: string
      if (ts) {
        const dup = seen.get(ts) ?? 0
        seen.set(ts, dup + 1)
        base = mailFileName(ts, 0, dup)
      } else {
        base = mailFileName(null, mails)
      }
      if (o.part) base = base.replace(/\.png$/, `_p${o.part.index}of${o.part.total}.png`)
      names.set(o.key, base)
    }
    return names
  }, [outputs, segMeta])

  const setOutputPatch = (key: string, patch: Partial<Pick<Output, 'included' | 'editedTimestamp'>>) => {
    setOutputs((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)))
    void store?.updateOutput(key, patch).catch(() => {})
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
        <input id="file" type="file" multiple accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" onChange={(e) => enqueueFiles(e.target.files)} />
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
        </div>
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
                <span className="time">{new Date(j.updatedAt).toLocaleString()}</span>
                <button disabled={running} onClick={() => restoreJob(j)}>
                  結果を開く
                </button>
                <button disabled={running} onClick={() => deleteJob(j)}>
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
          このツールはオープンソース(GPL-3.0)で公開しています。動画の読み込みに ffmpeg.wasm(GPL)、文字の読み取りに tesseract.js(Apache-2.0)を使用しています。
        </p>
      </footer>
    </main>
  )
}
