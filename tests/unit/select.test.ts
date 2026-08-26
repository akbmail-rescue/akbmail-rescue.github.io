import { describe, expect, it } from 'vitest'
import { RepresentativeSelector, type CandidateFrame, type SelectEvent } from '../../src/core/select'
import type { FrameCategory } from '../../src/core/classify'

/** テスト用: 画像ハンドルは文字列、release で回収を記録する */
function harness() {
  const released: string[] = []
  const sel = new RepresentativeSelector<string>((img) => released.push(img))
  let n = 0
  const f = (cat: FrameCategory, bm: number, hash: bigint, t = n / 6): CandidateFrame<string> => {
    const index = n++
    return { index, t, bm, cat, hash, capture: () => `img${index}` }
  }
  const selected = (evs: SelectEvent<string>[]) => evs.filter((e) => e.kind === 'selected').map((e) => (e.kind === 'selected' ? `${e.item.kind}@${e.item.index}` : ''))
  return { sel, released, f, selected }
}

const H = (bits: number) => BigInt(bits) // 小さな整数で疎なハッシュを作る

describe('RepresentativeSelector (rescue.py の代表選定・重複排除と同じ規則)', () => {
  it('stable(隣接 ≤2)の中から bm 最大を採用。同値は先勝ち', () => {
    const { sel, f, selected, released } = harness()
    sel.push(f('detail', 0.9, H(0b1111111))) // 1 枚目は stable になれない(前がない)
    sel.push(f('detail', 0.5, H(0b1111110))) // 距離 1 → stable
    sel.push(f('detail', 0.5, H(0b1111100))) // 距離 1 → stable、同値なので先勝ち(index 1)
    sel.push(f('detail', 0.7, H(0b0000000))) // 距離 5 → not stable(bm は高いが対象外)
    const evs = sel.closeSegment()
    expect(selected(evs)).toEqual(['mail@1'])
    expect(evs[0].kind === 'selected' && evs[0].item.fromStable).toBe(true)
    // 負けた候補は解放されている。index 0 は bestAll として保持→区間終了で解放
    expect(released.sort()).toEqual(['img0'])
    expect(sel.retained).toBe(0)
  })
  it('stable が無ければ全 detail の bm 最大', () => {
    const { sel, f, selected } = harness()
    sel.push(f('detail', 0.3, H(0)))
    sel.push(f('detail', 0.6, H(0xffff)))
    sel.push(f('detail', 0.4, H(0xff00ff)))
    const evs = sel.closeSegment()
    expect(selected(evs)).toEqual(['mail@1'])
    expect(evs[0].kind === 'selected' && evs[0].item.fromStable).toBe(false)
  })
  it('list フレームは無視し、detail 同士の隣接で stable を判定', () => {
    const { sel, f, selected } = harness()
    sel.push(f('detail', 0.5, H(0b1000)))
    sel.push(f('list', 0.1, H(0)))
    sel.push(f('detail', 0.6, H(0b1001))) // 直前 detail との距離 1 → stable
    expect(selected(sel.closeSegment())).toEqual(['mail@2'])
  })
  it('既出(≤6)の mail は重複として skipped', () => {
    const { sel, f, selected } = harness()
    sel.push(f('detail', 0.5, H(0b1)))
    sel.push(f('detail', 0.6, H(0b11)))
    sel.closeSegment()
    sel.push(f('detail', 0.5, H(0b111)))
    sel.push(f('detail', 0.9, H(0b1111))) // 0b11 との距離 2 ≤ 6 → dup
    const evs = sel.closeSegment()
    expect(selected(evs)).toEqual([])
    expect(evs[0]).toMatchObject({ kind: 'skipped', reason: 'duplicate', what: 'mail', index: 3 })
  })
  it('fullscreen は隣接 stable(≤2)の後側を採用し、mail の後に重複判定する', () => {
    const { sel, f, selected } = harness()
    sel.push(f('detail', 0.5, H(0)))
    sel.push(f('detail', 0.6, H(1)))
    sel.push(f('fullscreen_image', 1, H(0xf0f0f0f0)))
    sel.push(f('fullscreen_image', 1, H(0xf0f0f0f1))) // stable → image 候補(index 3)
    sel.push(f('fullscreen_image', 1, H(0xf0f0f0f1))) // 候補 index 3 と重複 → 落ちる
    sel.push(f('fullscreen_image', 1, H(0x0f0f0f0f))) // 直前と距離大 → not stable
    sel.push(f('fullscreen_image', 1, H(0x0f0f0f0f))) // stable → image 候補(index 6)
    const evs = sel.closeSegment()
    expect(selected(evs)).toEqual(['mail@1', 'image@3', 'image@6'])
  })
  it('image と近い mail が先に seen に入ると image は重複扱い(rescue.py の順序)', () => {
    const { sel, f, selected } = harness()
    sel.push(f('detail', 0.5, H(0xabcd)))
    sel.push(f('detail', 0.6, H(0xabcd)))
    sel.push(f('fullscreen_image', 1, H(0xabcc)))
    sel.push(f('fullscreen_image', 1, H(0xabcc))) // mail(0xabcd) と距離 1 → dup
    const evs = sel.closeSegment()
    expect(selected(evs)).toEqual(['mail@1'])
    expect(evs.some((e) => e.kind === 'skipped' && e.what === 'image')).toBe(true)
  })
  it('seen は動画全体で累積し、image も mail の重複判定に使われる', () => {
    const { sel, f, selected } = harness()
    sel.push(f('fullscreen_image', 1, H(0x1234)))
    sel.push(f('fullscreen_image', 1, H(0x1234)))
    sel.closeSegment()
    sel.push(f('detail', 0.5, H(0x1234)))
    sel.push(f('detail', 0.6, H(0x1235)))
    expect(selected(sel.closeSegment())).toEqual([])
  })
  it('保持ハンドルは最大 2(best 候補)+保留 image で、負けた候補は即解放', () => {
    const { sel, f, released } = harness()
    sel.push(f('detail', 0.1, H(0)))
    expect(sel.retained).toBe(1)
    sel.push(f('detail', 0.2, H(0))) // stable かつ all 最良 → 1 枚に統合
    expect(sel.retained).toBe(1)
    expect(released).toEqual(['img0'])
    sel.push(f('detail', 0.3, H(0xffffffff))) // all 最良だが not stable → 2 枚
    expect(sel.retained).toBe(2)
    sel.push(f('detail', 0.05, H(0xffffffff))) // どちらにも勝てない → capture されない
    expect(sel.retained).toBe(2)
    sel.closeSegment()
    expect(sel.retained).toBe(0)
  })
})
