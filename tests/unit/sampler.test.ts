import { describe, expect, it } from 'vitest'
import { FpsSampler } from '../../src/core/sampler'

/** 60fps 動画のフレーム n の µs タイムスタンプ(timescale 600 → µs へ丸め) */
const us60 = (n: number) => Math.round((n * 10 * 1e6) / 600)
const DUR60 = Math.round((10 * 1e6) / 600)

function run(fps: number, frames: Array<{ ts: number; dur: number; n: number }>) {
  const s = new FpsSampler<number>(fps)
  const picked: Array<[slot: number, n: number]> = []
  const released: number[] = []
  for (const f of frames) {
    const o = s.push(f.ts, f.dur, f.n)
    for (const e of o.emit) picked.push([e.slot, e.item])
    if (o.release !== null) released.push(o.release)
  }
  const o = s.flush()
  for (const e of o.emit) picked.push([e.slot, e.item])
  if (o.release !== null) released.push(o.release)
  return { s, picked, released }
}

describe('FpsSampler (ffmpeg fps=6 と同じフレーム選択)', () => {
  it('60fps → 6fps: slot k は「丸め pts ≤ k の最後のフレーム」= フレーム 10k+4', () => {
    const frames = Array.from({ length: 60 }, (_, n) => ({ ts: us60(n), dur: DUR60, n }))
    const { s, picked, released } = run(6, frames)
    expect(picked).toEqual([
      [0, 4],
      [1, 14],
      [2, 24],
      [3, 34],
      [4, 44],
      [5, 54],
    ])
    // フレーム 59: pts 0.9833 → r=6, end 1.0 → 6 → slot 6 は出ない(ffmpeg と同じく 6 枚)
    expect(s.emitted).toBe(6)
    // すべてのフレームが解放される
    expect(released.sort((a, b) => a - b)).toEqual(frames.map((f) => f.n))
  })
  it('31 秒の 60fps 動画(1851 フレーム)は 185 枚になる(ffmpeg 実測と一致)', () => {
    const frames = Array.from({ length: 1851 }, (_, n) => ({ ts: us60(n), dur: DUR60, n }))
    const { s } = run(6, frames)
    expect(s.emitted).toBe(185)
  })
  it('.5 ちょうど(µs 丸めで 0.499998)は切り上げて丸める', () => {
    // frame5 = 83333µs → r=1 なので、frame4 が slot0 に出て frame5 は捨てられない
    const frames = [0, 1, 2, 3, 4, 5, 6].map((n) => ({ ts: us60(n), dur: DUR60, n }))
    const { picked } = run(6, frames)
    expect(picked[0]).toEqual([0, 4])
  })
  it('先頭 pts が 0 でなくても相対で数える', () => {
    const frames = Array.from({ length: 20 }, (_, n) => ({ ts: 1_000_000 + us60(n), dur: DUR60, n }))
    const { picked } = run(6, frames)
    expect(picked[0]).toEqual([0, 4])
    expect(picked[1]).toEqual([1, 14])
  })
  it('フレーム落ちでギャップがあれば held を複製して埋める(ffmpeg の dup)', () => {
    // 0.0s と 0.5s の 2 枚だけ → slot0,1,2 は frame0 の複製、frame1 は end=0.5167→3 で slot なし
    const frames = [
      { ts: 0, dur: DUR60, n: 0 },
      { ts: 500_000, dur: DUR60, n: 1 },
    ]
    const { picked } = run(6, frames)
    expect(picked).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ])
  })
  it('末尾フレームは (pts+duration) の丸め値まで出力される', () => {
    // 1 枚だけ、duration 1 秒 → slot 0..5
    const { picked } = run(6, [{ ts: 0, dur: 1_000_000, n: 0 }])
    expect(picked.map((p) => p[0])).toEqual([0, 1, 2, 3, 4, 5])
  })
  it('30fps 入力: slot k はフレーム 5k+2', () => {
    const us30 = (n: number) => Math.round((n * 1e6) / 30)
    const frames = Array.from({ length: 30 }, (_, n) => ({ ts: us30(n), dur: Math.round(1e6 / 30), n }))
    const { picked } = run(6, frames)
    // r(n) = round(n/5): n=2 → 0.4→0, n=3 → 0.6→1 … slot k の最後 = 5k+2
    expect(picked).toEqual([
      [0, 2],
      [1, 7],
      [2, 12],
      [3, 17],
      [4, 22],
      [5, 27],
    ])
  })
})
