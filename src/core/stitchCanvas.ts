/**
 * ブラウザ用コンポジタ: スティッチ結果をタイル分割した OffscreenCanvas で保持する(INV-3)。
 * 巨大なキャンバスや Uint8Array を伸長のたびに再確保しない。
 */
import type { Compositor } from './stitch'

const TILE_ROWS = 1024

export interface FrameRegion {
  /** 描画元(現在フレームを描いた OffscreenCanvas 等) */
  source: CanvasImageSource
  /** 描画元の中で使う矩形(fixed_top 除去後の領域) */
  sx: number
  sy: number
  sw: number
  sh: number
}

export class TiledCanvasCompositor implements Compositor<FrameRegion> {
  private tiles: OffscreenCanvas[] = []
  private rows = 0
  constructor(readonly width: number) {}

  get height(): number {
    return this.rows
  }

  private ensureRows(rows: number) {
    while (this.tiles.length * TILE_ROWS < rows) {
      const c = new OffscreenCanvas(this.width, TILE_ROWS)
      const ctx = c.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, this.width, TILE_ROWS)
      this.tiles.push(c)
    }
  }

  /** frame の領域を dstRow 行目からタイルに描く */
  private paint(frame: FrameRegion, dstRow: number) {
    const end = dstRow + frame.sh
    for (let t = Math.floor(dstRow / TILE_ROWS); t * TILE_ROWS < end; t++) {
      const tileTop = t * TILE_ROWS
      const y0 = Math.max(dstRow, tileTop)
      const y1 = Math.min(end, tileTop + TILE_ROWS)
      const ctx = this.tiles[t].getContext('2d')!
      ctx.drawImage(frame.source, frame.sx, frame.sy + (y0 - dstRow), frame.sw, y1 - y0, 0, y0 - tileTop, frame.sw, y1 - y0)
    }
  }

  init(frame: FrameRegion, frameRows: number): void {
    this.tiles = []
    this.rows = frameRows
    this.ensureRows(this.rows)
    this.paint({ ...frame, sh: frameRows }, 0)
  }

  append(frame: FrameRegion, addRows: number, skip: number, frameRows: number): void {
    const dst = this.rows
    this.rows += addRows
    this.ensureRows(this.rows)
    // 新規行(フレーム下端 addRows 行)だけを描く
    this.paint({ ...frame, sy: frame.sy + skip + frameRows - addRows, sh: addRows }, dst)
  }

  /** 全体を 1 枚の PNG にする。キャンバス上限を超える高さは複数パートに分ける */
  async toBlobs(maxRows = 30000): Promise<Blob[]> {
    const blobs: Blob[] = []
    for (let start = 0; start < this.rows; start += maxRows) {
      const h = Math.min(maxRows, this.rows - start)
      const out = new OffscreenCanvas(this.width, h)
      const ctx = out.getContext('2d')!
      for (let t = Math.floor(start / TILE_ROWS); t * TILE_ROWS < start + h; t++) {
        const tileTop = t * TILE_ROWS
        const y0 = Math.max(start, tileTop)
        const y1 = Math.min(start + h, tileTop + TILE_ROWS, this.rows)
        ctx.drawImage(this.tiles[t], 0, y0 - tileTop, this.width, y1 - y0, 0, y0 - start, this.width, y1 - y0)
      }
      blobs.push(await out.convertToBlob({ type: 'image/png' }))
    }
    return blobs
  }

  dispose() {
    this.tiles = []
    this.rows = 0
  }
}
