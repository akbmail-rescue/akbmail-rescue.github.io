/**
 * OCR の待ち行列(Codex R1 #4 / R2 #2, #3)。
 * - 区間ごとに候補(切り出し画像)を順に試し、成功したらその区間は終了(rescue.py の「detail を順に試す」)
 * - 区間ごとの試行上限(maxAttemptsPerSeg)に加えて、動画全体で保持する候補数の上限(maxQueuedTotal)を持つ。
 *   候補はグレー 8bit の切り出し(1 候補 ≈ 0.5MB)なので、上限 64 で約 32MB
 * - 区間ごとの待ち候補は maxWaitingPerSeg(既定 = 試行上限 8)まで保持する。区間が閉じた後は補充されないため、
 *   失敗区間の 8 回試行を保証するには区間が開いている間に 8 候補を貯めておく必要がある(R4 #1)。
 *   全体上限に達したときは「待ちが最も多い区間の末尾」を退避して公平性を保つ(長尺では先行の失敗区間の試行数が減る)。
 *   失敗直後の連続フレームはほぼ同じ絵なので、前回候補から minSpacing フレーム以上離れたものだけ受け付ける
 * - canAccept() で「切り出す前に」受け入れ可否を判定できる(拒否されるフレームに切り出しコストを払わない、R4 #4)
 * - 認識の例外(タイムアウト等)は連続 maxConsecutiveErrors 回までは候補失敗として続行し、超えたら停止(R3 #2)
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
  /** 上限で捨てた候補数(INV-7 の可視化用) */
  dropped: number
  /** 最後に受け付けた候補のフレーム番号(間隔制御) */
  lastIndex: number
}

export class OcrQueue<T> {
  private segs = new Map<number, SegState<T>>()
  private queuedTotal = 0
  private failed = false
  private running = false
  private waiters: Array<() => void> = []
  private consecutiveErrors = 0
  droppedTotal = 0
  /** 認識エラー(タイムアウト等)の総数 */
  errorCount = 0

  constructor(
    private readonly recognize: (image: T) => Promise<OcrOutcome>,
    private readonly onResult: (ev: OcrQueueEvent) => void,
    private readonly onError: (e: unknown) => void,
    private readonly release: (image: T) => void = () => {},
    readonly maxAttemptsPerSeg = 8,
    readonly maxQueuedTotal = 64,
    readonly maxWaitingPerSeg = 8,
    readonly minSpacing = 3,
    readonly maxConsecutiveErrors = 3,
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
      s = { attempts: 0, found: false, running: false, queue: [], dropped: 0, lastIndex: -Infinity }
      this.segs.set(id, s)
    }
    return s
  }

  /**
   * 切り出す前の受け入れ判定(副作用なし)。true なら直後の offer() は受け入れられる
   * (全体上限に達していても退避で席が作れる場合を含む)
   */
  canAccept(seg: number, index: number): boolean {
    if (this.failed) return false
    const st = this.segs.get(seg)
    if (st) {
      if (st.found || st.attempts + st.queue.length >= this.maxAttemptsPerSeg) return false
      if (index - st.lastIndex < this.minSpacing) return false
      if (st.queue.length >= this.maxWaitingPerSeg) return false
    }
    if (this.queuedTotal < this.maxQueuedTotal) return true
    // 退避できる区間(待ち 2 以上)があれば受け入れ可。自区間しか無ければ不可
    for (const [id, other] of this.segs) if (id !== seg && other.queue.length > 1) return true
    return false
  }

  /** 候補を投入する。受け入れられなければ false を返す(呼び出し側で解放する) */
  offer(seg: number, cand: OcrCandidate<T>): boolean {
    if (!this.canAccept(seg, cand.index)) {
      const st = this.segs.get(seg)
      if (st && !st.found && cand.index - st.lastIndex >= this.minSpacing) {
        st.dropped++
        this.droppedTotal++
      }
      return false
    }
    const st = this.seg(seg)
    if (this.queuedTotal >= this.maxQueuedTotal) {
      // 全体上限: 待ち候補を最も多く抱える他区間の末尾を退避して席を空ける(canAccept で存在は保証済み)
      let victim: SegState<T> | null = null
      for (const [id, other] of this.segs) if (id !== seg && other.queue.length > 1 && (!victim || other.queue.length > victim.queue.length)) victim = other
      const evicted = victim!.queue.pop()!
      this.release(evicted.image)
      this.queuedTotal--
      victim!.dropped++
      this.droppedTotal++
    }
    st.queue.push(cand)
    st.lastIndex = cand.index
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
        this.consecutiveErrors = 0
        if (outcome.timestamp) {
          st.found = true
          for (const c of st.queue) this.release(c.image)
          this.queuedTotal -= st.queue.length
          st.queue = []
        }
        this.onResult({ seg, index: next.index, attempt, outcome })
      } catch (e) {
        // タイムアウト等の単発エラーは候補失敗として続行(認識側はワーカーを作り直す)。連続したら停止
        this.errorCount++
        this.consecutiveErrors++
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          if (!this.failed) {
            this.failed = true
            this.onError(e)
          }
          this.clearAll()
        } else {
          this.onResult({ seg, index: next.index, attempt, outcome: { timestamp: null, sender: null, rawTimestamp: `(error: ${e instanceof Error ? e.message : String(e)})`, rawSender: '' } })
        }
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
