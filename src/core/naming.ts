/**
 * 最終ファイル名の決定(rescue.py: mail_<ts>.png / mail_unknown_NN.png / image_NNN.png)。
 * - 出現順。同一日時は _2, _3 … を付ける。unknown の番号は「何通目か」
 * - 分割スティッチ(part)は 1 通として扱い、同じ基底名に _pXofY を付ける(R2 #8)
 */
import { imageFileName, mailFileName } from './ocr'

export interface NamedOutputLike {
  key: string
  kind: 'mail' | 'image'
  seg: number
  included: boolean
  editedTimestamp: string | null
  part?: { index: number; total: number }
}

export function assignFinalNames(outputs: NamedOutputLike[], timestampOf: (seg: number) => string | null): Map<string, string> {
  const names = new Map<string, string>()
  const seen = new Map<string, number>()
  /** 分割メールの基底名(seg ごとに part 1 で確定) */
  const baseBySeg = new Map<number, string>()
  let mails = 0
  let images = 0
  for (const o of outputs) {
    if (!o.included) continue
    if (o.kind === 'image') {
      names.set(o.key, imageFileName(++images))
      continue
    }
    let base: string | undefined = o.part && o.part.index > 1 ? baseBySeg.get(o.seg) : undefined
    if (!base) {
      mails++
      const ts = o.editedTimestamp ?? timestampOf(o.seg)
      if (ts) {
        const dup = seen.get(ts) ?? 0
        seen.set(ts, dup + 1)
        base = mailFileName(ts, 0, dup)
      } else {
        base = mailFileName(null, mails)
      }
      if (o.part) baseBySeg.set(o.seg, base)
    }
    names.set(o.key, o.part ? base.replace(/\.png$/, `_p${o.part.index}of${o.part.total}.png`) : base)
  }
  return names
}
