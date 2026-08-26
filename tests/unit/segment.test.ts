import { describe, expect, it } from 'vitest'
import { Segmenter, summarize, type ClassifiedFrame } from '../../src/core/segment'
import type { FrameCategory } from '../../src/core/classify'

/** 'loading' はヘッダー有り(境界)、'loading_nohdr' はヘッダー無しの loading(遷移途中) */
type Cat = FrameCategory | 'loading_nohdr'
function run(cats: Cat[]) {
  const seg = new Segmenter()
  const events = cats.flatMap((c, i) => {
    const cat: FrameCategory = c === 'loading_nohdr' ? 'loading' : c
    const boundary = c === 'loading'
    return seg.push({ index: i, t: i / 6, bm: 0, dk: 0, hd: boundary ? 0.3 : 0, cat, boundary } as ClassifiedFrame)
  })
  events.push(...seg.finish())
  return { seg, events, summary: summarize(seg) }
}

describe('Segmenter (rescue.py の区間分割と同じ規則)', () => {
  it('loading の連続は 1 回の立ち上がりとして数える', () => {
    const { summary } = run(['list', 'loading', 'loading', 'loading', 'detail', 'detail'])
    expect(summary.boundaryRises).toBe(1)
    expect(summary.segments).toBe(2)
    expect(summary.mailSegments).toBe(1)
  })
  it('先頭が loading なら空区間は作らない', () => {
    const { summary } = run(['loading', 'detail', 'loading', 'detail'])
    expect(summary.boundaryRises).toBe(2)
    expect(summary.segments).toBe(2)
  })
  it('loading が 1 フレームで区切られた区間も分ける', () => {
    const { summary } = run(['detail', 'loading', 'detail', 'loading', 'detail'])
    expect(summary.segments).toBe(3)
  })
  it('末尾の区間は finish で閉じる。loading で終わる場合は閉じる区間なし', () => {
    const a = run(['detail', 'loading'])
    expect(a.summary.segments).toBe(1)
    const b = run(['detail'])
    expect(b.summary.segments).toBe(1)
  })
  it('fullscreen_image は区間を切らない', () => {
    const { summary } = run(['detail', 'fullscreen_image', 'fullscreen_image', 'detail'])
    expect(summary.segments).toBe(1)
    expect(summary.perSegment[0].counts.fullscreen_image).toBe(2)
  })
  it('ヘッダー無しの loading は境界にならず、区間にも含めない(rescue.py と同じ)', () => {
    const { summary } = run(['detail', 'loading_nohdr', 'loading', 'loading', 'detail'])
    expect(summary.boundaryRises).toBe(1)
    expect(summary.segments).toBe(2)
    expect(summary.perSegment.map((p) => Object.values(p.counts).reduce((a, b) => a + b, 0))).toEqual([1, 1])
  })
  it('ヘッダー無しの loading だけでは区間が切れない', () => {
    const { summary } = run(['detail', 'loading_nohdr', 'loading_nohdr', 'detail'])
    expect(summary.boundaryRises).toBe(0)
    expect(summary.segments).toBe(1)
  })
  it('イベント順序: boundary_rise の後に segment_closed', () => {
    const { events } = run(['list', 'loading'])
    expect(events.map((e) => e.kind)).toEqual(['boundary_rise', 'segment_closed'])
  })
})
