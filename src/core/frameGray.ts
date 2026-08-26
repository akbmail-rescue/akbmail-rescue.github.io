/**
 * VideoFrame → GraySource。OffscreenCanvas に描画し、必要な行帯だけ getImageData して
 * Pillow と同じ式でグレー化する。フレーム全体の RGBA を保持しない。
 */
import { rgbaToGray } from './gray'
import type { FrameSource } from './classify'

export class CanvasGraySource implements FrameSource {
  private canvas: OffscreenCanvas | null = null
  private ctx: OffscreenCanvasRenderingContext2D | null = null
  width = 0
  height = 0

  /** フレーム(VideoFrame または ImageBitmap)を描画して以降の rows() の対象にする。 */
  load(frame: VideoFrame | ImageBitmap): this {
    const w = 'displayWidth' in frame ? frame.displayWidth : frame.width
    const h = 'displayHeight' in frame ? frame.displayHeight : frame.height
    if (!this.canvas || this.width !== w || this.height !== h) {
      this.canvas = new OffscreenCanvas(w, h)
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
      if (!this.ctx) throw new Error('2D context unavailable')
      this.width = w
      this.height = h
    }
    this.ctx!.drawImage(frame, 0, 0, w, h)
    return this
  }

  /** 呼び出しごとに新しい配列を返す(darkness は 2 帯を同時に参照するため共有バッファ不可)。 */
  rows(rowStart: number, rowEnd: number): Uint8Array {
    const img = this.ctx!.getImageData(0, rowStart, this.width, rowEnd - rowStart)
    return rgbaToGray(img.data)
  }

  /** 現在フレームを描画済みのキャンバス(drawImage の描画元として使う) */
  get source(): OffscreenCanvas {
    return this.canvas!
  }

  /** 現在のフレームのコピー(ImageBitmap)。代表候補として保持するために使う。呼び出し側が close する */
  snapshot(): ImageBitmap {
    // transferToImageBitmap はキャンバスを空にするため、別キャンバスへ描画してから転送する
    const c = new OffscreenCanvas(this.width, this.height)
    c.getContext('2d')!.drawImage(this.canvas!, 0, 0)
    return c.transferToImageBitmap()
  }

  /**
   * 矩形を切り出してグレー化し、scale 倍に拡大した OffscreenCanvas を返す(OCR 用)。
   * rescue.py: crop(...).convert("L").resize((w*2, h*2))
   */
  cropGrayUpscaled(colStart: number, colEnd: number, rowStart: number, rowEnd: number, scale: number): OffscreenCanvas {
    const w = colEnd - colStart
    const h = rowEnd - rowStart
    const src = this.ctx!.getImageData(colStart, rowStart, w, h)
    const d = src.data
    for (let j = 0; j < d.length; j += 4) {
      const g = (d[j] * 19595 + d[j + 1] * 38470 + d[j + 2] * 7471 + 0x8000) >> 16
      d[j] = d[j + 1] = d[j + 2] = g
      d[j + 3] = 255
    }
    const small = new OffscreenCanvas(w, h)
    small.getContext('2d')!.putImageData(src, 0, 0)
    const big = new OffscreenCanvas(w * scale, h * scale)
    const bctx = big.getContext('2d')!
    bctx.imageSmoothingEnabled = true
    bctx.imageSmoothingQuality = 'high'
    bctx.drawImage(small, 0, 0, w * scale, h * scale)
    small.width = 0 // 中間キャンバスは即解放
    return big
  }

  /** cropGrayUpscaled と同じ内容をグレー 8bit 配列で返す(待ち行列で軽く保持するため) */
  cropGrayUpscaledArray(colStart: number, colEnd: number, rowStart: number, rowEnd: number, scale: number): { width: number; height: number; gray: Uint8Array } {
    const cv = this.cropGrayUpscaled(colStart, colEnd, rowStart, rowEnd, scale)
    const d = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data
    const gray = new Uint8Array(cv.width * cv.height)
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = d[j]
    const out = { width: cv.width, height: cv.height, gray }
    cv.width = 0 // backing store を即解放
    return out
  }

  rgbaRect(colStart: number, colEnd: number, rowStart: number, rowEnd: number): Uint8ClampedArray {
    return this.ctx!.getImageData(colStart, rowStart, colEnd - colStart, rowEnd - rowStart).data
  }
}
