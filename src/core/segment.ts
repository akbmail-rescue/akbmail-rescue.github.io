/**
 * loading イベントの立ち上がりを境界にした区間分割(rescue.py main() の segments 構築部)。
 * ストリーミング処理向けの状態機械。フレーム画素は保持せず、分類結果のメタデータだけを持つ。
 */
import type { FrameCategory, FrameMetrics } from './classify'

export interface ClassifiedFrame extends FrameMetrics {
  /** 6fps サンプル列でのインデックス(0 始まり) */
  index: number
  /** 秒(index / fps) */
  t: number
  cat: FrameCategory
  /** 境界シグナル(loading かつ ヘッダー有り) */
  boundary: boolean
}

export interface Segment {
  /** 区間番号(0 始まり) */
  id: number
  frames: ClassifiedFrame[]
}

export type SegmentEvent =
  | { kind: 'boundary_rise'; frame: ClassifiedFrame; riseCount: number }
  | { kind: 'segment_closed'; segment: Segment }

/**
 * rescue.py:
 *   if boundary and not prev_boundary: (cur があれば segments に追加) cur = []
 *   elif cat != "loading": cur.append(fr)      # ヘッダー無しの loading は境界にも区間にも入れない
 *   末尾で cur があれば追加
 */
export class Segmenter {
  private prevBoundary = false
  private cur: ClassifiedFrame[] = []
  private segments: Segment[] = []
  private riseCount = 0

  push(fr: ClassifiedFrame): SegmentEvent[] {
    const events: SegmentEvent[] = []
    if (fr.boundary && !this.prevBoundary) {
      this.riseCount++
      events.push({ kind: 'boundary_rise', frame: fr, riseCount: this.riseCount })
      if (this.cur.length > 0) events.push({ kind: 'segment_closed', segment: this.closeCurrent() })
      this.cur = []
    } else if (fr.cat !== 'loading') {
      this.cur.push(fr)
    }
    this.prevBoundary = fr.boundary
    return events
  }

  /** 入力終了。未確定の区間があれば閉じる。 */
  finish(): SegmentEvent[] {
    if (this.cur.length > 0) return [{ kind: 'segment_closed', segment: this.closeCurrent() }]
    return []
  }

  private closeCurrent(): Segment {
    const seg: Segment = { id: this.segments.length, frames: this.cur }
    this.segments.push(seg)
    this.cur = []
    return seg
  }

  /** 現在開いている区間の id(次に閉じる区間) */
  get currentSegmentId(): number {
    return this.segments.length
  }

  get boundaryRises(): number {
    return this.riseCount
  }

  get closedSegments(): readonly Segment[] {
    return this.segments
  }
}

export interface SegmentSummary {
  boundaryRises: number
  segments: number
  /** detail フレームを含む区間 = メール候補区間 */
  mailSegments: number
  perSegment: Array<{ id: number; tStart: number; tEnd: number; counts: Record<FrameCategory, number> }>
}

export function summarize(seg: Segmenter): SegmentSummary {
  const perSegment = seg.closedSegments.map((s) => {
    const counts: Record<FrameCategory, number> = { list: 0, loading: 0, detail: 0, fullscreen_image: 0 }
    for (const f of s.frames) counts[f.cat]++
    return { id: s.id, tStart: s.frames[0].t, tEnd: s.frames[s.frames.length - 1].t, counts }
  })
  return {
    boundaryRises: seg.boundaryRises,
    segments: perSegment.length,
    mailSegments: perSegment.filter((p) => p.counts.detail > 0).length,
    perSegment,
  }
}
