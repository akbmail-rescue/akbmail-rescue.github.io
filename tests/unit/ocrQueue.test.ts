import { describe, expect, it } from 'vitest'
import { OcrQueue, type OcrOutcome } from '../../src/core/ocrQueue'

const ok = (ts: string | null): OcrOutcome => ({ timestamp: ts, sender: ts ? 'x' : null, rawTimestamp: ts ?? '', rawSender: '' })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('OcrQueue', () => {
  it('区間ごとに候補を順に試し、成功したら残りを解放して止める', async () => {
    const calls: string[] = []
    const released: string[] = []
    const q = new OcrQueue<string>(async (img) => { calls.push(img); await tick(); return ok(img === 'c' ? '2026-01-01_0000' : null) }, () => {}, () => {}, (img) => released.push(img))
    const accepted = ['a', 'b', 'c', 'd', 'e'].map((img) => q.offer(0, { index: img.charCodeAt(0) * 10, image: img }))
    expect(accepted).toEqual([true, true, true, true, false]) // 待ち上限 3(実行中 a + b,c,d)で e は拒否
    await q.drain()
    expect(calls).toEqual(['a', 'b', 'c'])
    expect(released.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(q.offer(0, { index: 9000, image: 'f' })).toBe(false) // found 済み
  })
  it('区間の試行上限と全体の保持上限(超過は捨てて dropped に数える)', async () => {
    let block: () => void = () => {}
    const gate = new Promise<void>((r) => (block = r))
    const q = new OcrQueue<string>(async () => { await gate; return ok(null) }, () => {}, () => {}, () => {}, 3, 4, 3, 1)
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
    // 待ち上限 3 があるので、実行が進むたびに補充する(実際のパイプラインと同じ)
    let i = 0
    while (i < 40 && q.stats()[0]?.attempts !== 8) {
      q.offer(5, { index: i * 10, image: `i${i}` })
      i++
      await tick()
      await tick()
    }
    await q.drain()
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(q.stats()[0]).toMatchObject({ seg: 5, attempts: 8, found: false })
  })
  it('連続エラーが上限に達したら以後は受け付けず、待ち候補を解放する', async () => {
    const released: string[] = []
    const errors: unknown[] = []
    const q = new OcrQueue<string>(async () => { await tick(); throw new Error('boom') }, () => {}, (e) => errors.push(e), (img) => released.push(img), 8, 64, 3, 1, 2)
    q.offer(0, { index: 0, image: 'a' })
    q.offer(0, { index: 1, image: 'b' })
    q.offer(1, { index: 0, image: 'c' })
    await q.drain()
    expect(errors.length).toBe(1)
    expect(q.isFailed).toBe(true)
    expect(q.errorCount).toBe(2)
    expect(released.sort()).toEqual(['a', 'b', 'c'])
    expect(q.offer(2, { index: 0, image: 'd' })).toBe(false)
  })
  it('単発のエラー(タイムアウト等)は候補失敗として続行し、その後の区間も処理される(R3 #2)', async () => {
    let n = 0
    const results: Array<[number, string | null]> = []
    const q = new OcrQueue<string>(async (img) => { await tick(); n++; if (n === 1) throw new Error('timeout'); return ok(img.startsWith('ok') ? '2026-01-01_0000' : null) }, (ev) => results.push([ev.seg, ev.outcome.timestamp]), () => {}, () => {}, 8, 64, 3, 1, 3)
    q.offer(0, { index: 0, image: 'x' })
    q.offer(1, { index: 0, image: 'ok1' })
    q.offer(2, { index: 0, image: 'ok2' })
    await q.drain()
    expect(q.isFailed).toBe(false)
    expect(results).toEqual([[0, null], [1, '2026-01-01_0000'], [2, '2026-01-01_0000']])
  })
  it('長尺: OCR が到着より遅くても、失敗区間が待ち行列を占有せず全区間が最低 1 回は試行される(R3 #1)', async () => {
    let gate: () => void = () => {}
    const pending: Array<() => void> = []
    // 認識は呼び出し側が 1 件ずつ進める(到着より遅い状況を再現)
    const q = new OcrQueue<string>((img) => new Promise((r) => pending.push(() => r(ok(img.startsWith('bad') ? null : '2026-01-01_0000')))), () => {}, () => {}, () => {}, 8, 64, 3, 3)
    // 40 区間、各区間 8 フレームずつ到着。偶数区間はヘッダー無し(失敗し続ける)
    for (let seg = 0; seg < 40; seg++) for (let f = 0; f < 8; f++) q.offer(seg, { index: seg * 100 + f * 3, image: `${seg % 2 === 0 ? 'bad' : 'good'}-${seg}-${f}` })
    // 認識を順に進める
    while (!q.idle) {
      while (pending.length) pending.shift()!()
      await tick()
    }
    gate()
    const st = q.stats()
    expect(st.length).toBe(40)
    expect(st.every((x) => x.attempts >= 1)).toBe(true)
    expect(st.filter((x) => x.found).length).toBe(20)
    expect(q.queued).toBe(0)
  })
  it('直前の候補から minSpacing 未満のフレームは受け付けない', () => {
    const q = new OcrQueue<string>(async () => ok(null), () => {}, () => {}, () => {}, 8, 64, 3, 3)
    expect(q.offer(0, { index: 10, image: 'a' })).toBe(true)
    expect(q.offer(0, { index: 11, image: 'b' })).toBe(false)
    expect(q.offer(0, { index: 13, image: 'c' })).toBe(true)
  })
})
