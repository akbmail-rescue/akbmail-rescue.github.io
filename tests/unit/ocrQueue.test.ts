import { describe, expect, it } from 'vitest'
import { OcrQueue, type OcrOutcome } from '../../src/core/ocrQueue'

const ok = (ts: string | null): OcrOutcome => ({ timestamp: ts, sender: ts ? 'x' : null, rawTimestamp: ts ?? '', rawSender: '' })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('OcrQueue', () => {
  it('区間ごとに候補を順に試し、成功したら残りを解放して止める', async () => {
    const calls: string[] = []
    const released: string[] = []
    const q = new OcrQueue<string>(async (img) => { calls.push(img); await tick(); return ok(img === 'c' ? '2026-01-01_0000' : null) }, () => {}, () => {}, (img) => released.push(img))
    for (const img of ['a', 'b', 'c', 'd', 'e']) q.offer(0, { index: img.charCodeAt(0), image: img })
    await q.drain()
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(released.sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(q.offer(0, { index: 9, image: 'f' })).toBe(false) // found 済み
  })
  it('区間の試行上限と全体の保持上限(超過は捨てて dropped に数える)', async () => {
    let block: () => void = () => {}
    const gate = new Promise<void>((r) => (block = r))
    const q = new OcrQueue<string>(async () => { await gate; return ok(null) }, () => {}, () => {}, () => {}, 3, 4)
    // 区間 0: 試行中 1 + 待ち 2 で上限 3
    expect(q.offer(0, { index: 0, image: 'a' })).toBe(true)
    expect(q.offer(0, { index: 1, image: 'b' })).toBe(true)
    expect(q.offer(0, { index: 2, image: 'c' })).toBe(true)
    expect(q.offer(0, { index: 3, image: 'd' })).toBe(false)
    // 全体: 実行中 a を除く待ちは b,c = 2。区間 1 に 2 つ足して 4 = 上限
    expect(q.offer(1, { index: 0, image: 'e' })).toBe(true)
    expect(q.offer(1, { index: 1, image: 'f' })).toBe(true) // 待ち 4
    // 上限到達後: 新しい区間 2 の候補は、待ちが多い区間(0 と 1 が 2 ずつ → 先に見つかった方)の末尾を退避して受け入れる
    expect(q.offer(2, { index: 0, image: 'h' })).toBe(true)
    expect(q.queued).toBe(4)
    // 区間 1 の追加は、自区間が最多でなければ他区間から退避して入る。全区間 1 候補以下になったら捨てる
    expect(q.offer(1, { index: 2, image: 'g' })).toBe(true)
    expect(q.droppedTotal).toBe(2)
    block()
    await q.drain()
    expect(q.idle).toBe(true)
  })
  it('drain は後から積まれたジョブ(最終区間の 2〜8 回目の失敗)も待つ(R2 #3)', async () => {
    const attempts: number[] = []
    const q = new OcrQueue<string>(async () => { await tick(); return ok(null) }, (ev) => attempts.push(ev.attempt), () => {})
    for (let i = 0; i < 8; i++) q.offer(5, { index: i, image: `i${i}` })
    await q.drain()
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(q.stats()).toEqual([{ seg: 5, attempts: 8, found: false, dropped: 0 }])
  })
  it('認識が例外を投げたら以後は受け付けず、待ち候補を解放する', async () => {
    const released: string[] = []
    const errors: unknown[] = []
    const q = new OcrQueue<string>(async () => { await tick(); throw new Error('boom') }, () => {}, (e) => errors.push(e), (img) => released.push(img))
    q.offer(0, { index: 0, image: 'a' })
    q.offer(0, { index: 1, image: 'b' })
    q.offer(1, { index: 0, image: 'c' })
    await q.drain()
    expect(errors.length).toBe(1)
    expect(q.isFailed).toBe(true)
    expect(released.sort()).toEqual(['a', 'b', 'c'])
    expect(q.offer(2, { index: 0, image: 'd' })).toBe(false)
  })
})
