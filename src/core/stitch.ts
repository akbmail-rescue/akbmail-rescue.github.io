/**
 * 縦スティッチ(reference/stitch.py の移植)+ 固定ヘッダーの自動推定。
 *
 * stitch.py:
 *   imgs = 各フレームから固定ヘッダー(fixed_top)を除いたもの
 *   canvas = imgs[0]; y_bottom = h; prev_g = gray(imgs[0])
 *   for im in imgs[1:]:
 *     (dx, dy), resp = phaseCorrelate(prev_g, gray(im), hann); prev_g = gray(im)   # 棄却しても prev は更新
 *     dy = -dy
 *     if resp < 0.7 or |dx| > 12: continue       # 相関が弱い/横ズレ → 画面遷移(2026-08-26: 0.05→0.7、ページ切替アニメ除外)
 *     if dy < 2: continue                        # 静止
 *     dy = int(round(dy))
 *     canvas を dy 行伸ばし、im の下端 dy 行(new_part)を継ぎ足す(2026-08-26: 全体上書きを廃止、collapsing header の二重描画対策)
 *     y_bottom += dy
 *
 * 固定ヘッダーの自動推定(CLAUDE.md「既知の未検証リスク」への対応):
 *   実アプリではステータスバーの下に「戻るボタン行」などスクロールしても動かない領域がある。
 *   最初にスクロールが採用された対で、上端から「行平均の絶対差 < FIXED_ROW_DIFF」が続く行数を
 *   固定領域(skip)とし、以降の相関・貼り付けはその下だけを使う。推定値は次の区間にも引き継ぐ。
 *   合成動画(固定領域なし)では skip=0 のままなので、stitch.py との数値一致は保たれる。
 *
 * INV-2/3: フレーム画素は「直前フレームのグレー(8bit)1 枚+そのスペクトル」以外保持しない。
 * キャンバスの実体は Compositor(タイル管理 OffscreenCanvas / テスト用配列)に委ねる。
 */
import { createHanningWindow, forwardSpectrum, phaseCorrelateSpectra, type Spectrum } from './phaseCorrelate'

/** 除去する固定ヘッダー(ステータスバー)の高さ比。stitch.py の fixed_top=154px(1290×2796)≒ h×0.055 */
export const STITCH_FIXED_TOP = 0.055

/** 棄却条件(stitch.py と同値。変更時は合成回帰テスト必須 INV-5) */
export const STITCH_THRESHOLDS = {
  /** 相関応答がこれ未満なら画面遷移とみなして棄却(stitch.py と同値。ページ切替アニメーションは ≈0.59) */
  minResponse: 0.7,
  /** 横変位がこれを超えたら棄却(px) */
  maxDx: 12,
  /** 縦変位がこれ未満なら静止として棄却(px) */
  minDy: 2,
} as const

/** 固定行推定: 行平均絶対差がこれ未満なら「動いていない行」 */
export const FIXED_ROW_DIFF = 1.0
/** 固定行推定の上限(ステータスバー除去後の高さに対する比)。これ以上は本文とみなす */
export const FIXED_ROWS_MAX_RATIO = 0.25
/**
 * 相関の縮小率(既定 2)。gray を偶数サイズに切ってから 2×2 の平均(cv2 INTER_AREA、四捨五入)で縮小し、
 * dx・dy は原寸換算に戻す。閾値は原寸の意味のまま。2026-08-26 検証: 合成動画 8/8・高さ誤差 1px、
 * 実録画 38 対中 37 対で原寸と同じ採否(dy 差 ≤1px)
 */
export const CORR_SCALE_DEFAULT = 2
/** 縮小判定の応答がこの帯にあるときは原寸で再判定する(ページ切替直前など曖昧な対のみ) */
export const RECHECK_BAND: readonly [number, number] = [0.55, 0.85]

/** 固定行推定に使う対の最小応答。ページ切替アニメーション(応答 0.5〜0.6)では全行が動くため推定しない */
export const FIXED_ROWS_MIN_RESPONSE = 0.8

export interface StitchDecision {
  index: number
  dx: number
  dy: number
  response: number
  accepted: boolean
  /** 採用時に伸ばした行数(Python の add_h) */
  addRows: number
  /** この時点の固定行数(ステータスバー除去後のフレーム内での行数) */
  skip: number
  reason?: 'first' | 'weak_or_shift' | 'static'
  /** 判定に使った縮小率(1 = 原寸で再判定した) */
  scaleUsed?: number
}

/** キャンバスの実体。frame はステータスバー除去後の画像ハンドル。 */
export interface Compositor<T> {
  /** 最初のフレームでキャンバスを初期化(高さ = frameRows、フレーム全体を描く) */
  init(frame: T, frameRows: number): void
  /**
   * キャンバスを addRows 行伸ばし、フレーム(上部 skip 行を除いた frameRows 行)の下端 addRows 行だけを
   * 新しい領域に描く(stitch.py の new_part)。既存領域は上書きしない
   */
  append(frame: T, addRows: number, skip: number, frameRows: number): void
  readonly height: number
}

/** Python 3 の round(): 偶数丸め */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d < 0.5) return f
  if (d > 0.5) return f + 1
  return f % 2 === 0 ? f : f + 1
}

/** OpenCV BGR2GRAY(RGBA 入力): (R*4899 + G*9617 + B*1868 + 2^13) >> 14 */
export function rgbaToGrayCv(rgba: Uint8Array | Uint8ClampedArray, out: Uint8Array): Uint8Array {
  const n = rgba.length >> 2
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + (1 << 13)) >> 14
  }
  return out
}

/**
 * cv2.resize(INTER_AREA) の整数倍縮小(2×2 平均、四捨五入)。入力は偶数サイズに切り詰めてから使う。
 * out のサイズは (w/scale)×(h/scale)。scale=1 ならそのままコピー
 */
export function downscaleGray(src: Uint8Array, width: number, height: number, scale: number, out: Float64Array): { w: number; h: number } {
  const w = Math.floor(width / scale)
  const h = Math.floor(height / scale)
  if (scale === 1) {
    for (let i = 0; i < w * h; i++) out[i] = src[i]
    return { w, h }
  }
  const area = scale * scale
  const half = area >> 1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < scale; dy++) {
        const row = (y * scale + dy) * width + x * scale
        for (let dx = 0; dx < scale; dx++) sum += src[row + dx]
      }
      out[y * w + x] = Math.floor((sum + half) / area)
    }
  }
  return { w, h }
}

/** 2 つの 8bit 配列が完全一致か */
export function identical(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  // 32bit 単位で比較して高速化
  const n32 = a.length >> 2
  const a32 = new Uint32Array(a.buffer, a.byteOffset, n32)
  const b32 = new Uint32Array(b.buffer, b.byteOffset, n32)
  for (let i = 0; i < n32; i++) if (a32[i] !== b32[i]) return false
  for (let i = n32 << 2; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 上端から「行平均絶対差 < FIXED_ROW_DIFF」が続く行数(固定ヘッダーの推定) */
export function estimateFixedRows(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const maxRows = Math.trunc(height * FIXED_ROWS_MAX_RATIO)
  for (let y = 0; y < maxRows; y++) {
    let s = 0
    const o = y * width
    for (let x = 0; x < width; x++) s += Math.abs(a[o + x] - b[o + x])
    if (s / width >= FIXED_ROW_DIFF) return y
  }
  return maxRows
}

export class Stitcher<T> {
  private window: Float64Array
  private fullWindow: Float64Array | null = null
  private prevSpec: Spectrum | null = null
  private prevGray: Uint8Array | null = null
  private count = 0
  private accepted = 0
  private estimated = false
  private skipped = 0
  private cropBuf: Float64Array
  readonly decisions: StitchDecision[] = []

  /**
   * @param width  フレーム幅
   * @param height ステータスバー除去後のフレーム高さ
   * @param compositor キャンバス実体
   * @param skip 固定行数の初期値(前の区間の推定値を引き継ぐ。最初の採用対で再推定され、以降は最小値で更新)
   * @param autoFixedRows 固定行の自動推定を行うか(合成回帰テストでは false でも結果は同じ)
   */
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly compositor: Compositor<T>,
    private skip = 0,
    private readonly autoFixedRows = true,
    /** 相関の縮小率(1 = 原寸) */
    private readonly corrScale = CORR_SCALE_DEFAULT,
    /** 縮小判定が曖昧なら原寸で再判定するか */
    private readonly recheckFull = true,
  ) {
    this.window = createHanningWindow(height - skip, width)
    this.cropBuf = new Float64Array(width * (height - skip))
    this.setSkip(skip, true)
  }

  /** 現在の固定行数(ステータスバー除去後のフレーム内での行数) */
  get fixedRows(): number {
    return this.skip
  }

  private setSkip(skip: number, force = false) {
    if (skip === this.skip && !force) return
    this.skip = skip
    const rows = this.height - skip
    const sw = Math.floor(this.width / this.corrScale)
    const sh = Math.floor(rows / this.corrScale)
    this.window = createHanningWindow(sh, sw)
    this.cropBuf = new Float64Array(sw * sh)
    this.fullWindow = null
  }

  /** gray(height×width, 8bit)の skip 行以下を(必要なら縮小して)double にし、窓掛け・DFT する */
  private spectrumOf(gray: Uint8Array, scale = this.corrScale): Spectrum {
    const rows = this.height - this.skip
    const sub = gray.subarray(this.skip * this.width, this.height * this.width)
    if (scale === this.corrScale) {
      const d = downscaleGray(sub, this.width, rows, scale, this.cropBuf)
      return forwardSpectrum(this.cropBuf, d.h, d.w, this.window)
    }
    // 原寸での再判定用
    const buf = new Float64Array(this.width * rows)
    downscaleGray(sub, this.width, rows, 1, buf)
    if (!this.fullWindow) this.fullWindow = createHanningWindow(rows, this.width)
    return forwardSpectrum(buf, rows, this.width, this.fullWindow)
  }

  /**
   * フレームを 1 枚投入する。gray はステータスバー除去後の cv2 グレー(8bit、width*height)。
   * 呼び出し側は gray のバッファを使い回してよい(内部でコピーする)。
   * frame は同じ領域を描画できるハンドル(採用時のみ Compositor に渡される)。
   */
  push(gray: Uint8Array, frame: T): StitchDecision {
    const index = this.count++
    if (!this.prevSpec) {
      this.prevSpec = this.spectrumOf(gray)
      this.prevGray = gray.slice()
      this.compositor.init(frame, this.height)
      const d: StitchDecision = { index, dx: 0, dy: 0, response: 1, accepted: true, addRows: this.height, skip: this.skip, reason: 'first' }
      this.decisions.push(d)
      return d
    }
    // 直前フレームと画素が完全一致(画面収録の静止区間で頻出)なら、スペクトルも同一なので
    // 相関は自己相関 = (dx=0, dy=0, resp≈1) → static。結果は同じで FFT を省略できる
    if (this.prevGray && identical(this.prevGray, gray)) {
      const d: StitchDecision = { index, dx: 0, dy: 0, response: 1, accepted: false, addRows: 0, skip: this.skip, reason: 'static' }
      this.decisions.push(d)
      this.skipped++
      return d
    }
    const spec = this.spectrumOf(gray)
    let r = phaseCorrelateSpectra(this.prevSpec, spec)
    let scaleUsed = this.corrScale
    if (this.corrScale !== 1) {
      r = { dx: r.dx * this.corrScale, dy: r.dy * this.corrScale, response: r.response }
      if (this.recheckFull && this.prevGray && r.response >= RECHECK_BAND[0] && r.response < RECHECK_BAND[1]) {
        // 曖昧な応答(ページ切替直前など)は原寸で判定し直す
        r = phaseCorrelateSpectra(this.spectrumOf(this.prevGray, 1), this.spectrumOf(gray, 1))
        scaleUsed = 1
      }
    }
    const dx = r.dx
    const dy = -r.dy // 下スクロール = コンテンツは上へ移動
    let d: StitchDecision
    if (r.response < STITCH_THRESHOLDS.minResponse || Math.abs(dx) > STITCH_THRESHOLDS.maxDx) {
      d = { index, dx, dy, response: r.response, accepted: false, addRows: 0, skip: this.skip, reason: 'weak_or_shift', scaleUsed }
      this.prevSpec = spec
    } else if (dy < STITCH_THRESHOLDS.minDy) {
      d = { index, dx, dy, response: r.response, accepted: false, addRows: 0, skip: this.skip, reason: 'static', scaleUsed }
      this.prevSpec = spec
    } else {
      // スクロールが採用された対で固定行を推定する。本文の空白行が偶然一致して過大推定しうるので、
      // 採用対ごとの推定値の最小値を採る(固定ヘッダーは毎回一致するため最小値が真値に収束する)
      if (this.autoFixedRows && this.prevGray && r.response >= FIXED_ROWS_MIN_RESPONSE) {
        const est = estimateFixedRows(this.prevGray, gray, this.width, this.height)
        if (!this.estimated || est < this.skip) {
          this.estimated = true
          if (est !== this.skip) {
            this.setSkip(est)
            this.prevSpec = null // 新しい領域で次フレームのスペクトルを作り直す
          }
        }
      }
      const idy = roundHalfEven(dy)
      const frameRows = this.height - this.skip
      const addRows = idy < frameRows ? idy : frameRows
      this.compositor.append(frame, addRows, this.skip, frameRows)
      this.accepted++
      d = { index, dx, dy, response: r.response, accepted: true, addRows, skip: this.skip, scaleUsed }
      this.prevSpec = this.prevSpec === null ? this.spectrumOf(gray) : spec
    }
    this.prevGray = gray.slice()
    this.decisions.push(d)
    return d
  }

  /** 画素完全一致で FFT を省略したフレーム数 */
  get identicalSkipped(): number {
    return this.skipped
  }

  /** 採用された(伸ばした)フレーム数。0 ならスクロールが検出されなかった */
  get acceptedCount(): number {
    return this.accepted
  }

  get canvasHeight(): number {
    return this.compositor.height
  }
}

/**
 * テスト/Node 用コンポジタ: RGB(3ch)の Uint8Array をキャンバスにする。
 * 容量は倍々で確保し、巨大配列の再確保連打を避ける(INV-3)。
 */
export class ArrayCompositor implements Compositor<Uint8Array | Uint8ClampedArray> {
  private buf = new Uint8Array(0)
  private rows = 0
  constructor(
    readonly width: number,
    /** 入力フレームの 1 画素あたりのバイト数(RGBA=4) */
    readonly channels = 4,
  ) {}

  get height(): number {
    return this.rows
  }

  private ensure(rows: number) {
    const need = rows * this.width * 3
    if (this.buf.length >= need) return
    const cap = Math.max(need, this.buf.length * 2)
    const nb = new Uint8Array(cap)
    nb.set(this.buf)
    this.buf = nb
  }

  /** frame の srcRow 行目から rows 行を、キャンバスの dstRow 行目に描く */
  private paint(frame: Uint8Array | Uint8ClampedArray, srcRow: number, rows: number, dstRow: number) {
    const w = this.width
    const ch = this.channels
    for (let y = 0; y < rows; y++) {
      let d = (dstRow + y) * w * 3
      let s = (srcRow + y) * w * ch
      for (let x = 0; x < w; x++, d += 3, s += ch) {
        this.buf[d] = frame[s]
        this.buf[d + 1] = frame[s + 1]
        this.buf[d + 2] = frame[s + 2]
      }
    }
  }

  init(frame: Uint8Array | Uint8ClampedArray, frameRows: number): void {
    this.rows = frameRows
    this.ensure(this.rows)
    this.paint(frame, 0, frameRows, 0)
  }

  append(frame: Uint8Array | Uint8ClampedArray, addRows: number, skip: number, frameRows: number): void {
    const dst = this.rows
    this.rows += addRows
    this.ensure(this.rows)
    this.paint(frame, skip + frameRows - addRows, addRows, dst)
  }

  /** RGB 行優先 (height × width × 3) */
  toRGB(): Uint8Array {
    return this.buf.slice(0, this.rows * this.width * 3)
  }
}
