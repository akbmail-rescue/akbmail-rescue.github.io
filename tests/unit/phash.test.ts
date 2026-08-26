import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resizeGray } from '../../src/core/resample'
import { dct2, hammingDistance, median, phashFrom32, phashFromGray, phashFromHex, phashToHex } from '../../src/core/phash'

interface Fixture {
  resample: Array<{ w: number; h: number; ow: number; oh: number; input: number[] | null; bicubic: number[]; lanczos: number[]; phash256: string; phash_direct: string }>
  dct: { input: number[]; low8: number[]; median: number }
}
const fx: Fixture = JSON.parse(readFileSync(join(__dirname, '../fixtures/phash_small.json'), 'utf8'))

describe('resizeGray: Pillow Image.resize とビット一致', () => {
  for (const c of fx.resample.filter((c) => c.input)) {
    it(`${c.w}x${c.h} → ${c.ow}x${c.oh} bicubic / lanczos`, () => {
      const src = Uint8Array.from(c.input!)
      expect(Array.from(resizeGray(src, c.w, c.h, c.ow, c.oh, 'bicubic'))).toEqual(c.bicubic)
      expect(Array.from(resizeGray(src, c.w, c.h, c.ow, c.oh, 'lanczos'))).toEqual(c.lanczos)
    })
  }
  it('同サイズはコピーを返す', () => {
    const src = Uint8Array.from([1, 2, 3, 4])
    expect(Array.from(resizeGray(src, 2, 2, 2, 2, 'bicubic'))).toEqual([1, 2, 3, 4])
  })
})

describe('dct2 / median: scipy.fftpack.dct(type II) と numpy.median', () => {
  it('低周波 8×8 が一致(相対誤差 1e-9)', () => {
    const d = dct2(Uint8Array.from(fx.dct.input), 32)
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const ref = fx.dct.low8[r * 8 + c]
        expect(Math.abs(d[r * 32 + c] - ref)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ref)))
      }
    const low = new Float64Array(64)
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) low[r * 8 + c] = d[r * 32 + c]
    expect(median(low)).toBeCloseTo(fx.dct.median, 6)
  })
  it('median: 奇数個は中央、偶数個は中央 2 値の平均', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})

describe('phash: imagehash.phash とビット一致', () => {
  for (const c of fx.resample.filter((c) => c.input)) {
    it(`${c.w}x${c.h}: resize(256) 経由 / 直接`, () => {
      const src = Uint8Array.from(c.input!)
      expect(phashToHex(phashFromGray(src, c.w, c.h))).toBe(c.phash256)
      // 直接 32×32 に LANCZOS(imagehash が内部でやる処理)
      const g32 = resizeGray(src, c.w, c.h, 32, 32, 'lanczos')
      expect(phashToHex(phashFrom32(g32))).toBe(c.phash_direct)
    })
  }
  it('hex 変換の往復とハミング距離', () => {
    const a = phashFromHex('b2c54e30e76eb063')
    expect(phashToHex(a)).toBe('b2c54e30e76eb063')
    expect(hammingDistance(a, a)).toBe(0)
    expect(hammingDistance(a, a ^ 0b1011n)).toBe(3)
    expect(hammingDistance(0n, 0xffffffffffffffffn)).toBe(64)
    expect(phashToHex(0n)).toBe('0000000000000000')
  })
})
