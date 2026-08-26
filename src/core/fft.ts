/**
 * 自前の複素 FFT(混合基数、任意長)。OpenCV の dft と同じ「正規化なし」の定義:
 *   forward:  X_k = Σ x_n e^{-2πi kn/N}
 *   inverse:  x_n = Σ X_k e^{+2πi kn/N}   (1/N は掛けない)
 * cv2.phaseCorrelate の移植に使う。サイズは getOptimalDFTSize で 2^a·3^b·5^c に揃えるので、
 * 小さな素因数のみを想定するが、任意の n でも動く(大きな素因数では O(n·p))。
 *
 * 実装: Stockham 自動整列(周波数間引き)。段ごとに基数 p で分割し、
 *   b_k = Σ_r a_r W_p^{rk},  y[q + s(pj + k)] = b_k · W_n^{jk}
 * をピンポンバッファで繰り返す。再帰・ビット反転なしで出力は自然順。
 * 実数入力の 2D 変換は 2 行を 1 つの複素列に詰めて行方向の変換回数を半分にする(結果は同一)。
 */

/** OpenCV getOptimalDFTSize: size 以上で最小の 2^a·3^b·5^c */
export function getOptimalDFTSize(size: number): number {
  if (size <= 1) return 1
  let best = Infinity
  for (let a = 1; a < size * 2; a *= 2) {
    if (a >= best) break
    for (let b = a; b < size * 2; b *= 3) {
      if (b >= best) break
      for (let c = b; c < size * 2; c *= 5) {
        if (c >= size) {
          if (c < best) best = c
          break
        }
      }
    }
  }
  return best
}

interface Stage {
  /** この段で分割する長さ n(段を進めるごとに p で割られる) */
  n: number
  p: number
  m: number
  /** ブロック数 s(段を進めるごとに p 倍) */
  s: number
  /** W_n^{t}(t = 0..n-1)。forward 用の符号(−)で保持し、inverse では虚部の符号を反転して使う */
  twCos: Float64Array
  twSin: Float64Array
  pCos: Float64Array
  pSin: Float64Array
}

interface Plan {
  n: number
  stages: Stage[]
  /** ピンポン用作業領域 */
  bufRe: Float64Array
  bufIm: Float64Array
  outRe: Float64Array
  outIm: Float64Array
  aRe: Float64Array
  aIm: Float64Array
  bRe: Float64Array
  bIm: Float64Array
}

const plans = new Map<number, Plan>()

function factorize(n: number): number[] {
  const f: number[] = []
  let m = n
  for (const p of [2, 3, 5]) while (m % p === 0) { f.push(p); m /= p }
  for (let p = 7; p * p <= m; p += 2) while (m % p === 0) { f.push(p); m /= p }
  if (m > 1) f.push(m)
  return f
}

function getPlan(n: number): Plan {
  let plan = plans.get(n)
  if (plan) return plan
  const stages: Stage[] = []
  let cur = n
  let s = 1
  let maxP = 1
  for (const p of factorize(n)) {
    const twCos = new Float64Array(cur)
    const twSin = new Float64Array(cur)
    for (let t = 0; t < cur; t++) {
      twCos[t] = Math.cos((2 * Math.PI * t) / cur)
      twSin[t] = -Math.sin((2 * Math.PI * t) / cur)
    }
    const pCos = new Float64Array(p)
    const pSin = new Float64Array(p)
    for (let t = 0; t < p; t++) {
      pCos[t] = Math.cos((2 * Math.PI * t) / p)
      pSin[t] = -Math.sin((2 * Math.PI * t) / p)
    }
    stages.push({ n: cur, p, m: cur / p, s, twCos, twSin, pCos, pSin })
    if (p > maxP) maxP = p
    s *= p
    cur /= p
  }
  plan = {
    n,
    stages,
    bufRe: new Float64Array(n),
    bufIm: new Float64Array(n),
    outRe: new Float64Array(n),
    outIm: new Float64Array(n),
    aRe: new Float64Array(maxP),
    aIm: new Float64Array(maxP),
    bRe: new Float64Array(maxP),
    bIm: new Float64Array(maxP),
  }
  plans.set(n, plan)
  return plan
}

/**
 * 長さ n の変換。inRe/inIm(連続 n 個)を outRe/outIm(連続 n 個)へ。
 * 入力配列は破壊しない。sign = -1 が forward、+1 が inverse。
 */
function transform(plan: Plan, inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array, sign: number): void {
  const n = plan.n
  if (n === 1) {
    outRe[0] = inRe[0]
    outIm[0] = inIm[0]
    return
  }
  const stages = plan.stages
  let xRe = inRe
  let xIm = inIm
  let yRe = stages.length % 2 === 1 ? outRe : plan.bufRe
  let yIm = stages.length % 2 === 1 ? outIm : plan.bufIm
  const aRe = plan.aRe
  const aIm = plan.aIm
  const bRe = plan.bRe
  const bIm = plan.bIm
  for (let si = 0; si < stages.length; si++) {
    const st = stages[si]
    const { p, m, s } = st
    const twCos = st.twCos
    const twSin = st.twSin
    const pCos = st.pCos
    const pSin = st.pSin
    if (p === 2) {
      for (let j = 0; j < m; j++) {
        const wc = twCos[j]
        const ws = sign * -twSin[j] // twSin は forward(−sin)で保持
        const o0 = s * j
        const o1 = s * (j + m)
        const d0 = s * 2 * j
        const d1 = s * (2 * j + 1)
        for (let q = 0; q < s; q++) {
          const ar = xRe[q + o0]
          const ai = xIm[q + o0]
          const br = xRe[q + o1]
          const bi = xIm[q + o1]
          yRe[q + d0] = ar + br
          yIm[q + d0] = ai + bi
          const dr = ar - br
          const di = ai - bi
          yRe[q + d1] = dr * wc - di * ws
          yIm[q + d1] = dr * ws + di * wc
        }
      }
    } else if (p === 3) {
      // W3 = cos(2π/3) − i·sign·sin(2π/3) を閉形式で
      const c3 = -0.5
      const s3 = sign * Math.sin((2 * Math.PI) / 3) // W3 の虚部: forward −√3/2, inverse +√3/2
      for (let j = 0; j < m; j++) {
        const w1c = twCos[j]
        const w1s = sign * -twSin[j]
        const w2c = twCos[2 * j]
        const w2s = sign * -twSin[2 * j]
        const o0 = s * j
        const o1 = s * (j + m)
        const o2 = s * (j + 2 * m)
        const d0 = s * 3 * j
        const d1 = s * (3 * j + 1)
        const d2 = s * (3 * j + 2)
        for (let q = 0; q < s; q++) {
          const a0r = xRe[q + o0]
          const a0i = xIm[q + o0]
          const a1r = xRe[q + o1]
          const a1i = xIm[q + o1]
          const a2r = xRe[q + o2]
          const a2i = xIm[q + o2]
          const t1r = a1r + a2r
          const t1i = a1i + a2i
          const t2r = a0r + c3 * t1r
          const t2i = a0i + c3 * t1i
          // i·s3·(a1 − a2)
          const ur = -s3 * (a1i - a2i)
          const ui = s3 * (a1r - a2r)
          yRe[q + d0] = a0r + t1r
          yIm[q + d0] = a0i + t1i
          const b1r = t2r + ur
          const b1i = t2i + ui
          const b2r = t2r - ur
          const b2i = t2i - ui
          yRe[q + d1] = b1r * w1c - b1i * w1s
          yIm[q + d1] = b1r * w1s + b1i * w1c
          yRe[q + d2] = b2r * w2c - b2i * w2s
          yIm[q + d2] = b2r * w2s + b2i * w2c
        }
      }
    } else if (p === 5) {
      const c1 = Math.cos((2 * Math.PI) / 5)
      const c2 = Math.cos((4 * Math.PI) / 5)
      const s1 = sign * Math.sin((2 * Math.PI) / 5)
      const s2 = sign * Math.sin((4 * Math.PI) / 5)
      for (let j = 0; j < m; j++) {
        const o = [s * j, s * (j + m), s * (j + 2 * m), s * (j + 3 * m), s * (j + 4 * m)]
        const d = [s * 5 * j, s * (5 * j + 1), s * (5 * j + 2), s * (5 * j + 3), s * (5 * j + 4)]
        const w1c = twCos[j], w1s = sign * -twSin[j]
        const w2c = twCos[2 * j], w2s = sign * -twSin[2 * j]
        const w3c = twCos[3 * j], w3s = sign * -twSin[3 * j]
        const w4c = twCos[4 * j], w4s = sign * -twSin[4 * j]
        for (let q = 0; q < s; q++) {
          const a0r = xRe[q + o[0]], a0i = xIm[q + o[0]]
          const a1r = xRe[q + o[1]], a1i = xIm[q + o[1]]
          const a2r = xRe[q + o[2]], a2i = xIm[q + o[2]]
          const a3r = xRe[q + o[3]], a3i = xIm[q + o[3]]
          const a4r = xRe[q + o[4]], a4i = xIm[q + o[4]]
          const t1r = a1r + a4r, t1i = a1i + a4i
          const t2r = a2r + a3r, t2i = a2i + a3i
          const t3r = a1r - a4r, t3i = a1i - a4i
          const t4r = a2r - a3r, t4i = a2i - a3i
          const m1r = a0r + c1 * t1r + c2 * t2r, m1i = a0i + c1 * t1i + c2 * t2i
          const m2r = a0r + c2 * t1r + c1 * t2r, m2i = a0i + c2 * t1i + c1 * t2i
          // u1 = s1·t3 + s2·t4, u2 = s2·t3 − s1·t4(s は方向の符号込み、i·u を足し引き)
          const u1r = s1 * t3r + s2 * t4r, u1i = s1 * t3i + s2 * t4i
          const u2r = s2 * t3r - s1 * t4r, u2i = s2 * t3i - s1 * t4i
          yRe[q + d[0]] = a0r + t1r + t2r
          yIm[q + d[0]] = a0i + t1i + t2i
          // b1 = m1 + i·u1, b4 = m1 − i·u1, b2 = m2 + i·u2, b3 = m2 − i·u2
          const b1r = m1r - u1i, b1i = m1i + u1r
          const b4r = m1r + u1i, b4i = m1i - u1r
          const b2r = m2r - u2i, b2i = m2i + u2r
          const b3r = m2r + u2i, b3i = m2i - u2r
          yRe[q + d[1]] = b1r * w1c - b1i * w1s
          yIm[q + d[1]] = b1r * w1s + b1i * w1c
          yRe[q + d[2]] = b2r * w2c - b2i * w2s
          yIm[q + d[2]] = b2r * w2s + b2i * w2c
          yRe[q + d[3]] = b3r * w3c - b3i * w3s
          yIm[q + d[3]] = b3r * w3s + b3i * w3c
          yRe[q + d[4]] = b4r * w4c - b4i * w4s
          yIm[q + d[4]] = b4r * w4s + b4i * w4c
        }
      }
    } else {
      for (let j = 0; j < m; j++) {
        for (let q = 0; q < s; q++) {
          for (let r = 0; r < p; r++) {
            aRe[r] = xRe[q + s * (j + m * r)]
            aIm[r] = xIm[q + s * (j + m * r)]
          }
          for (let k = 0; k < p; k++) {
            let sr = 0
            let si2 = 0
            let t = 0
            for (let r = 0; r < p; r++) {
              const c = pCos[t]
              const sn = sign * -pSin[t]
              sr += aRe[r] * c - aIm[r] * sn
              si2 += aRe[r] * sn + aIm[r] * c
              t += k
              if (t >= p) t -= p
            }
            bRe[k] = sr
            bIm[k] = si2
          }
          for (let k = 0; k < p; k++) {
            const t = j * k // < n
            const c = twCos[t]
            const sn = sign * -twSin[t]
            const d = q + s * (p * j + k)
            yRe[d] = bRe[k] * c - bIm[k] * sn
            yIm[d] = bRe[k] * sn + bIm[k] * c
          }
        }
      }
    }
    // 次段: y → x。最終段の出力が outRe に来るようにピンポンを組む
    xRe = yRe
    xIm = yIm
    if (si + 1 < stages.length) {
      const remaining = stages.length - (si + 1)
      if (remaining % 2 === 1) {
        yRe = outRe
        yIm = outIm
      } else {
        yRe = xRe === plan.bufRe ? plan.outRe : plan.bufRe
        yIm = xIm === plan.bufIm ? plan.outIm : plan.bufIm
      }
    }
  }
}

/** 1 次元変換(out-of-place)。 */
export function fft1d(inRe: Float64Array, inIm: Float64Array, outRe: Float64Array, outIm: Float64Array, n: number, inverse: boolean): void {
  transform(getPlan(n), inRe, inIm, outRe, outIm, inverse ? 1 : -1)
}

/**
 * 2 次元変換(rows × cols、行優先)。入力を破壊せず新しい配列を返す。
 * 行方向 → 列方向の順(分離可能なので順序は結果に影響しない)。
 */
export function fft2d(re: Float64Array, im: Float64Array, rows: number, cols: number, inverse: boolean): { re: Float64Array; im: Float64Array } {
  const outRe = new Float64Array(rows * cols)
  const outIm = new Float64Array(rows * cols)
  const sign = inverse ? 1 : -1
  const rowPlan = getPlan(cols)
  const lineRe = new Float64Array(cols)
  const lineIm = new Float64Array(cols)
  const resRe = new Float64Array(cols)
  const resIm = new Float64Array(cols)
  for (let y = 0; y < rows; y++) {
    const o = y * cols
    lineRe.set(re.subarray(o, o + cols))
    lineIm.set(im.subarray(o, o + cols))
    transform(rowPlan, lineRe, lineIm, resRe, resIm, sign)
    outRe.set(resRe, o)
    outIm.set(resIm, o)
  }
  columnPass(outRe, outIm, rows, cols, sign)
  return { re: outRe, im: outIm }
}

function columnPass(outRe: Float64Array, outIm: Float64Array, rows: number, cols: number, sign: number) {
  const colPlan = getPlan(rows)
  const lineRe = new Float64Array(rows)
  const lineIm = new Float64Array(rows)
  const resRe = new Float64Array(rows)
  const resIm = new Float64Array(rows)
  for (let x = 0; x < cols; x++) {
    for (let y = 0, i = x; y < rows; y++, i += cols) {
      lineRe[y] = outRe[i]
      lineIm[y] = outIm[i]
    }
    transform(colPlan, lineRe, lineIm, resRe, resIm, sign)
    for (let y = 0, i = x; y < rows; y++, i += cols) {
      outRe[i] = resRe[y]
      outIm[i] = resIm[y]
    }
  }
}

/**
 * 実数入力の 2D forward 変換。2 行 a, b を z = a + i·b として 1 回の複素変換で処理し、
 *   A[k] = (Z[k] + conj(Z[N-k])) / 2,  B[k] = (Z[k] − conj(Z[N-k])) / (2i)
 * で分離する。結果は fft2d(re, 0) と同じ(丸め誤差の範囲で)。
 */
export function fft2dReal(re: Float64Array, rows: number, cols: number): { re: Float64Array; im: Float64Array } {
  const outRe = new Float64Array(rows * cols)
  const outIm = new Float64Array(rows * cols)
  const rowPlan = getPlan(cols)
  const zRe = new Float64Array(cols)
  const zIm = new Float64Array(cols)
  const wRe = new Float64Array(cols)
  const wIm = new Float64Array(cols)
  for (let y = 0; y < rows; y += 2) {
    const a = y * cols
    if (y + 1 < rows) {
      const b = (y + 1) * cols
      zRe.set(re.subarray(a, a + cols))
      zIm.set(re.subarray(b, b + cols))
      transform(rowPlan, zRe, zIm, wRe, wIm, -1)
      for (let k = 0; k < cols; k++) {
        const nk = k === 0 ? 0 : cols - k
        const zr = wRe[k]
        const zi = wIm[k]
        const cr = wRe[nk] // conj(Z[N-k]) = (cr, -ci)
        const ci = -wIm[nk]
        outRe[a + k] = (zr + cr) / 2
        outIm[a + k] = (zi + ci) / 2
        // (Z − conj(Z[N−k])) / (2i) = ((zi − ci) − i(zr − cr)) / 2
        outRe[b + k] = (zi - ci) / 2
        outIm[b + k] = -(zr - cr) / 2
      }
    } else {
      zRe.set(re.subarray(a, a + cols))
      zIm.fill(0)
      transform(rowPlan, zRe, zIm, wRe, wIm, -1)
      outRe.set(wRe, a)
      outIm.set(wIm, a)
    }
  }
  columnPass(outRe, outIm, rows, cols, -1)
  return { re: outRe, im: outIm }
}

/** 実数入力の 2D forward 変換のうち、列 0..N/2 だけを持つ半スペクトル(Hermitian 対称性で残りは導ける) */
export interface HalfSpectrum {
  rows: number
  cols: number
  /** = floor(cols/2) + 1 */
  halfCols: number
  re: Float64Array
  im: Float64Array
}

/**
 * 実数入力の 2D forward 変換(半スペクトル)。行は 2 行ペア詰めで変換し、列変換は 0..N/2 の列だけ行う。
 * 結果は fft2dReal(re) の列 0..N/2 と同じ(丸め誤差の範囲で)。
 */
export function fft2dRealHalf(re: Float64Array, rows: number, cols: number): HalfSpectrum {
  const half = (cols >> 1) + 1
  const hRe = new Float64Array(rows * half)
  const hIm = new Float64Array(rows * half)
  const rowPlan = getPlan(cols)
  const zRe = new Float64Array(cols)
  const zIm = new Float64Array(cols)
  const wRe = new Float64Array(cols)
  const wIm = new Float64Array(cols)
  for (let y = 0; y < rows; y += 2) {
    const a = y * cols
    const ha = y * half
    if (y + 1 < rows) {
      const b = (y + 1) * cols
      const hb = (y + 1) * half
      zRe.set(re.subarray(a, a + cols))
      zIm.set(re.subarray(b, b + cols))
      transform(rowPlan, zRe, zIm, wRe, wIm, -1)
      for (let k = 0; k < half; k++) {
        const nk = k === 0 ? 0 : cols - k
        const zr = wRe[k]
        const zi = wIm[k]
        const cr = wRe[nk]
        const ci = -wIm[nk]
        hRe[ha + k] = (zr + cr) / 2
        hIm[ha + k] = (zi + ci) / 2
        hRe[hb + k] = (zi - ci) / 2
        hIm[hb + k] = -(zr - cr) / 2
      }
    } else {
      zRe.set(re.subarray(a, a + cols))
      zIm.fill(0)
      transform(rowPlan, zRe, zIm, wRe, wIm, -1)
      for (let k = 0; k < half; k++) {
        hRe[ha + k] = wRe[k]
        hIm[ha + k] = wIm[k]
      }
    }
  }
  columnPass(hRe, hIm, rows, half, -1)
  return { rows, cols, halfCols: half, re: hRe, im: hIm }
}

/**
 * Hermitian 対称な半スペクトル(rows × halfCols)の逆変換(実数出力、非スケール)。
 * 列を逆変換した後、各行は x 方向に Hermitian になるので、2 行を z = h1 + i·h2 として
 * 1 回の複素逆変換で 2 行分の実数出力を得る。結果は fft2d(full, inverse).re と同じ。
 */
export function ifft2dHermitianHalf(spec: HalfSpectrum): Float64Array {
  const { rows, cols, halfCols } = spec
  const hRe = spec.re.slice()
  const hIm = spec.im.slice()
  columnPass(hRe, hIm, rows, halfCols, 1)
  const out = new Float64Array(rows * cols)
  const rowPlan = getPlan(cols)
  const zRe = new Float64Array(cols)
  const zIm = new Float64Array(cols)
  const wRe = new Float64Array(cols)
  const wIm = new Float64Array(cols)
  for (let y = 0; y < rows; y += 2) {
    const two = y + 1 < rows
    const ha = y * halfCols
    const hb = two ? (y + 1) * halfCols : ha
    // Z[x] = H1[x] + i·H2[x]。x > N/2 は H[N-x] の共役から
    for (let x = 0; x < cols; x++) {
      let r1: number, i1: number, r2: number, i2: number
      if (x < halfCols) {
        r1 = hRe[ha + x]
        i1 = hIm[ha + x]
        r2 = two ? hRe[hb + x] : 0
        i2 = two ? hIm[hb + x] : 0
      } else {
        const m = cols - x
        r1 = hRe[ha + m]
        i1 = -hIm[ha + m]
        r2 = two ? hRe[hb + m] : 0
        i2 = two ? -hIm[hb + m] : 0
      }
      // (r1 + i i1) + i (r2 + i i2) = (r1 - i2) + i (i1 + r2)
      zRe[x] = r1 - i2
      zIm[x] = i1 + r2
    }
    transform(rowPlan, zRe, zIm, wRe, wIm, 1)
    out.set(wRe, y * cols)
    if (two) out.set(wIm, (y + 1) * cols)
  }
  return out
}
