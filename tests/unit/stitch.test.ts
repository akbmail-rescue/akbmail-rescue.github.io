import { describe, expect, it } from 'vitest'
import { ArrayCompositor, downscaleGray, estimateFixedRows, roundHalfEven, FIXED_ROWS_MAX_RATIO } from '../../src/core/stitch'

describe('stitch helpers', () => {
  it('roundHalfEven は Python の round() と同じ', () => {
    expect(roundHalfEven(2.5)).toBe(2)
    expect(roundHalfEven(3.5)).toBe(4)
    expect(roundHalfEven(2.4999)).toBe(2)
    expect(roundHalfEven(2.5001)).toBe(3)
    expect(roundHalfEven(-0.5) === 0).toBe(true)
    expect(roundHalfEven(275.9989)).toBe(276)
  })
  it('estimateFixedRows: 上端から差分の無い行数を返し、上限で打ち切る', () => {
    const w = 10
    const h = 200
    const a = new Uint8Array(w * h).fill(200)
    const b = new Uint8Array(w * h).fill(200)
    // 30 行目から内容が違う
    for (let y = 30; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = 50
    expect(estimateFixedRows(a, b, w, h)).toBe(30)
    // 差分がわずか(平均 <1)なら固定扱い
    b[30 * w] = 200 + 5 // 1 画素だけ 5 違う → 行平均 0.5
    for (let x = 1; x < w; x++) b[30 * w + x] = 200
    expect(estimateFixedRows(a, b, w, h)).toBe(31)
    // 全行同じなら上限
    expect(estimateFixedRows(a, a, w, h)).toBe(Math.trunc(h * FIXED_ROWS_MAX_RATIO))
    expect(estimateFixedRows(a, b, w, h)).toBeLessThanOrEqual(Math.trunc(h * FIXED_ROWS_MAX_RATIO))
  })
  it('downscaleGray は cv2 INTER_AREA(2×2 平均・四捨五入)と一致し、奇数サイズは切り詰める', () => {
    const src = Uint8Array.from([1, 2, 9, 3, 4, 9, 0, 0, 9]) // 3×3 → 有効 2×2 = [[1,2],[3,4]]
    const out = new Float64Array(1)
    expect(downscaleGray(src, 3, 3, 2, out)).toEqual({ w: 1, h: 1 })
    expect(out[0]).toBe(3) // 10/4 = 2.5 → 3
    const cases: Array<[number[], number]> = [[[1, 2, 3, 5], 3], [[1, 1, 2, 3], 2], [[0, 1, 1, 1], 1], [[0, 0, 1, 0], 0]]
    for (const [px, expected] of cases) {
      downscaleGray(Uint8Array.from(px), 2, 2, 2, out)
      expect(out[0]).toBe(expected)
    }
  })
  it('ArrayCompositor: append は skip 行を飛ばして下端に描き、高さが伸びる', () => {
    const w = 2
    const comp = new ArrayCompositor(w, 1)
    const f1 = Uint8Array.from([1, 1, 2, 2, 3, 3]) // 3 行(1ch)
    comp.init(f1, 3)
    expect(comp.height).toBe(3)
    const f2 = Uint8Array.from([9, 9, 4, 4, 5, 5]) // 先頭行は固定ヘッダー(skip=1)
    comp.append(f2, 2, 1, 2)
    expect(comp.height).toBe(5)
    const rgb = comp.toRGB()
    const row = (y: number) => rgb[y * w * 3]
    expect([row(0), row(1), row(2), row(3), row(4)]).toEqual([1, 2, 3, 4, 5])
  })
})
