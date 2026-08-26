import { describe, expect, it } from 'vitest'
import { assignFinalNames, type NamedOutputLike } from '../../src/core/naming'

const o = (key: string, kind: 'mail' | 'image', seg: number, part?: { index: number; total: number }, edited: string | null = null, included = true): NamedOutputLike => ({ key, kind, seg, included, editedTimestamp: edited, part })

describe('assignFinalNames', () => {
  it('出現順に mail_<ts> / unknown_NN(何通目か)/ image_NNN を付ける', () => {
    const ts: Record<number, string | null> = { 0: '2026-08-25_2259', 1: null, 2: '2026-08-25_2259' }
    const names = assignFinalNames([o('a', 'mail', 0), o('b', 'mail', 1), o('i', 'image', 1), o('c', 'mail', 2)], (s) => ts[s] ?? null)
    expect([...names.values()]).toEqual(['mail_2026-08-25_2259.png', 'mail_unknown_02.png', 'image_001.png', 'mail_2026-08-25_2259_2.png'])
  })
  it('分割スティッチは 1 通として基底名を共有し、重複カウンタを増やさない(R2 #8)', () => {
    const outs = [o('p1', 'mail', 0, { index: 1, total: 3 }), o('p2', 'mail', 0, { index: 2, total: 3 }), o('p3', 'mail', 0, { index: 3, total: 3 }), o('x', 'mail', 1)]
    const names = assignFinalNames(outs, () => '2026-08-25_2259')
    expect(names.get('p1')).toBe('mail_2026-08-25_2259_p1of3.png')
    expect(names.get('p2')).toBe('mail_2026-08-25_2259_p2of3.png')
    expect(names.get('p3')).toBe('mail_2026-08-25_2259_p3of3.png')
    expect(names.get('x')).toBe('mail_2026-08-25_2259_2.png') // 2 通目として _2
  })
  it('unknown の分割も通し番号は 1 通ぶん', () => {
    const outs = [o('p1', 'mail', 0, { index: 1, total: 2 }), o('p2', 'mail', 0, { index: 2, total: 2 }), o('y', 'mail', 1)]
    const names = assignFinalNames(outs, () => null)
    expect(names.get('p1')).toBe('mail_unknown_01_p1of2.png')
    expect(names.get('p2')).toBe('mail_unknown_01_p2of2.png')
    expect(names.get('y')).toBe('mail_unknown_02.png')
  })
  it('除外した出力は名前を持たず番号にも数えない。手入力日時が優先', () => {
    const names = assignFinalNames([o('a', 'mail', 0, undefined, null, false), o('b', 'mail', 1, undefined, '2026-01-01_0000')], () => null)
    expect(names.has('a')).toBe(false)
    expect(names.get('b')).toBe('mail_2026-01-01_0000.png')
  })
})
