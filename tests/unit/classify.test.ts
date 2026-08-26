import { describe, expect, it } from 'vitest'
import { categorize, classifyFrame, grayImage, rgbaImage, bodyMetric, darkness, headerMetric, isSaturated, isBoundary } from '../../src/core/classify'
import { REGIONS, THRESHOLDS, bandRows, rectPixels } from '../../src/core/regions'
import { rgbToGray, rgbaToGray } from '../../src/core/gray'

const W = 100
const H = 1000

/** グレー配列から白ベースの RGBA フレームを作る(R=G=B=gray) */
function rgbaFromGray(g: Uint8Array): Uint8Array {
  const out = new Uint8Array(g.length * 4)
  for (let i = 0; i < g.length; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g[i]
    out[i * 4 + 3] = 255
  }
  return out
}
const frame = (g: Uint8Array) => rgbaImage(rgbaFromGray(g), W, H)

/** 白地に、本文帯の先頭から nonWhite ピクセル分だけ値 v を置いた画像 */
function withBody(nonWhite: number, v = 0): Uint8Array {
  const g = new Uint8Array(W * H).fill(255)
  const { rowStart } = bandRows(H, REGIONS.body)
  for (let i = 0; i < nonWhite; i++) g[rowStart * W + i] = v
  return g
}

/** 上下端帯の先頭から dark ピクセル分だけ暗色を置いた画像 */
function withDark(dark: number, v = 0): Uint8Array {
  const g = new Uint8Array(W * H).fill(255)
  const top = bandRows(H, REGIONS.darkTop)
  const bot = bandRows(H, REGIONS.darkBottom)
  const topLen = (top.rowEnd - top.rowStart) * W
  for (let i = 0; i < dark; i++) {
    const idx = i < topLen ? top.rowStart * W + i : bot.rowStart * W + (i - topLen)
    g[idx] = v
  }
  return g
}

const bodyLen = () => {
  const { rowStart, rowEnd } = bandRows(H, REGIONS.body)
  return (rowEnd - rowStart) * W
}
const darkLen = () => {
  const t = bandRows(H, REGIONS.darkTop)
  const b = bandRows(H, REGIONS.darkBottom)
  return (t.rowEnd - t.rowStart + b.rowEnd - b.rowStart) * W
}

describe('regions (INV-4: rescue.py と同値)', () => {
  it('相対座標と閾値が参照実装と一致する', () => {
    expect(REGIONS.body).toEqual({ y0: 0.28, y1: 0.9 })
    expect(REGIONS.darkTop).toEqual({ y0: 0.1, y1: 0.16 })
    expect(REGIONS.darkBottom).toEqual({ y0: 0.92, y1: 0.98 })
    expect(REGIONS.avatar).toEqual({ x0: 0.06, x1: 0.15, y0: 0.145, y1: 0.19 })
    expect(THRESHOLDS).toEqual({ nonWhitePx: 240, darkPx: 60, loading: 0.02, list: 0.15, fullscreenDark: 0.5, saturationScale: 5, header: 0.15 })
  })
  it('行の切り出しは Python の int() と同じ切り捨て(1290x2796 の実機解像度)', () => {
    expect(bandRows(2796, REGIONS.body)).toEqual({ rowStart: 782, rowEnd: 2516 })
    expect(bandRows(2796, REGIONS.darkTop)).toEqual({ rowStart: 279, rowEnd: 447 })
    expect(bandRows(2796, REGIONS.darkBottom)).toEqual({ rowStart: 2572, rowEnd: 2740 })
  })
})

describe('gray (Pillow convert("L") と同一)', () => {
  it('整数式が Pillow と一致する', () => {
    // Pillow: L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16
    expect(rgbToGray(255, 255, 255)).toBe(255)
    expect(rgbToGray(0, 0, 0)).toBe(0)
    expect(rgbToGray(255, 0, 0)).toBe(76)
    expect(rgbToGray(0, 255, 0)).toBe(150)
    expect(rgbToGray(0, 0, 255)).toBe(29)
    expect(rgbToGray(240, 200, 210)).toBe(213)
    expect(rgbToGray(37, 201, 99)).toBe(140)
    expect(rgbToGray(130, 130, 130)).toBe(130)
  })
  it('RGBA 配列変換', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255])
    expect(Array.from(rgbaToGray(rgba))).toEqual([76, 0])
  })
})

describe('categorize: 閾値境界', () => {
  it('dk > 0.5 で fullscreen_image(0.5 ちょうどは非該当)', () => {
    expect(categorize({ bm: 0.9, dk: 0.5 })).toBe('detail')
    expect(categorize({ bm: 0.9, dk: 0.5000001 })).toBe('fullscreen_image')
    expect(categorize({ bm: 0.0, dk: 0.51 })).toBe('fullscreen_image') // 暗さ判定が最優先
  })
  it('bm < 0.02 で loading(0.02 ちょうどは list)', () => {
    expect(categorize({ bm: 0.0199, dk: 0 })).toBe('loading')
    expect(categorize({ bm: 0.02, dk: 0 })).toBe('list')
  })
  it('bm < 0.15 で list(0.15 ちょうどは detail)', () => {
    expect(categorize({ bm: 0.1499, dk: 0 })).toBe('list')
    expect(categorize({ bm: 0.15, dk: 0 })).toBe('detail')
  })
})

describe('bodyMetric / darkness: ピクセル閾値境界', () => {
  it('グレー値 239 は非白、240 は白として数える', () => {
    const n = 10
    expect(bodyMetric(grayImage(withBody(n, 239), W, H))).toBeCloseTo(n / bodyLen(), 12)
    expect(bodyMetric(grayImage(withBody(n, 240), W, H))).toBe(0)
  })
  it('グレー値 59 は暗色、60 は非暗色', () => {
    const n = 10
    expect(darkness(grayImage(withDark(n, 59), W, H))).toBeCloseTo(n / darkLen(), 12)
    expect(darkness(grayImage(withDark(n, 60), W, H))).toBe(0)
  })
  it('本文帯の外側のピクセルは bm に影響しない', () => {
    const g = new Uint8Array(W * H).fill(255)
    const { rowStart, rowEnd } = bandRows(H, REGIONS.body)
    g[(rowStart - 1) * W] = 0
    g[rowEnd * W] = 0
    expect(bodyMetric(grayImage(g, W, H))).toBe(0)
  })
  it('darkness は上下帯を連結した 1 つの分母で割る', () => {
    const t = bandRows(H, REGIONS.darkTop)
    const topLen = (t.rowEnd - t.rowStart) * W
    // 上帯を全部暗くしても全体の半分以下 → fullscreen ではない
    const g = withDark(topLen)
    expect(darkness(grayImage(g, W, H))).toBeCloseTo(topLen / darkLen(), 12)
    expect(classifyFrame(frame(g)).cat).not.toBe('fullscreen_image')
  })
})

describe('classifyFrame: 比率境界(ピクセル数で境界を作る)', () => {
  it('loading/list 境界', () => {
    const len = bodyLen()
    const just = Math.ceil(len * THRESHOLDS.loading) // bm >= 0.02
    expect(classifyFrame(frame(withBody(just))).cat).toBe('list')
    expect(classifyFrame(frame(withBody(just - 1))).cat).toBe('loading')
  })
  it('list/detail 境界', () => {
    const len = bodyLen()
    const just = Math.ceil(len * THRESHOLDS.list)
    expect(classifyFrame(frame(withBody(just))).cat).toBe('detail')
    expect(classifyFrame(frame(withBody(just - 1))).cat).toBe('list')
  })
  it('fullscreen 境界', () => {
    const len = darkLen()
    const half = len / 2 // len は偶数
    expect(classifyFrame(frame(withDark(half))).cat).not.toBe('fullscreen_image')
    expect(classifyFrame(frame(withDark(half + 1))).cat).toBe('fullscreen_image')
  })
})

describe('headerMetric / isBoundary: ヘッダー有無(要件 F-3)', () => {
  it('彩度画素の整数判定は HSV S > 0.2 と同値(境界: (max-min)*5 > max)', () => {
    expect(isSaturated(255, 255, 255)).toBe(false)
    expect(isSaturated(0, 0, 0)).toBe(false) // max=0 は非該当
    expect(isSaturated(100, 80, 80)).toBe(false) // S = 0.2 ちょうど → 非該当
    expect(isSaturated(100, 79, 79)).toBe(true) // S = 0.21
    expect(isSaturated(240, 200, 210)).toBe(false) // 淡いピンク S=0.167
    expect(isSaturated(240, 190, 210)).toBe(true) // S=0.208
  })
  it('アバター領域の彩度画素率が 0.15 を超えると境界、ちょうどは非該当', () => {
    const { colStart, colEnd, rowStart, rowEnd } = rectPixels(W, H, REGIONS.avatar)
    const n = (colEnd - colStart) * (rowEnd - rowStart)
    const build = (satCount: number) => {
      const rgba = rgbaFromGray(new Uint8Array(W * H).fill(255))
      let k = 0
      for (let y = rowStart; y < rowEnd && k < satCount; y++)
        for (let x = colStart; x < colEnd && k < satCount; x++, k++) {
          const o = (y * W + x) * 4
          rgba[o] = 240; rgba[o + 1] = 120; rgba[o + 2] = 160
        }
      return rgbaImage(rgba, W, H)
    }
    const exact = Math.round(n * THRESHOLDS.header) // n=9*45=405 → 60.75 → 61 で >0.15
    expect(n).toBe(405)
    const below = build(60)
    const above = build(61)
    expect(headerMetric(below)).toBeCloseTo(60 / 405, 12)
    expect(isBoundary('loading', { bm: 0, dk: 0, hd: headerMetric(below) })).toBe(false)
    expect(isBoundary('loading', { bm: 0, dk: 0, hd: headerMetric(above) })).toBe(true)
    expect(exact).toBe(61)
  })
  it('境界は loading のときだけ(list/detail/fullscreen はヘッダーがあっても境界でない)', () => {
    const m = { bm: 0.5, dk: 0, hd: 0.4 }
    expect(isBoundary('detail', m)).toBe(false)
    expect(isBoundary('list', m)).toBe(false)
    expect(isBoundary('fullscreen_image', m)).toBe(false)
    expect(isBoundary('loading', m)).toBe(true)
  })
  it('classifyFrame は boundary フラグを返す', () => {
    const blank = frame(new Uint8Array(W * H).fill(255))
    expect(classifyFrame(blank)).toMatchObject({ cat: 'loading', boundary: false, hd: 0 })
  })
  it('領域外の彩度画素は hd に影響しない', () => {
    const rgba = rgbaFromGray(new Uint8Array(W * H).fill(255))
    const { colStart, rowStart } = rectPixels(W, H, REGIONS.avatar)
    const o = ((rowStart - 1) * W + colStart) * 4
    rgba[o] = 255; rgba[o + 1] = 0; rgba[o + 2] = 0
    expect(headerMetric(rgbaImage(rgba, W, H))).toBe(0)
  })
})
