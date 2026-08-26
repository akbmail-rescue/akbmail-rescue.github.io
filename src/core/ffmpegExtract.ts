/**
 * ffmpeg.wasm によるフレーム抽出フォールバック(WebCodecs が HEVC 等を復号できない環境向け)。
 *
 * - コア(ffmpeg-core.js / .wasm)は npm 同梱物を Vite の ?url でセルフホストする。CDN は使わない(INV-1)
 * - 入力ファイルは WORKERFS でマウントし、wasm メモリへ丸ごとコピーしない(INV-2)
 * - `-ss T -t L -i in -vf fps=6` を数秒のチャンクごとに実行し、PNG を読んだら即削除する。
 *   チャンク長を 1/fps の整数倍にすることで、ネイティブ ffmpeg の単発 `fps=6` と同じスロット割当になる
 * - PNG → ImageBitmap → 既存の CanvasGraySource 経路で分類する(WebCodecs 経路と同じコード)
 */
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import coreURL from '@ffmpeg/core?url'
import wasmURL from '@ffmpeg/core/wasm?url'

export interface FfmpegExtractOptions {
  fps: number
  durationSec: number
  /** チャンク長(秒)。1/fps の整数倍であること */
  chunkSec?: number
  onFrame: (slot: number, bitmap: ImageBitmap) => void | Promise<void>
  onProgress?: (doneSec: number, totalSec: number) => void
  log?: (msg: string) => void
}

/** 1 チャンク(chunkSec 秒)の ffmpeg 実行上限。遅い端末でも 3 秒分の HEVC 復号に 5 分はかからない想定。超過は例外(ハング対策、R2 #5) */
export const EXEC_TIMEOUT_MS = 5 * 60 * 1000

let cached: Promise<FFmpeg> | null = null
let callSeq = 0

/** 異常終了後は汚染された可能性があるインスタンスを捨てる(R5 #4) */
async function discardCached() {
  const c = cached
  cached = null
  try {
    const ff = await c
    ff?.terminate()
  } catch {
    /* ignore */
  }
}

async function loadFfmpeg(log?: (m: string) => void): Promise<FFmpeg> {
  if (!cached) {
    cached = (async () => {
      const ff = new FFmpeg()
      // 'Aborted()' は ffmpeg.wasm が exec 終了時に毎回出す無害なメッセージ
      ff.on('log', ({ message }) => {
        if (message !== 'Aborted()') log?.(`[ffmpeg] ${message}`)
      })
      const t0 = performance.now()
      await ff.load({
        coreURL: await toBlobURL(coreURL, 'text/javascript'),
        wasmURL: await toBlobURL(wasmURL, 'application/wasm'),
      })
      log?.(`ffmpeg.wasm loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      return ff
    })().catch((e) => {
      cached = null
      throw e
    })
  }
  return cached
}

export async function extractWithFfmpeg(file: File, opt: FfmpegExtractOptions): Promise<{ sampled: number }> {
  const fps = opt.fps
  const chunkSec = opt.chunkSec ?? 3
  if (Math.abs(chunkSec * fps - Math.round(chunkSec * fps)) > 1e-9) throw new Error('chunkSec must be a multiple of 1/fps')
  const ff = await loadFfmpeg(opt.log)

  // 呼び出しごとに一意なディレクトリを使い、同一 Worker で複数本処理しても残留状態と衝突しない(R5 #4)
  const id = ++callSeq
  const MOUNT = `/input_${id}`
  const OUT = `/out_${id}`
  const input = new File([file], 'input.mp4', { type: file.type })
  let ok = false
  let sampled = 0
  try {
    await ff.createDir(MOUNT)
    await ff.mount('WORKERFS' as Parameters<FFmpeg['mount']>[0], { files: [input] }, MOUNT)
    await ff.createDir(OUT)
    for (let start = 0; start < opt.durationSec; start += chunkSec) {
      const len = Math.min(chunkSec, opt.durationSec - start)
      const baseSlot = Math.round(start * fps)
      const rc = await ff.exec(
        [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', start.toFixed(6),
        '-t', len.toFixed(6),
        '-i', `${MOUNT}/input.mp4`,
        '-an',
        '-vf', `fps=${fps}`,
        '-f', 'image2',
        `${OUT}/f_%05d.png`,
        ],
        EXEC_TIMEOUT_MS,
      )
      if (rc !== 0) throw new Error(rc === -1 ? `ffmpeg が ${start}s のチャンクで ${EXEC_TIMEOUT_MS / 1000} 秒以内に終わりませんでした(タイムアウト)` : `ffmpeg exited with ${rc} at ${start}s`)
      const files = (await ff.listDir(OUT))
        .filter((n) => !n.isDir && /^f_\d+\.png$/.test(n.name))
        .map((n) => n.name)
        .sort()
      for (const name of files) {
        const data = (await ff.readFile(`${OUT}/${name}`)) as Uint8Array
        await ff.deleteFile(`${OUT}/${name}`)
        const idx = parseInt(name.slice(2, 7), 10) - 1
        const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/png' }), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        })
        try {
          await opt.onFrame(baseSlot + idx, bitmap)
        } finally {
          bitmap.close()
        }
        sampled++
      }
      opt.onProgress?.(Math.min(start + len, opt.durationSec), opt.durationSec)
    }
    ok = true
  } finally {
    // 出力の残骸・マウント・ディレクトリを確実に除去。処理失敗でも後始末失敗でもインスタンスごと破棄する(R6 #2)
    const cleanupErrors: string[] = []
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (e) {
        cleanupErrors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await step('listDir/deleteFile', async () => {
      for (const n of await ff.listDir(OUT)) if (!n.isDir) await ff.deleteFile(`${OUT}/${n.name}`)
    })
    await step('deleteDir(out)', () => ff.deleteDir(OUT))
    await step('unmount', () => ff.unmount(MOUNT))
    await step('deleteDir(mount)', () => ff.deleteDir(MOUNT))
    if (cleanupErrors.length) opt.log?.(`ffmpeg cleanup failed (instance discarded): ${cleanupErrors.join('; ')}`)
    if (!ok || cleanupErrors.length) await discardCached()
  }
  return { sampled }
}
