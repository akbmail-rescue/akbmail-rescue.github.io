/// <reference lib="webworker" />
/**
 * S-1 パイプライン Worker: デマックス → WebCodecs デコード → 6fps サンプリング → 分類 → 区間化。
 * 画素データは分類直後に破棄し、メインスレッドへは分類結果(数値)のみを送る。
 * ネットワーク送信は一切行わない(INV-1)。
 */
import { demuxVideo } from '../core/demux'
import { SampledVideoDecoder, buildDecoderConfig, hasWebCodecs, type DecoderStats } from '../core/decoder'
import { CanvasGraySource } from '../core/frameGray'
import { classifyFrame } from '../core/classify'
import { Segmenter, summarize, type ClassifiedFrame } from '../core/segment'
import { SAMPLE_FPS } from '../core/regions'
import { extractWithFfmpeg } from '../core/ffmpegExtract'
import type { VideoTrackInfo } from '../core/demux'
import { phashFromGray, phashToHex } from '../core/phash'
import { RepresentativeSelector, type SelectEvent } from '../core/select'
import { STATUS_BAR_TOP } from '../core/regions'
import { STITCH_FIXED_TOP, Stitcher, rgbaToGrayCv } from '../core/stitch'
import { TiledCanvasCompositor, type FrameRegion } from '../core/stitchCanvas'
import { MAX_OCR_ATTEMPTS, OCR_REGIONS, OCR_UPSCALE, OcrService } from '../core/ocr'
import { OcrQueue } from '../core/ocrQueue'
import { rectPixels } from '../core/regions'
import type { WorkerRequest, WorkerResponse } from './messages'

/** 現在処理中のジョブ ID。全応答にエコーバックし、UI 側で世代の違う応答を捨てられるようにする(R4 #2) */
let currentJobId = ''
const post = (msg: WorkerResponse) => self.postMessage({ ...msg, jobId: currentJobId })

async function analyze(file: File, assetBase: string, jobId: string) {
  currentJobId = jobId
  const started = performance.now()
  post({ type: 'stage', stage: `worker ready: webcodecs=${hasWebCodecs()} offscreen=${typeof OffscreenCanvas !== 'undefined'}` })
  const gray = new CanvasGraySource()
  const segmenter = new Segmenter()
  // S-2: 代表フレーム選定。候補画像は ImageBitmap(キャンバスのコピー)として保持し、負けたら close する
  const selector = new RepresentativeSelector<ImageBitmap>((img) => img.close())
  let peakRetainedImages = 0
  const counts = { mails: 0, images: 0, skipped: 0, stitchedMails: 0 }

  // S-4: OCR。区間ごとに最初の detail フレームから順に試し、タイムスタンプが取れたら止める(rescue.py と同じ)。
  // 認識は非同期キューで行い、パイプラインを止めない。done の前に drain する
  const ocr = new OcrService(
    { workerPath: `${assetBase}tesseract/worker.min.js`, corePath: `${assetBase}tesseract-core/`, langPath: `${assetBase}tessdata/` },
    (m) => post({ type: 'stage', stage: m }),
  )
  // OCR 待ち行列(R1 #4 / R2 #2, #3 / R3 #1, #2): 候補はグレー 8bit 配列(≈0.5MB)、区間 8・待ち 3・全体 64、直列、動的 drain
  type OcrCrop = { width: number; height: number; gray: Uint8Array }
  const toCanvas = (c: OcrCrop): OffscreenCanvas => {
    const cv = new OffscreenCanvas(c.width, c.height)
    const ctx = cv.getContext('2d')!
    const img = ctx.createImageData(c.width, c.height)
    for (let i = 0, j = 0; i < c.gray.length; i++, j += 4) {
      img.data[j] = img.data[j + 1] = img.data[j + 2] = c.gray[i]
      img.data[j + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return cv
  }
  const ocrQueue = new OcrQueue<{ ts: OcrCrop; sd: OcrCrop }>(
    async (img) => {
      const t = await ocr.recognizeTimestamp(toCanvas(img.ts))
      let sender: { sender: string | null; raw: string } = { sender: null, raw: '' }
      if (t.timestamp) sender = await ocr.recognizeSender(toCanvas(img.sd))
      return { timestamp: t.timestamp, sender: sender.sender, rawTimestamp: t.raw.trim(), rawSender: sender.raw.trim() }
    },
    (ev) => post({ type: 'ocr', seg: ev.seg, index: ev.index, attempt: ev.attempt, timestamp: ev.outcome.timestamp, sender: ev.outcome.sender, rawTimestamp: ev.outcome.rawTimestamp, rawSender: ev.outcome.rawSender }),
    (e) => post({ type: 'stage', stage: `OCR unavailable: ${(e as Error).message}(メタデータは unknown になります)` }),
    () => {},
    MAX_OCR_ATTEMPTS,
    64,
  )
  const scheduleOcr = (seg: number, index: number, src: CanvasGraySource) => {
    // 受け入れられないフレームには切り出しコストを払わない(R4 #4)
    if (!ocrQueue.canAccept(seg, index)) return
    const tr = rectPixels(src.width, src.height, OCR_REGIONS.timestamp)
    const sr = rectPixels(src.width, src.height, OCR_REGIONS.sender)
    ocrQueue.offer(seg, {
      index,
      image: {
        ts: src.cropGrayUpscaledArray(tr.colStart, tr.colEnd, tr.rowStart, tr.rowEnd, OCR_UPSCALE),
        sd: src.cropGrayUpscaledArray(sr.colStart, sr.colEnd, sr.rowStart, sr.rowEnd, OCR_UPSCALE),
      },
    })
  }

  // S-3: 区間ごとのスティッチ(detail フレームのみ投入)。区間が閉じたら結果を取り出して破棄する
  let stitcher: Stitcher<FrameRegion> | null = null
  let compositor: TiledCanvasCompositor | null = null
  let stitchGray = new Uint8Array(0)
  let stitchMs = 0
  let stitchFrames = 0
  let lastFixedRows = 0
  const stitchPush = (src: CanvasGraySource) => {
    const w = src.width
    const top = Math.trunc(src.height * STITCH_FIXED_TOP)
    const h = src.height - top
    if (!stitcher) {
      compositor = new TiledCanvasCompositor(w)
      stitcher = new Stitcher<FrameRegion>(w, h, compositor, lastFixedRows)
      stitchGray = new Uint8Array(w * h)
    }
    const t0 = performance.now()
    const gray = rgbaToGrayCv(src.rgbaRect(0, w, top, src.height), stitchGray)
    const d = stitcher.push(gray, { source: src.source, sx: 0, sy: top, sw: w, sh: h })
    stitchMs += performance.now() - t0
    stitchFrames++
    if (d.reason !== 'first') post({ type: 'stage', stage: `stitch#${d.index} dx=${d.dx.toFixed(2)} dy=${d.dy.toFixed(2)} resp=${d.response.toFixed(3)} ${d.accepted ? `ACCEPT +${d.addRows}` : d.reason} skip=${d.skip} scale=${d.scaleUsed ?? '-'} canvas=${compositor!.height}` })
    return d
  }
  /** 区間終了時: スクロールが採用されていればスティッチ画像を返し、状態を捨てる */
  const takeStitched = async (): Promise<{ blobs: Blob[]; accepted: number; height: number } | null> => {
    const st = stitcher
    const comp = compositor
    stitcher = null
    compositor = null
    if (!st || !comp) return null
    const accepted = st.acceptedCount
    const height = comp.height
    lastFixedRows = st.fixedRows
    post({ type: 'stage', stage: `stitch: frames=${st.decisions.length} accepted=${accepted} identical_skipped=${st.identicalSkipped} height=${height}px fixedRows=${st.fixedRows}${comp.truncatedRows ? ` TRUNCATED(${comp.truncatedRows} rows dropped: メモリ上限)` : ''}` })
    if (comp.truncatedRows) post({ type: 'skipped', what: 'mail', reason: `stitch_truncated_${comp.truncatedRows}_rows`, seg: -1, index: -1, t: 0, hash: '' })
    if (accepted === 0) {
      comp.dispose()
      return null
    }
    const blobs = await comp.toBlobs()
    comp.dispose()
    return { blobs, accepted, height }
  }

  const handleSelect = async (evs: SelectEvent<ImageBitmap>[], stitched: { blobs: Blob[]; accepted: number; height: number } | null) => {
    for (const ev of evs) {
      if (ev.kind === 'skipped') {
        counts.skipped++
        post({ type: 'skipped', what: ev.what, reason: ev.reason, seg: ev.seg, index: ev.index, t: ev.t, hash: phashToHex(ev.hash) })
        continue
      }
      const it = ev.item
      const n = it.kind === 'mail' ? ++counts.mails : ++counts.images
      const name = it.kind === 'mail' ? `mail_${String(n).padStart(2, '0')}_seg${it.seg}_t${it.t.toFixed(3)}.png` : `image_${String(n).padStart(3, '0')}.png`
      try {
        if (it.kind === 'mail' && stitched) {
          // スクロールが検出された区間: 代表フレームの代わりにスティッチ結果を出力する
          counts.stitchedMails++
          const total = stitched.blobs.length
          stitched.blobs.forEach((blob, i) => {
            const pname = total > 1 ? name.replace(/\.png$/, `_p${i + 1}of${total}.png`) : name.replace(/\.png$/, '_stitched.png')
            post({ type: 'output', item: { kind: 'mail', name: pname, blob, seg: it.seg, index: it.index, t: it.t, bm: it.bm, hash: phashToHex(it.hash), fromStable: it.fromStable, width: it.image.width, height: stitched.height, stitched: true, stitchAccepted: stitched.accepted, part: total > 1 ? { index: i + 1, total } : undefined } })
          })
        } else {
          const blob = await encodeCropped(it.image)
          post({ type: 'output', item: { kind: it.kind, name, blob, seg: it.seg, index: it.index, t: it.t, bm: it.bm, hash: phashToHex(it.hash), fromStable: it.fromStable, width: it.image.width, height: it.image.height - Math.trunc(it.image.height * STATUS_BAR_TOP), stitched: false, stitchAccepted: 0 } })
        }
      } finally {
        it.image.close()
      }
    }
  }

  /** WebCodecs 経路・ffmpeg.wasm 経路で共通の 1 フレーム処理 */
  const handleFrame = async (slot: number, src: VideoFrame | ImageBitmap) => {
    const g = gray.load(src)
    const m = classifyFrame(g)
    const cf: ClassifiedFrame = { index: slot, t: slot / SAMPLE_FPS, ...m }
    post({ type: 'frame', frame: cf })
    for (const ev of segmenter.push(cf)) await emit(ev)
    if (cf.cat === 'detail') {
      stitchPush(gray)
      scheduleOcr(segmenter.currentSegmentId, slot, gray)
    }
    if (cf.cat !== 'loading') {
      // pHash は rescue.py と同じくフルフレームのグレーから(256→32 縮小は phash 側)
      const hash = phashFromGray(g.rows(0, g.height), g.width, g.height)
      selector.push({ index: slot, t: cf.t, bm: cf.bm, cat: cf.cat, hash, capture: () => gray.snapshot() })
      peakRetainedImages = Math.max(peakRetainedImages, selector.retained)
    }
  }
  const emit = async (ev: ReturnType<Segmenter['push']>[number]) => {
    if (ev.kind === 'boundary_rise') post({ type: 'boundary_rise', frame: ev.frame, riseCount: ev.riseCount })
    else {
      post({ type: 'segment_closed', id: ev.segment.id, tStart: ev.segment.frames[0].t, tEnd: ev.segment.frames.at(-1)!.t, frames: ev.segment.frames.length, indexStart: ev.segment.frames[0].index, indexEnd: ev.segment.frames.at(-1)!.index })
      const stitched = await takeStitched()
      await handleSelect(selector.closeSegment(), stitched)
    }
  }
  const finish = async (stats: DecoderStats, path: 'webcodecs' | 'ffmpeg.wasm') => {
    for (const ev of segmenter.finish()) await emit(ev)
    post({ type: 'stage', stage: `waiting for OCR (queued=${ocrQueue.queued})` })
    await ocrQueue.drain()
    await ocr.terminate().catch(() => {})
    const st = ocrQueue.stats()
    post({ type: 'stage', stage: `ocr summary: segments=${st.length} found=${st.filter((x) => x.found).length} attempts=${st.reduce((a, x) => a + x.attempts, 0)} dropped=${ocrQueue.droppedTotal} errors=${ocrQueue.errorCount}` })
    if (ocrQueue.droppedTotal > 0) post({ type: 'skipped', what: 'mail', reason: `ocr_candidates_dropped_${ocrQueue.droppedTotal}`, seg: -1, index: -1, t: 0, hash: '' })
    post({ type: 'done', summary: summarize(segmenter), stats, elapsedMs: performance.now() - started, path, outputs: { ...counts, peakRetainedImages, stitchMsPerFrame: stitchFrames ? stitchMs / stitchFrames : 0 } })
  }

  let track: VideoTrackInfo | null = null
  let decoder: SampledVideoDecoder | null = null
  try {
    if (!hasWebCodecs()) throw new UnsupportedCodecError('-', 'WebCodecs 非対応ブラウザ')
    post({ type: 'stage', stage: 'demux start' })
    await demuxVideo(file, {
      async onTrack(info) {
        track = info
        post({ type: 'stage', stage: `moov parsed: ${info.codec} ${info.nbSamples} samples` })
        const config = buildDecoderConfig(info)
        const support = await VideoDecoder.isConfigSupported(config)
        post({ type: 'stage', stage: `isConfigSupported=${support.supported}` })
        const { description: _d, ...pub } = info
        post({ type: 'track', info: pub, supported: !!support.supported })
        if (!support.supported) throw new UnsupportedCodecError(info.codec, 'WebCodecs が復号不可')
        decoder = new SampledVideoDecoder(config, SAMPLE_FPS, ({ slot, frame }) => handleFrame(slot, frame))
      },
      async onSamples(samples) {
        await decoder!.feed(samples)
      },
      onProgress(bytesRead, bytesTotal) {
        post({ type: 'progress', bytesRead, bytesTotal, sampled: 0, retainedFrames: 0 })
      },
    })
    await finish(await decoder!.finish(), 'webcodecs')
    return
  } catch (err) {
    if (!(err instanceof UnsupportedCodecError)) throw err
    if (!track) {
      post({ type: 'unsupported', codec: err.codec, message: `${err.message}。動画情報を取得できないためフォールバックできません。` })
      return
    }
    post({ type: 'stage', stage: `${err.message} → ffmpeg.wasm フォールバックで抽出します(時間がかかります)` })
  }

  // ---- ffmpeg.wasm フォールバック ----
  const info = track as VideoTrackInfo
  const { sampled } = await extractWithFfmpeg(file, {
    fps: SAMPLE_FPS,
    durationSec: info.durationSec,
    onFrame: (slot, bitmap) => handleFrame(slot, bitmap),
    onProgress: (done, total) => post({ type: 'progress', bytesRead: done, bytesTotal: total, sampled: 0, retainedFrames: 1 }),
    log: (m) => post({ type: 'stage', stage: m }),
  })
  await finish({ decoded: sampled, sampled, peakRetainedFrames: 1 }, 'ffmpeg.wasm')
}

/** ステータスバー(h×0.055)を除いて PNG にエンコードする(rescue.py: crop((0, int(h*0.055), w, h))) */
async function encodeCropped(img: ImageBitmap): Promise<Blob> {
  const top = Math.trunc(img.height * STATUS_BAR_TOP)
  const c = new OffscreenCanvas(img.width, img.height - top)
  const ctx = c.getContext('2d')!
  ctx.drawImage(img, 0, top, img.width, img.height - top, 0, 0, img.width, img.height - top)
  return c.convertToBlob({ type: 'image/png' })
}

class UnsupportedCodecError extends Error {
  constructor(readonly codec: string, reason: string) {
    super(`codec ${codec}: ${reason}`)
  }
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  if (e.data.type !== 'analyze') return
  try {
    await analyze(e.data.file, e.data.assetBase, e.data.jobId)
  } catch (err) {
    console.error('[pipeline]', err)
    post({ type: 'error', message: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  }
}
