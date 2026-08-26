/**
 * cv2.phaseCorrelate / cv2.createHanningWindow の移植(OpenCV modules/imgproc/src/phasecorr.cpp)。
 *
 * 手順(OpenCV と同じ):
 *  1. M = getOptimalDFTSize(rows), N = getOptimalDFTSize(cols) にゼロ詰め
 *  2. 窓(Hanning)を掛ける(窓も同じくゼロ詰め)
 *  3. F1, F2 = dft、P = F1 · conj(F2)、C = P / |P|
 *  4. 非スケールの idft(実部)→ fftShift
 *  5. 最大位置 → 5×5 の重み付き重心 t、response = 5×5 の和 / (M·N)
 *  6. 返す変位 = center − t、center = (N/2, M/2)
 */
import { fft2dRealHalf, getOptimalDFTSize, ifft2dHermitianHalf, type HalfSpectrum } from './fft'

/** 窓掛け・ゼロ詰め後の実数画像の半スペクトル(列 0..N/2) */
export type Spectrum = HalfSpectrum

export interface PhaseCorrelateResult {
  dx: number
  dy: number
  response: number
}

/**
 * cv2.createHanningWindow((cols, rows)) と同じ値(double)。
 * OpenCV は wr·wc を計算した後に cv::sqrt(dst, dst) を掛けるため、実際の窓は √(wr·wc)。
 */
export function createHanningWindow(rows: number, cols: number): Float64Array {
  const w = new Float64Array(rows * cols)
  const coeff0 = (2.0 * Math.PI) / (cols - 1)
  const coeff1 = (2.0 * Math.PI) / (rows - 1)
  for (let i = 0; i < rows; i++) {
    const wr = 0.5 * (1.0 - Math.cos(coeff1 * i))
    for (let j = 0; j < cols; j++) {
      const wc = 0.5 * (1.0 - Math.cos(coeff0 * j))
      w[i * cols + j] = Math.sqrt(wr * wc)
    }
  }
  return w
}

/**
 * 画像(rows×cols の double)に窓を掛けてゼロ詰めし、forward DFT した結果。
 * 連続フレームでは前フレームのスペクトルを使い回せるよう分離している。
 */
export function forwardSpectrum(img: Float64Array, rows: number, cols: number, window: Float64Array | null): Spectrum {
  const M = getOptimalDFTSize(rows)
  const N = getOptimalDFTSize(cols)
  const re = new Float64Array(M * N)
  for (let y = 0; y < rows; y++) {
    const src = y * cols
    const dst = y * N
    if (window) for (let x = 0; x < cols; x++) re[dst + x] = img[src + x] * window[src + x]
    else for (let x = 0; x < cols; x++) re[dst + x] = img[src + x]
  }
  return fft2dRealHalf(re, M, N)
}

/**
 * OpenCV weightedCentroid: peak を中心に 5×5(画像端はクランプ)の重み付き重心。
 */
function weightedCentroid(c: Float64Array, rows: number, cols: number, peakX: number, peakY: number): { x: number; y: number; sum: number } {
  let minr = peakY - 2
  let maxr = peakY + 2
  let minc = peakX - 2
  let maxc = peakX + 2
  if (minr < 0) minr = 0
  if (minc < 0) minc = 0
  if (maxr > rows - 1) maxr = rows - 1
  if (maxc > cols - 1) maxc = cols - 1
  let cx = 0
  let cy = 0
  let sum = 0
  for (let y = minr; y <= maxr; y++) {
    for (let x = minc; x <= maxc; x++) {
      const v = c[y * cols + x]
      cx += x * v
      cy += y * v
      sum += v
    }
  }
  const denom = sum + Number.EPSILON
  return { x: cx / denom, y: cy / denom, sum }
}

/**
 * 2 つのスペクトル(同サイズ)から位相相関を計算する。
 * 戻り値は cv2.phaseCorrelate(src1, src2) と同じ意味: src1 → src2 の変位(center − peak)。
 */
export function phaseCorrelateSpectra(f1: Spectrum, f2: Spectrum): PhaseCorrelateResult {
  const M = f1.rows
  const N = f1.cols
  const n = M * N
  const half = f1.halfCols
  const pRe = new Float64Array(M * half)
  const pIm = new Float64Array(M * half)
  // P = F1 · conj(F2)、C = P / |P|(半スペクトル上で。残りは Hermitian 対称)
  for (let i = 0; i < pRe.length; i++) {
    const re = f1.re[i] * f2.re[i] + f1.im[i] * f2.im[i]
    const im = f1.im[i] * f2.re[i] - f1.re[i] * f2.im[i]
    const mag = Math.sqrt(re * re + im * im)
    if (mag > 0) {
      pRe[i] = re / mag
      pIm[i] = im / mag
    }
  }
  const invRe = ifft2dHermitianHalf({ rows: M, cols: N, halfCols: half, re: pRe, im: pIm })
  // fftShift(奇数サイズは OpenCV と同じく ceil(n/2) だけ巡回シフト)
  const sy = Math.ceil(M / 2)
  const sx = Math.ceil(N / 2)
  const c = new Float64Array(n)
  for (let y = 0; y < M; y++) {
    const yy = (y + sy) % M
    for (let x = 0; x < N; x++) {
      const xx = (x + sx) % N
      c[y * N + x] = invRe[yy * N + xx]
    }
  }
  // minMaxLoc: 走査順で最初の最大
  let best = -Infinity
  let px = 0
  let py = 0
  for (let y = 0; y < M; y++) {
    for (let x = 0; x < N; x++) {
      const v = c[y * N + x]
      if (v > best) {
        best = v
        px = x
        py = y
      }
    }
  }
  const t = weightedCentroid(c, M, N, px, py)
  return { dx: N / 2.0 - t.x, dy: M / 2.0 - t.y, response: t.sum / (M * N) }
}

/** cv2.phaseCorrelate(src1, src2, window) 相当の一発呼び出し。 */
export function phaseCorrelate(src1: Float64Array, src2: Float64Array, rows: number, cols: number, window: Float64Array | null): PhaseCorrelateResult {
  return phaseCorrelateSpectra(forwardSpectrum(src1, rows, cols, window), forwardSpectrum(src2, rows, cols, window))
}
