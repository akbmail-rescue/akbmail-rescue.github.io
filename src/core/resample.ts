/**
 * Pillow(libImaging/Resample.c)と同一結果になる 8bit グレースケールのリサイズ。
 * imagehash.phash が Pillow の resize(BICUBIC / LANCZOS)に依存しているため、
 * ビット一致のハッシュを得るにはこの実装をそのまま使う必要がある。
 *
 * 要点(Pillow 12 の Resample.c を忠実に移植):
 *  - 係数は double で計算し、正規化後に 22bit 固定小数(PRECISION_BITS)へ丸める
 *  - 水平パス → 垂直パスの 2 段。各出力画素は (Σ k*px + 2^21) >> 22 を 0..255 にクリップ
 *  - 縮小時は filterscale = in/out で support を広げ、引数を 1/filterscale 倍する
 */

export type FilterName = 'bicubic' | 'lanczos'

const PRECISION_BITS = 32 - 8 - 2

interface Filter {
  support: number
  filter(x: number): number
}

function bicubicFilter(x: number): number {
  const a = -0.5
  if (x < 0) x = -x
  if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a
  return 0.0
}

function sincFilter(x: number): number {
  if (x === 0) return 1.0
  x = x * Math.PI
  return Math.sin(x) / x
}

function lanczosFilter(x: number): number {
  if (-3.0 <= x && x < 3.0) return sincFilter(x) * sincFilter(x / 3)
  return 0.0
}

const FILTERS: Record<FilterName, Filter> = {
  bicubic: { support: 2.0, filter: bicubicFilter },
  lanczos: { support: 3.0, filter: lanczosFilter },
}

interface Coeffs {
  ksize: number
  /** [xmin, xmax] × outSize */
  bounds: Int32Array
  /** 22bit 固定小数の係数(outSize × ksize) */
  kk: Int32Array
}

/** Pillow precompute_coeffs + normalize_coeffs_8bpc */
export function precomputeCoeffs(inSize: number, in0: number, in1: number, outSize: number, f: Filter): Coeffs {
  const scale = (in1 - in0) / outSize
  let filterscale = scale
  if (filterscale < 1.0) filterscale = 1.0
  const support = f.support * filterscale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outSize * 2)
  const prekk = new Float64Array(outSize * ksize)
  const ss = 1.0 / filterscale
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale
    let ww = 0.0
    let xmin = Math.trunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = Math.trunc(center + support + 0.5)
    if (xmax > inSize) xmax = inSize
    xmax -= xmin
    const base = xx * ksize
    for (let x = 0; x < xmax; x++) {
      const w = f.filter((x + xmin - center + 0.5) * ss)
      prekk[base + x] = w
      ww += w
    }
    for (let x = 0; x < xmax; x++) if (ww !== 0.0) prekk[base + x] /= ww
    for (let x = xmax; x < ksize; x++) prekk[base + x] = 0
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }
  const kk = new Int32Array(outSize * ksize)
  const scaleBits = 1 << PRECISION_BITS
  for (let i = 0; i < prekk.length; i++) {
    const v = prekk[i]
    kk[i] = v < 0 ? Math.trunc(-0.5 + v * scaleBits) : Math.trunc(0.5 + v * scaleBits)
  }
  return { ksize, bounds, kk }
}

/** Pillow clip8: (v >> PRECISION_BITS) を 0..255 に飽和 */
function clip8(v: number): number {
  const s = v >> PRECISION_BITS
  return s < 0 ? 0 : s > 255 ? 255 : s
}

/**
 * Pillow Image.resize((outW, outH), filter) と同一結果(mode "L"、box なし、reducing_gap なし)。
 */
export function resizeGray(src: Uint8Array, inW: number, inH: number, outW: number, outH: number, filterName: FilterName): Uint8Array {
  if (src.length !== inW * inH) throw new Error('resizeGray: size mismatch')
  const f = FILTERS[filterName]
  const needH = outW !== inW
  const needV = outH !== inH
  const horiz = precomputeCoeffs(inW, 0, inW, outW, f)
  const vert = precomputeCoeffs(inH, 0, inH, outH, f)

  // 垂直パスが参照する行範囲だけ水平パスを計算する(Pillow と同じ)
  const yboxFirst = vert.bounds[0]
  const yboxLast = vert.bounds[(outH - 1) * 2] + vert.bounds[(outH - 1) * 2 + 1]

  let temp: Uint8Array
  let tempH: number
  let tempW: number
  if (needH) {
    tempW = outW
    tempH = yboxLast - yboxFirst
    temp = new Uint8Array(tempW * tempH)
    const half = 1 << (PRECISION_BITS - 1)
    for (let yy = 0; yy < tempH; yy++) {
      const rowIn = (yy + yboxFirst) * inW
      const rowOut = yy * tempW
      for (let xx = 0; xx < outW; xx++) {
        const xmin = horiz.bounds[xx * 2]
        const xmax = horiz.bounds[xx * 2 + 1]
        const kb = xx * horiz.ksize
        let ss0 = half
        for (let x = 0; x < xmax; x++) ss0 += src[rowIn + x + xmin] * horiz.kk[kb + x]
        temp[rowOut + xx] = clip8(ss0)
      }
    }
    // 垂直パスの bounds を temp 基準にずらす
    for (let i = 0; i < outH; i++) vert.bounds[i * 2] -= yboxFirst
  } else {
    temp = src
    tempW = inW
    tempH = inH
  }

  if (!needV) return temp.slice(0, tempW * tempH)

  const out = new Uint8Array(outW * outH)
  const half = 1 << (PRECISION_BITS - 1)
  for (let yy = 0; yy < outH; yy++) {
    const ymin = vert.bounds[yy * 2]
    const ymax = vert.bounds[yy * 2 + 1]
    const kb = yy * vert.ksize
    for (let xx = 0; xx < outW; xx++) {
      let ss0 = half
      for (let y = 0; y < ymax; y++) ss0 += temp[(y + ymin) * tempW + xx] * vert.kk[kb + y]
      out[yy * outW + xx] = clip8(ss0)
    }
  }
  return out
}
