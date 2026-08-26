/**
 * 画面判定に使う相対座標と閾値の唯一の定義場所(INV-4)。
 * 数値は reference/rescue.py と同値。変更する場合は Python 版で先に検証し、
 * 回帰テスト(INV-5)を通してから両方を更新する。
 */

/** 縦方向の相対区間 [y0, y1)。ピクセル化は Math.trunc(h * frac)(Python の int() と同じ切り捨て)。 */
export interface RelBand {
  readonly y0: number
  readonly y1: number
}

/** 矩形の相対区間 [x0,x1) × [y0,y1)。 */
export interface RelRect extends RelBand {
  readonly x0: number
  readonly x1: number
}

export const REGIONS = {
  /** メール詳細ヘッダーのアバター領域: 彩度画素率で「ヘッダー有無」を判定(要件 F-3) */
  avatar: { x0: 0.06, x1: 0.15, y0: 0.145, y1: 0.19 } as RelRect,
  /** 本文領域: 非白ピクセル率で list / loading / detail を判定 */
  body: { y0: 0.28, y1: 0.9 } as RelBand,
  /** 上端: フルスクリーン画像ビューアの暗色背景判定 */
  darkTop: { y0: 0.1, y1: 0.16 } as RelBand,
  /** 下端: 同上 */
  darkBottom: { y0: 0.92, y1: 0.98 } as RelBand,
} as const

export const THRESHOLDS = {
  /** グレー値がこれ未満なら「非白」(rescue.py: p < 240) */
  nonWhitePx: 240,
  /** グレー値がこれ未満なら「暗色」(rescue.py: p < 60) */
  darkPx: 60,
  /** 非白率 < loading → loading */
  loading: 0.02,
  /** 非白率 < list → list、それ以上は detail */
  list: 0.15,
  /** 暗色率 > fullscreenDark → fullscreen_image */
  fullscreenDark: 0.5,
  /**
   * 彩度画素: HSV の S > 0.2 と同値の整数判定 (max-min)*5 > max(max=0 は非該当)。
   * satScale が「5」= 1/0.2
   */
  saturationScale: 5,
  /** アバター領域の彩度画素率 > header → ヘッダー有り(要件 F-3: 0.15) */
  header: 0.15,
} as const

/** 出力時に除去するステータスバー領域の高さ比(rescue.py: crop((0, int(h*0.055), w, h))) */
export const STATUS_BAR_TOP = 0.055

/** フレーム抽出レート(rescue.py: FPS = 6) */
export const SAMPLE_FPS = 6

/** 同時に保持してよいデコード済みフレームの上限(INV-2) */
export const MAX_RETAINED_FRAMES = 30

/** ピクセル行の区間に変換する。Python の img.crop((0, int(h*y0), w, int(h*y1))) と同じ。 */
export function bandRows(height: number, band: RelBand): { rowStart: number; rowEnd: number } {
  return { rowStart: Math.trunc(height * band.y0), rowEnd: Math.trunc(height * band.y1) }
}

/** 矩形をピクセル範囲に変換する。Python の crop((int(w*x0), int(h*y0), int(w*x1), int(h*y1))) と同じ。 */
export function rectPixels(width: number, height: number, r: RelRect) {
  return {
    colStart: Math.trunc(width * r.x0),
    colEnd: Math.trunc(width * r.x1),
    rowStart: Math.trunc(height * r.y0),
    rowEnd: Math.trunc(height * r.y1),
  }
}
