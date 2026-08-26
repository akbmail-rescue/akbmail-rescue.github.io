/**
 * メタデータ OCR(要件 F-5、rescue.py ocr_timestamp の移植)。
 *
 * rescue.py:
 *   crop = img.crop((int(w*0.55), int(h*0.13), w, int(h*0.18))).convert("L")
 *   crop = crop.resize((crop.width*2, crop.height*2))
 *   txt = pytesseract.image_to_string(crop, config="--psm 7 -c tessedit_char_whitelist=0123456789-: ")
 *   m = re.search(r"(20\d\d)-(\d\d)-(\d\d)\s*(\d\d):?(\d\d)", txt) → "YYYY-MM-DD_HHMM"
 *
 * tesseract.js の worker / core / 言語データはすべて同一オリジンの静的アセット(public/)から読む(INV-1, NF-5)。
 */
import { createWorker, OEM, PSM, type Worker as TesseractWorker } from 'tesseract.js'
import type { RelRect } from './regions'

/** OCR 対象の相対領域(INV-4) */
export const OCR_REGIONS = {
  /** ヘッダー右上のタイムスタンプ(rescue.py と同値) */
  timestamp: { x0: 0.55, x1: 1.0, y0: 0.13, y1: 0.18 } as RelRect,
  /** ヘッダー左の送信者名(実機 1290×2796 で実測: 名前行 y≈0.148–0.164、アバターの右 x≈0.18〜) */
  sender: { x0: 0.17, x1: 0.55, y0: 0.14, y1: 0.17 } as RelRect,
} as const

/** 1 区間あたりの OCR 試行上限(rescue.py は全 detail を試すが、時間を抑えるため上限を置く。超過は unknown) */
export const MAX_OCR_ATTEMPTS = 8

/** OCR 前の拡大倍率(rescue.py: 2 倍) */
export const OCR_UPSCALE = 2

const TIMESTAMP_RE = /(20\d\d)-(\d\d)-(\d\d)\s*(\d\d):?(\d\d)/

/** rescue.py と同じ正規表現で "YYYY-MM-DD_HHMM" を取り出す。見つからなければ null */
export function parseTimestamp(text: string): string | null {
  const m = TIMESTAMP_RE.exec(text)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}_${m[4]}${m[5]}`
}

/** "YYYY-MM-DD_HHMM" → 表示用 "YYYY-MM-DD HH:MM" */
export function formatTimestamp(ts: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})$/.exec(ts)
  return m ? `${m[1]} ${m[2]}:${m[3]}` : ts
}

/** 手入力("2026-08-25 22:59" / "2026-08-25_2259" / "2026/8/25 22:59" など)を "YYYY-MM-DD_HHMM" に正規化。不正なら null */
export function normalizeTimestampInput(input: string): string | null {
  const m = /^\s*(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT_]*(\d{1,2}):?(\d{2})\s*$/.exec(input)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const M = Number(mo)
  const D = Number(d)
  const H = Number(h)
  const I = Number(mi)
  if (M < 1 || M > 12 || D < 1 || D > 31 || H > 23 || I > 59) return null
  return `${y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}_${String(H).padStart(2, '0')}${String(I).padStart(2, '0')}`
}

/**
 * 送信者名の後処理: 1 行化・前後空白除去・OCR ノイズ記号の除去。
 * tesseract の jpn は文字ごとに空白を入れて返す("渋 井 美 奈")ため、日本語文字どうしの間の空白は詰める。
 * 元の姓名区切りは復元できないので "渋井美奈" になる
 */
export function cleanSender(text: string): string | null {
  const jp = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々〆〇]'
  const s = text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[|\\/_~`^]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(`(?<=${jp}) (?=${jp})`, 'gu'), '')
    .trim()
  return s.length >= 1 ? s : null
}

/** 出力ファイル名(rescue.py: mail_<ts>.png / mail_unknown_NN.png / image_NNN.png) */
export function mailFileName(timestamp: string | null, unknownIndex: number, dup = 0): string {
  const base = timestamp ? `mail_${timestamp}` : `mail_unknown_${String(unknownIndex).padStart(2, '0')}`
  return dup > 0 ? `${base}_${dup + 1}.png` : `${base}.png`
}

export function imageFileName(index: number): string {
  return `image_${String(index).padStart(3, '0')}.png`
}

export interface OcrAssetPaths {
  /** 例: `${base}tesseract/worker.min.js` */
  workerPath: string
  /** 例: `${base}tesseract-core/`(ディレクトリ) */
  corePath: string
  /** 例: `${base}tessdata/`(*.traineddata.gz を置く) */
  langPath: string
}

/**
 * tesseract.js のワーカーを 1 つ持ち、タイムスタンプ(数字のみ)と送信者名(jpn+eng)を認識する。
 * 呼び出しは直列化される(tesseract.js のワーカーは同時に 1 ジョブ)。
 */
export class OcrService {
  private worker: TesseractWorker | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private mode: 'timestamp' | 'sender' | null = null

  constructor(
    private readonly paths: OcrAssetPaths,
    private readonly log?: (m: string) => void,
  ) {}

  async init(): Promise<void> {
    if (this.worker) return
    const t0 = performance.now()
    // アセット欠落などで createWorker が永遠に解決しないことがあるため、タイムアウトで失敗にする
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tesseract.js の初期化がタイムアウトしました(worker/core/tessdata の配置を確認)')), 90_000))
    this.worker = await Promise.race([
      createWorker(['jpn', 'eng'], OEM.LSTM_ONLY, {
        workerPath: this.paths.workerPath,
        corePath: this.paths.corePath,
        langPath: this.paths.langPath,
        gzip: true,
        workerBlobURL: false,
        errorHandler: (e: unknown) => this.log?.(`[tesseract] ${e instanceof Error ? e.message : String(e)}`),
        logger: () => {},
      }),
      timeout,
    ])
    this.log?.(`tesseract.js ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
  }

  private async setMode(mode: 'timestamp' | 'sender') {
    if (this.mode === mode) return
    this.mode = mode
    await this.worker!.setParameters(
      mode === 'timestamp'
        ? { tessedit_char_whitelist: '0123456789-: ', tessedit_pageseg_mode: PSM.SINGLE_LINE }
        : { tessedit_char_whitelist: '', tessedit_pageseg_mode: PSM.SINGLE_LINE },
    )
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  /** タイムスタンプ領域(拡大・グレー化済み)の認識。戻り値は "YYYY-MM-DD_HHMM" か null と生テキスト */
  recognizeTimestamp(image: OffscreenCanvas): Promise<{ timestamp: string | null; raw: string }> {
    return this.enqueue(async () => {
      await this.init()
      await this.setMode('timestamp')
      const r = await this.worker!.recognize(image)
      const raw = r.data.text ?? ''
      return { timestamp: parseTimestamp(raw), raw }
    })
  }

  /** 送信者名領域の認識 */
  recognizeSender(image: OffscreenCanvas): Promise<{ sender: string | null; raw: string }> {
    return this.enqueue(async () => {
      await this.init()
      await this.setMode('sender')
      const r = await this.worker!.recognize(image)
      const raw = r.data.text ?? ''
      return { sender: cleanSender(raw), raw }
    })
  }

  /** 投入済みジョブの完了を待つ */
  async drain(): Promise<void> {
    await this.chain
  }

  async terminate(): Promise<void> {
    await this.drain()
    await this.worker?.terminate()
    this.worker = null
    this.mode = null
  }
}
