import { describe, expect, it } from 'vitest'
import { fft1d, fft2d, fft2dReal, fft2dRealHalf, getOptimalDFTSize, ifft2dHermitianHalf } from '../../src/core/fft'
import { createHanningWindow } from '../../src/core/phaseCorrelate'

function naive1d(re: number[], im: number[], inverse: boolean) {
  const n = re.length
  const oRe = new Array(n).fill(0)
  const oIm = new Array(n).fill(0)
  const sign = inverse ? 1 : -1
  for (let k = 0; k < n; k++)
    for (let t = 0; t < n; t++) {
      const a = (sign * 2 * Math.PI * k * t) / n
      oRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a)
      oIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a)
    }
  return { re: oRe, im: oIm }
}

describe('fft', () => {
  it('getOptimalDFTSize は OpenCV と同じ値', () => {
    expect(getOptimalDFTSize(1290)).toBe(1296)
    expect(getOptimalDFTSize(2642)).toBe(2700)
    expect(getOptimalDFTSize(1)).toBe(1)
    expect(getOptimalDFTSize(7)).toBe(8)
    expect(getOptimalDFTSize(2796)).toBe(2880)
  })
  for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 25, 27, 30, 45, 60, 100, 128, 135]) {
    it(`fft1d n=${n} は素朴 DFT と一致(forward/inverse)`, () => {
      const re = Array.from({ length: n }, (_, i) => Math.sin(i * 1.7) + i * 0.1)
      const im = Array.from({ length: n }, (_, i) => Math.cos(i * 0.9) - 0.3)
      for (const inv of [false, true]) {
        const oRe = new Float64Array(n)
        const oIm = new Float64Array(n)
        fft1d(Float64Array.from(re), Float64Array.from(im), oRe, oIm, n, inv)
        const ref = naive1d(re, im, inv)
        for (let k = 0; k < n; k++) {
          expect(oRe[k]).toBeCloseTo(ref.re[k], 8)
          expect(oIm[k]).toBeCloseTo(ref.im[k], 8)
        }
      }
    })
  }
  it('fft2d 6×10 は行→列の素朴 DFT と一致し、逆変換で元に戻る(×MN)', () => {
    const rows = 6
    const cols = 10
    const re = new Float64Array(rows * cols).map((_, i) => Math.sin(i * 0.37) * 10)
    const im = new Float64Array(rows * cols)
    const f = fft2d(re, im, rows, cols, false)
    // 素朴 2D
    for (let ky = 0; ky < rows; ky++)
      for (let kx = 0; kx < cols; kx++) {
        let sRe = 0
        let sIm = 0
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < cols; x++) {
            const a = -2 * Math.PI * ((ky * y) / rows + (kx * x) / cols)
            sRe += re[y * cols + x] * Math.cos(a)
            sIm += re[y * cols + x] * Math.sin(a)
          }
        expect(f.re[ky * cols + kx]).toBeCloseTo(sRe, 7)
        expect(f.im[ky * cols + kx]).toBeCloseTo(sIm, 7)
      }
    const back = fft2d(f.re, f.im, rows, cols, true)
    for (let i = 0; i < re.length; i++) expect(back.re[i] / (rows * cols)).toBeCloseTo(re[i], 8)
  })
})

describe('fft2dReal', () => {
  for (const [rows, cols] of [[6, 10], [5, 12], [7, 9], [4, 4]]) {
    it(`${rows}×${cols}: 実数入力の変換が fft2d と一致(奇数行数も)`, () => {
      const re = new Float64Array(rows * cols).map((_, i) => Math.sin(i * 0.37) * 10 + (i % 7))
      const a = fft2d(re, new Float64Array(rows * cols), rows, cols, false)
      const b = fft2dReal(re, rows, cols)
      for (let i = 0; i < re.length; i++) {
        expect(b.re[i]).toBeCloseTo(a.re[i], 8)
        expect(b.im[i]).toBeCloseTo(a.im[i], 8)
      }
    })
  }
})

describe('半スペクトル(Hermitian)', () => {
  for (const [rows, cols] of [[6, 10], [5, 12], [7, 9], [4, 4], [8, 6]]) {
    it(`${rows}×${cols}: fft2dRealHalf は列 0..N/2 で fft2d と一致し、P/|P| の逆変換が全複素版と一致`, () => {
      const a = new Float64Array(rows * cols).map((_, i) => Math.sin(i * 0.37) * 10 + (i % 7))
      const b = new Float64Array(rows * cols).map((_, i) => Math.cos(i * 0.53) * 9 + (i % 5))
      const FA = fft2d(a, new Float64Array(rows * cols), rows, cols, false)
      const HA = fft2dRealHalf(a, rows, cols)
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < HA.halfCols; x++) {
          expect(HA.re[y * HA.halfCols + x]).toBeCloseTo(FA.re[y * cols + x], 8)
          expect(HA.im[y * HA.halfCols + x]).toBeCloseTo(FA.im[y * cols + x], 8)
        }
      // 位相相関の C = FA·conj(FB)/|·| を全複素で逆変換した実部と、半スペクトル逆変換を比較
      const FB = fft2d(b, new Float64Array(rows * cols), rows, cols, false)
      const HB = fft2dRealHalf(b, rows, cols)
      const n = rows * cols
      const cRe = new Float64Array(n)
      const cIm = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const re = FA.re[i] * FB.re[i] + FA.im[i] * FB.im[i]
        const im = FA.im[i] * FB.re[i] - FA.re[i] * FB.im[i]
        const mag = Math.hypot(re, im)
        if (mag > 0) {
          cRe[i] = re / mag
          cIm[i] = im / mag
        }
      }
      const full = fft2d(cRe, cIm, rows, cols, true)
      const hRe = new Float64Array(rows * HA.halfCols)
      const hIm = new Float64Array(rows * HA.halfCols)
      for (let i = 0; i < hRe.length; i++) {
        const re = HA.re[i] * HB.re[i] + HA.im[i] * HB.im[i]
        const im = HA.im[i] * HB.re[i] - HA.re[i] * HB.im[i]
        const mag = Math.hypot(re, im)
        if (mag > 0) {
          hRe[i] = re / mag
          hIm[i] = im / mag
        }
      }
      const half = ifft2dHermitianHalf({ rows, cols, halfCols: HA.halfCols, re: hRe, im: hIm })
      for (let i = 0; i < n; i++) expect(half[i]).toBeCloseTo(full.re[i], 7)
    })
  }
})

describe('createHanningWindow', () => {
  it('cv2.createHanningWindow((1290, 2642), CV_64F) と一致(和・中心値、√(wr·wc))', () => {
    const w = createHanningWindow(2642, 1290)
    let sum = 0
    for (let i = 0; i < w.length; i++) sum += w[i]
    expect(sum).toBeCloseTo(1379689.3067237225, 3)
    expect(w[1321 * 1290 + 645]).toBeCloseTo(0.9999990806098159, 12)
    expect(w[0]).toBe(0)
  })
})
