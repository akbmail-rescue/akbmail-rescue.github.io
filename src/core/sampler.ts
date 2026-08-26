/**
 * 6fps サンプリング。ffmpeg の `-vf fps=6`(丸めモード near)と同じフレームを選ぶ。
 *
 * ffmpeg vf_fps の規則(実測で確認済み):
 *   - 各入力フレームの pts を出力レートで丸める: r = round_half_away((pts - pts0) * fps)
 *   - 直前のフレーム(held)を 1 枚保持し、新フレームの r が next_slot より大きい間、
 *     held を next_slot として出力(ギャップがあれば同じフレームを複数回出力)。
 *     r <= next_slot なら held は捨てられ、新フレームが held になる
 *   - 入力終了時は held の (pts + duration) を丸めた値まで出力
 *   → slot k には「r <= k を満たす最後のフレーム」が入る(60fps なら n = 10k+4 付近)
 *
 * timestamp はマイクロ秒整数で渡ってくるため、有理数上でちょうど .5 になる値が
 * 0.499998 のように下振れする。EPS で吸収する(通常の値は .5 の 1e-4 以内に来ない)。
 * 保持するのは held の 1 枚だけ(INV-2)。
 */
const EPS = 1e-4

export interface SamplerOutput<T> {
  /** 出力すべき (slot, item)。同じ item が複数 slot に出ることがある */
  emit: Array<{ slot: number; item: T }>
  /** 保持を解除してよい item(emit の処理が終わってから解放すること) */
  release: T | null
}

export class FpsSampler<T = unknown> {
  private t0: number | null = null
  private nextSlot = 0
  private held: { r: number; endR: number; item: T } | null = null

  constructor(readonly fps: number) {}

  private roundSlot(timestampUs: number): number {
    const x = ((timestampUs - (this.t0 ?? timestampUs)) * this.fps) / 1e6
    return Math.floor(x + 0.5 + EPS)
  }

  /** フレームを 1 枚投入する。 */
  push(timestampUs: number, durationUs: number, item: T): SamplerOutput<T> {
    if (this.t0 === null) this.t0 = timestampUs
    const r = this.roundSlot(timestampUs)
    const endR = this.roundSlot(timestampUs + durationUs)
    const out: SamplerOutput<T> = { emit: [], release: null }
    if (this.held) {
      while (r > this.nextSlot) {
        out.emit.push({ slot: this.nextSlot, item: this.held.item })
        this.nextSlot++
      }
      out.release = this.held.item
    }
    this.held = { r, endR, item }
    return out
  }

  /** 入力終了。held を (pts + duration) の丸め値まで出力して解放する。 */
  flush(): SamplerOutput<T> {
    const out: SamplerOutput<T> = { emit: [], release: null }
    if (this.held) {
      while (this.nextSlot < this.held.endR) {
        out.emit.push({ slot: this.nextSlot, item: this.held.item })
        this.nextSlot++
      }
      out.release = this.held.item
      this.held = null
    }
    return out
  }

  /** これまでに出力した slot 数 */
  get emitted(): number {
    return this.nextSlot
  }
}
