/**
 * OCR の待ち行列(Codex R1 #4 / R2 #2, #3)。
 * - 区間ごとに候補(切り出し画像)を順に試し、成功したらその区間は終了(rescue.py の「detail を順に試す」)
 * - 区間ごとの試行上限(maxAttemptsPerSeg)に加えて、動画全体で保持する候補数の上限(maxQueuedTotal)を持つ。
 *   1 候補 ≈ 2MB(1290×2796 の 2 倍拡大切り出し 2 枚)なので、上限 16 で約 32MB
 * - 認識は全体で 1 本の直列実行(区間番号の小さい=先に閉じる区間を優先)。drain() は「実行中でなく、待ち候補も無い」状態まで待つ
 *   (後から追加されるジョブも取りこぼさない)
 */
export interface OcrCandidate<T> {
  index: number
  image: T
}

export interface OcrOutcome {
  timestamp: string | null
  sender: string | null
  rawTimestamp: string
  rawSender: string
}

export interface OcrQueueEvent {
  seg: number
  index: number
  attempt: number
  outcome: OcrOutcome
}

interface SegState<T> {
  attempts: number
  found: boolean
  running: boolean
  queue: OcrCandidate<T>[]
  /** 全体上限で捨てた候補数(INV-7 の可視化用) */
  dropped: number
}

export class OcrQueue<T> {
  private segs = new Map<number, SegState<T>>()
  private queuedTotal = 0
  private failed = false
  private running = false
  private waiters: Array<() => void> = []
  droppedTotal = 0

  constructor(
    private readonly recognize: (image: T) => Promise<OcrOutcome>,
    private readonly onResult: (ev: OcrQueueEvent) => void,
    private readonly onError: (e: unknown) => void,
    private readonly release: (image: T) => void = () => {},
    readonly maxAttemptsPerSeg = 8,
    readonly maxQueuedTotal = 16,
  ) {}

  get isFailed(): boolean {
    return this.failed
  }

  /** 待機中の候補数(全区間) */
  get queued(): number {
    return this.queuedTotal
  }

  private seg(id: number): SegState<T> {
    let s = this.segs.get(id)
    if (!s) {
      s = { attempts: 0, found: false, running: false, queue: [], dropped: 0 }
      this.segs.set(id, s)
    }
    return s
  }

  /** 候補を投入する。上限に達していれば捨てて false を返す(呼び出し側で release 済みにする) */
  offer(seg: number, cand: OcrCandidate<T>): boolean {
    if (this.failed) return false
    const st = this.seg(seg)
    if (st.found || st.attempts + st.queue.length >= this.maxAttemptsPerSeg) return false
    if (this.queuedTotal >= this.maxQueuedTotal) {
      // 全体上限: 待ち候補を最も多く抱える区間の末尾を退避して席を空ける(どの区間も最低 1 候補は持てる)。
      // 退避先が無い(全区間 1 候補以下)ときだけ新しい候補を捨てる
      let victim: SegState<T> | null = null
      for (const other of this.segs.values()) if (other.queue.length > 1 && (!victim || other.queue.length > victim.queue.length)) victim = other
      if (!victim || (victim === st && st.queue.length >= 1 && victim.queue.length <= 1)) {
        st.dropped++
        this.droppedTotal++
        return false
      }
      const evicted = victim.queue.pop()!
      this.release(evicted.image)
      this.queuedTotal--
      victim.dropped++
      this.droppedTotal++
      if (victim === st && st.queue.length === 0) {
        // 自区間の唯一の候補を退避してまで入れ替える意味は無い(新しい候補は古いより情報が少ないことが多い)
        st.queue.push(evicted)
        this.queuedTotal++
        victim.dropped--
        this.droppedTotal--
        st.dropped++
        this.droppedTotal++
        return false
      }
    }
    st.queue.push(cand)
    this.queuedTotal++
    this.run()
    return true
  }

  /** 次に処理する区間: 番号が最小で待ち候補のあるもの(先に閉じた区間を優先) */
  private pick(): [number, SegState<T>] | null {
    let best: [number, SegState<T>] | null = null
    for (const [seg, st] of this.segs) if (!st.found && st.queue.length > 0 && (!best || seg < best[0])) best = [seg, st]
    return best
  }

  private run(): void {
    if (this.running || this.failed) return
    const picked = this.pick()
    if (!picked) return
    const [seg, st] = picked
    const next = st.queue.shift()!
    this.queuedTotal--
    this.running = true
    st.running = true
    const attempt = ++st.attempts
    void (async () => {
      try {
        const outcome = await this.recognize(next.image)
        if (outcome.timestamp) {
          st.found = true
          for (const c of st.queue) this.release(c.image)
          this.queuedTotal -= st.queue.length
          st.queue = []
        }
        this.onResult({ seg, index: next.index, attempt, outcome })
      } catch (e) {
        if (!this.failed) {
          this.failed = true
          this.onError(e)
        }
        this.clearAll()
      } finally {
        this.release(next.image)
        st.running = false
        this.running = false
        this.run()
        this.wake()
      }
    })()
  }

  private clearAll() {
    for (const st of this.segs.values()) {
      for (const c of st.queue) this.release(c.image)
      st.queue = []
    }
    this.queuedTotal = 0
  }

  private wake() {
    const w = this.waiters
    this.waiters = []
    for (const fn of w) fn()
  }

  get idle(): boolean {
    return !this.running && this.queuedTotal === 0
  }

  /** 全区間の実行と待ち行列が空になるまで待つ(後から積まれたジョブも含む) */
  async drain(): Promise<void> {
    while (!this.idle) await new Promise<void>((r) => this.waiters.push(r))
  }

  /** 区間ごとの統計(ログ用) */
  stats(): Array<{ seg: number; attempts: number; found: boolean; dropped: number }> {
    return [...this.segs.entries()].map(([seg, s]) => ({ seg, attempts: s.attempts, found: s.found, dropped: s.dropped }))
  }
}
