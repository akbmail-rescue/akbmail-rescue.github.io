/**
 * RGB → グレースケール。Pillow の Image.convert("L") と同一の整数式:
 *   L = (R*19595 + G*38470 + B*7471 + 0x8000) >> 16
 * (ITU-R 601-2 luma, 16bit 固定小数)。Python 版との数値一致のためこの式以外を使わない。
 */
export function rgbToGray(r: number, g: number, b: number): number {
  return (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16
}

/** RGBA バッファ(getImageData 形式)をグレー配列に変換する。 */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, out?: Uint8Array): Uint8Array {
  const n = rgba.length >> 2
  const gray = out ?? new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    gray[i] = (rgba[j] * 19595 + rgba[j + 1] * 38470 + rgba[j + 2] * 7471 + 0x8000) >> 16
  }
  return gray
}
