/**
 * imagehash.phash(hash_size=8, highfreq_factor=4) のビット一致移植。
 *
 * rescue.py での使い方: imagehash.phash(gray.resize((256, 256)))
 *   1. グレー(PIL "L")を 256×256 に BICUBIC(Pillow の resize 既定)で縮小
 *   2. phash 内部で 32×32 に LANCZOS(ANTIALIAS)で縮小
 *   3. scipy.fftpack.dct(type II, 正規化なし)を axis 0 → axis 1 に適用
 *   4. 左上 8×8 の中央値(64 個の平均中央値)より大きいビットを 1
 *   5. 行優先で 64bit。文字列表現は 8bit ごとの 16 進(imagehash と同じ)
 */
import { resizeGray } from './resample'

const HASH_SIZE = 8
const IMG_SIZE = HASH_SIZE * 4

/** scipy.fftpack.dct type II(norm=None): y_k = 2 Σ x_n cos(π k (2n+1) / 2N) を axis 0 → axis 1 に適用 */
export function dct2(pixels: Uint8Array | Float64Array, n: number): Float64Array {
  const cosTable = new Float64Array(n * n)
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) cosTable[k * n + i] = Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n))
  // axis 0(列ごとに縦方向)
  const tmp = new Float64Array(n * n)
  for (let col = 0; col < n; col++) {
    for (let k = 0; k < n; k++) {
      let s = 0
      for (let i = 0; i < n; i++) s += pixels[i * n + col] * cosTable[k * n + i]
      tmp[k * n + col] = 2 * s
    }
  }
  // axis 1(行ごとに横方向)
  const out = new Float64Array(n * n)
  for (let row = 0; row < n; row++) {
    for (let k = 0; k < n; k++) {
      let s = 0
      for (let i = 0; i < n; i++) s += tmp[row * n + i] * cosTable[k * n + i]
      out[row * n + k] = 2 * s
    }
  }
  return out
}

/** numpy.median(偶数個は中央 2 値の平均) */
export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).sort((x, y) => x - y)
  const n = a.length
  return n % 2 === 1 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2
}

/** 64bit ハッシュ。BigInt で保持(行優先、先頭ビットが最上位) */
export type PHash = bigint

/** 32×32 グレー配列から pHash を計算する(imagehash.phash の resize 後の処理) */
export function phashFrom32(px32: Uint8Array): PHash {
  const d = dct2(px32, IMG_SIZE)
  const low = new Float64Array(HASH_SIZE * HASH_SIZE)
  for (let r = 0; r < HASH_SIZE; r++) for (let c = 0; c < HASH_SIZE; c++) low[r * HASH_SIZE + c] = d[r * IMG_SIZE + c]
  const med = median(low)
  let h = 0n
  for (let i = 0; i < low.length; i++) {
    h <<= 1n
    if (low[i] > med) h |= 1n
  }
  return h
}

/**
 * rescue.py と同じ経路: フルフレームのグレー → 256×256 BICUBIC → phash(32×32 LANCZOS → DCT)。
 */
export function phashFromGray(gray: Uint8Array, width: number, height: number): PHash {
  const g256 = resizeGray(gray, width, height, 256, 256, 'bicubic')
  const g32 = resizeGray(g256, 256, 256, IMG_SIZE, IMG_SIZE, 'lanczos')
  return phashFrom32(g32)
}

/** imagehash の ImageHash.__sub__: ハミング距離 */
export function hammingDistance(a: PHash, b: PHash): number {
  let x = a ^ b
  let c = 0
  while (x) {
    x &= x - 1n
    c++
  }
  return c
}

/** imagehash の str(hash) と同じ 16 桁 16 進 */
export function phashToHex(h: PHash): string {
  return h.toString(16).padStart(16, '0')
}

export function phashFromHex(s: string): PHash {
  return BigInt('0x' + s)
}
