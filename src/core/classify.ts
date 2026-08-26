/**
 * フレーム分類(reference/rescue.py の classify / body_metric / darkness の移植)。
 * ここは純関数のみ。DOM / WebCodecs に依存しない。
 */
import { REGIONS, THRESHOLDS, bandRows, rectPixels, type RelBand } from './regions'

export type FrameCategory = 'list' | 'loading' | 'detail' | 'fullscreen_image'

export interface FrameMetrics {
  /** 本文領域の非白ピクセル率(rescue.py: bm) */
  bm: number
  /** 上下端の暗色ピクセル率(rescue.py: dk) */
  dk: number
  /** アバター領域の彩度ピクセル率(rescue.py: hd)。ヘッダー有無の判定に使う */
  hd: number
}

/**
 * グレースケール画像の抽象。フレーム全体を持たず、必要な行帯だけ取り出せる実装
 * (OffscreenCanvas からの部分 getImageData 等)を許すためのインターフェース。
 */
export interface GraySource {
  readonly width: number
  readonly height: number
  /** [rowStart, rowEnd) の行をグレー値(0–255)で返す。長さは width*(rowEnd-rowStart)。 */
  rows(rowStart: number, rowEnd: number): Uint8Array
}

/** グレー帯に加えて RGBA 矩形も取り出せるフレーム。ヘッダー判定(彩度)に必要。 */
export interface FrameSource extends GraySource {
  /** [colStart,colEnd) × [rowStart,rowEnd) の RGBA(4 byte/px、行優先)を返す。 */
  rgbaRect(colStart: number, colEnd: number, rowStart: number, rowEnd: number): Uint8Array | Uint8ClampedArray
}

/** フレーム全体のグレー配列を持つ GraySource(テストや Node 用)。 */
export function grayImage(gray: Uint8Array, width: number, height: number): GraySource {
  if (gray.length !== width * height) throw new Error('gray length mismatch')
  return {
    width,
    height,
    rows: (rowStart, rowEnd) => gray.subarray(rowStart * width, rowEnd * width),
  }
}

/** フレーム全体の RGBA 配列(getImageData / PNG 形式)から FrameSource を作る(テストや Node 用)。 */
export function rgbaImage(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): FrameSource {
  if (rgba.length !== width * height * 4) throw new Error('rgba length mismatch')
  const gray = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    gray[i] = (rgba[j] * 19595 + rgba[j + 1] * 38470 + rgba[j + 2] * 7471 + 0x8000) >> 16
  }
  return {
    width,
    height,
    rows: (rowStart, rowEnd) => gray.subarray(rowStart * width, rowEnd * width),
    rgbaRect(colStart, colEnd, rowStart, rowEnd) {
      const w = colEnd - colStart
      const out = new Uint8Array(w * (rowEnd - rowStart) * 4)
      for (let y = rowStart, o = 0; y < rowEnd; y++, o += w * 4) {
        out.set(rgba.subarray((y * width + colStart) * 4, (y * width + colEnd) * 4), o)
      }
      return out
    },
  }
}

/** 彩度画素か: HSV S > 0.2 と同値の整数判定 (max-min)*5 > max */
export function isSaturated(r: number, g: number, b: number): boolean {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  return (mx - mn) * THRESHOLDS.saturationScale > mx
}

function countBelow(px: Uint8Array, threshold: number): number {
  let c = 0
  for (let i = 0; i < px.length; i++) if (px[i] < threshold) c++
  return c
}

function bandPixels(src: GraySource, band: RelBand): Uint8Array {
  const { rowStart, rowEnd } = bandRows(src.height, band)
  return src.rows(rowStart, rowEnd)
}

/** rescue.py body_metric: 本文領域で p < 240 の割合 */
export function bodyMetric(src: GraySource): number {
  const px = bandPixels(src, REGIONS.body)
  return countBelow(px, THRESHOLDS.nonWhitePx) / px.length
}

/** rescue.py darkness: 上端+下端で p < 60 の割合(両帯を連結して 1 つの分母で割る) */
export function darkness(src: GraySource): number {
  const top = bandPixels(src, REGIONS.darkTop)
  const bot = bandPixels(src, REGIONS.darkBottom)
  return (countBelow(top, THRESHOLDS.darkPx) + countBelow(bot, THRESHOLDS.darkPx)) / (top.length + bot.length)
}

/** rescue.py header_metric: アバター領域の彩度画素率 */
export function headerMetric(src: FrameSource): number {
  const { colStart, colEnd, rowStart, rowEnd } = rectPixels(src.width, src.height, REGIONS.avatar)
  const px = src.rgbaRect(colStart, colEnd, rowStart, rowEnd)
  const n = px.length >> 2
  let sat = 0
  for (let j = 0; j < px.length; j += 4) if (isSaturated(px[j], px[j + 1], px[j + 2])) sat++
  return sat / n
}

export function computeMetrics(src: FrameSource): FrameMetrics {
  return { bm: bodyMetric(src), dk: darkness(src), hd: headerMetric(src) }
}

/** rescue.py classify の判定部分。比較の向き(> / <)と順序を変えない。 */
export function categorize(m: FrameMetrics): FrameCategory {
  if (m.dk > THRESHOLDS.fullscreenDark) return 'fullscreen_image'
  if (m.bm < THRESHOLDS.loading) return 'loading'
  if (m.bm < THRESHOLDS.list) return 'list'
  return 'detail'
}

/**
 * 境界シグナル(要件 F-3 / rescue.py boundary): 本文ブランク(loading)かつヘッダー有り。
 * 連続スクロールのページスワップ直後と、タップ方式のローディング画面の両方がこれに該当する。
 */
export function isBoundary(cat: FrameCategory, m: FrameMetrics): boolean {
  return cat === 'loading' && m.hd > THRESHOLDS.header
}

export interface ClassifiedMetrics extends FrameMetrics {
  cat: FrameCategory
  boundary: boolean
}

export function classifyFrame(src: FrameSource): ClassifiedMetrics {
  const m = computeMetrics(src)
  const cat = categorize(m)
  return { ...m, cat, boundary: isBoundary(cat, m) }
}
