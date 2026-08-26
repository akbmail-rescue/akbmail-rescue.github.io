/**
 * 代表フレーム選定+重複排除(rescue.py main() の区間ごとの処理)のストリーミング版。
 *
 * rescue.py:
 *   details = 区間内の detail フレーム
 *   stable  = details[i] (i>=1) で hash(details[i]) - hash(details[i-1]) <= 2
 *   best    = max(stable or details, key=bm)      # 同値なら先勝ち
 *   if not is_dup(best.hash): seen.append; mail として保存
 *   fulls   = 区間内の fullscreen フレーム
 *   for i>=1: if hash(fulls[i]) - hash(fulls[i-1]) <= 2 and not is_dup(fulls[i].hash): seen.append; image として保存
 *   is_dup(h) = any(h - s <= 6 for s in seen)     # seen は mail/image 共通、動画全体で累積
 *
 * INV-2: フレーム画素は配列に溜めない。保持するのは
 *   - 区間内の「最良候補」(stable 最良と全体最良、最大 2 枚)
 *   - 区間内で条件を満たした fullscreen 候補(区間終了時に mail の hash を含めて重複判定するため保留)
 * だけで、判定に負けた候補はその場で解放する。
 */
import type { FrameCategory } from './classify'
import { hammingDistance, type PHash } from './phash'
import { FRAME_BUDGET } from './regions'

export const STABLE_MAX_DISTANCE = 2
export const DUP_MAX_DISTANCE = 6
/** 1 区間で保留できる fullscreen 候補の上限(INV-2 の予算配分)。超過分は INV-7 に従い skipped として報告する */
export const MAX_PENDING_IMAGES = FRAME_BUDGET.selectorPending

export interface CandidateFrame<T> {
  index: number
  t: number
  bm: number
  cat: FrameCategory
  hash: PHash
  /** 画素の保持ハンドル。採用が確定するまで選定器が所有し、不要になれば release する */
  capture: () => T
}

export interface SelectedItem<T> {
  kind: 'mail' | 'image'
  seg: number
  index: number
  t: number
  bm: number
  hash: PHash
  /** stable 候補から選ばれたか(mail のみ) */
  fromStable: boolean
  image: T
}

export type SelectEvent<T> =
  | { kind: 'selected'; item: SelectedItem<T> }
  | { kind: 'skipped'; reason: 'duplicate' | 'pending_overflow'; what: 'mail' | 'image'; seg: number; index: number; t: number; hash: PHash }

interface Held<T> {
  index: number
  t: number
  bm: number
  hash: PHash
  image: T
}

export class RepresentativeSelector<T> {
  private seen: PHash[] = []
  private seg = 0
  private prevDetailHash: PHash | null = null
  private prevFullHash: PHash | null = null
  private bestStable: Held<T> | null = null
  private bestAll: Held<T> | null = null
  private pendingImages: Held<T>[] = []
  private overflow: Array<{ index: number; t: number; hash: PHash }> = []

  constructor(private readonly release: (image: T) => void) {}

  /** 現在保持している画像ハンドル数(INV-2 の実証用) */
  get retained(): number {
    let n = this.pendingImages.length
    if (this.bestAll) n++
    if (this.bestStable && this.bestStable !== this.bestAll) n++
    return n
  }

  private isDup(h: PHash): boolean {
    return this.seen.some((s) => hammingDistance(h, s) <= DUP_MAX_DISTANCE)
  }

  /** 区間内のフレームを 1 枚投入する(loading は呼ばない)。 */
  push(fr: CandidateFrame<T>): void {
    if (fr.cat === 'detail') {
      const stable = this.prevDetailHash !== null && hammingDistance(fr.hash, this.prevDetailHash) <= STABLE_MAX_DISTANCE
      this.prevDetailHash = fr.hash
      const beatsAll = !this.bestAll || fr.bm > this.bestAll.bm
      const beatsStable = stable && (!this.bestStable || fr.bm > this.bestStable.bm)
      if (!beatsAll && !beatsStable) return
      const held: Held<T> = { index: fr.index, t: fr.t, bm: fr.bm, hash: fr.hash, image: fr.capture() }
      if (beatsAll) {
        if (this.bestAll && this.bestAll !== this.bestStable) this.release(this.bestAll.image)
        this.bestAll = held
      }
      if (beatsStable) {
        if (this.bestStable && this.bestStable !== this.bestAll && this.bestStable !== held) this.release(this.bestStable.image)
        this.bestStable = held
      }
    } else if (fr.cat === 'fullscreen_image') {
      const stable = this.prevFullHash !== null && hammingDistance(fr.hash, this.prevFullHash) <= STABLE_MAX_DISTANCE
      this.prevFullHash = fr.hash
      if (!stable) return
      // 既出(seen)と、この区間で先に保留した候補との重複はここで落とせる。
      // 区間の mail hash だけは未確定なので区間終了時に再判定する
      if (this.isDup(fr.hash) || this.pendingImages.some((p) => hammingDistance(fr.hash, p.hash) <= DUP_MAX_DISTANCE)) return
      if (this.pendingImages.length >= MAX_PENDING_IMAGES) {
        this.overflow.push({ index: fr.index, t: fr.t, hash: fr.hash })
        return
      }
      this.pendingImages.push({ index: fr.index, t: fr.t, bm: fr.bm, hash: fr.hash, image: fr.capture() })
    }
  }

  /** 区間終了。mail → image の順に重複判定して確定する(rescue.py と同じ順序)。 */
  closeSegment(): SelectEvent<T>[] {
    const events: SelectEvent<T>[] = []
    const seg = this.seg
    const best = this.bestStable ?? this.bestAll
    if (best) {
      if (this.isDup(best.hash)) {
        events.push({ kind: 'skipped', reason: 'duplicate', what: 'mail', seg, index: best.index, t: best.t, hash: best.hash })
        this.release(best.image)
      } else {
        this.seen.push(best.hash)
        events.push({ kind: 'selected', item: { kind: 'mail', seg, index: best.index, t: best.t, bm: best.bm, hash: best.hash, fromStable: this.bestStable !== null, image: best.image } })
      }
      const other = best === this.bestStable ? this.bestAll : this.bestStable
      if (other && other !== best) this.release(other.image)
    }
    for (const p of this.pendingImages) {
      if (this.isDup(p.hash)) {
        events.push({ kind: 'skipped', reason: 'duplicate', what: 'image', seg, index: p.index, t: p.t, hash: p.hash })
        this.release(p.image)
      } else {
        this.seen.push(p.hash)
        events.push({ kind: 'selected', item: { kind: 'image', seg, index: p.index, t: p.t, bm: p.bm, hash: p.hash, fromStable: true, image: p.image } })
      }
    }
    for (const o of this.overflow) events.push({ kind: 'skipped', reason: 'pending_overflow', what: 'image', seg, index: o.index, t: o.t, hash: o.hash })

    this.seg++
    this.prevDetailHash = null
    this.prevFullHash = null
    this.bestStable = null
    this.bestAll = null
    this.pendingImages = []
    this.overflow = []
    return events
  }
}
