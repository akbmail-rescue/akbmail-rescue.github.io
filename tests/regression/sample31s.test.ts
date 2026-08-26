/**
 * 実録画サンプルのパリティテスト(要件 §10 の回帰基準 2 本)。
 * reference/rescue.py と同じ条件(ffmpeg fps=6 → PNG)で抽出したフレームを読み、
 * TS 版の分類・区間化が Python 版と 1 フレームの狂いもなく一致することを確認する。
 * フィクスチャは `npm run fixtures:frames` で生成(gitignore 対象)。無ければ skip。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { classifyFrame, rgbaImage } from '../../src/core/classify'
import { Segmenter, summarize, type ClassifiedFrame } from '../../src/core/segment'
import { SAMPLE_FPS } from '../../src/core/regions'

interface RefRow {
  i: number
  t: number
  bm: number
  dk: number
  hd: number
  cat: 'list' | 'loading' | 'detail' | 'fullscreen'
  boundary: boolean
}

const CASES = [
  {
    name: 'タップ方式 31 秒版 (sample_31s.mp4)',
    framesDir: 'frames',
    ref: 'sample_31s.ref_frames.json',
    frames: 185,
    boundaryRises: 7,
    segments: 8,
    mailSegments: 7,
    hasDetail: [false, true, true, true, true, true, true, true],
    sizes: [6, 13, 13, 27, 26, 25, 24, 29],
  },
  {
    name: '連続スクロール方式 24 秒版 (sample_scroll_24s.mp4)',
    framesDir: 'frames_scroll',
    ref: 'sample_scroll_24s.ref_frames.json',
    frames: 146,
    boundaryRises: 9,
    segments: 10,
    mailSegments: 10,
    hasDetail: Array(10).fill(true),
    sizes: [13, 14, 17, 14, 10, 8, 8, 8, 10, 6],
  },
]

for (const c of CASES) {
  const framesDir = join(__dirname, '../fixtures', c.framesDir)
  const have = existsSync(framesDir) && readdirSync(framesDir).some((f) => f.endsWith('.png'))

  describe.skipIf(!have)(`パリティ: ${c.name}`, () => {
    it(
      `${c.frames} フレームの分類が Python 版と完全一致し、境界立ち上がり ${c.boundaryRises} / 区間 ${c.segments} / メール区間 ${c.mailSegments}`,
      () => {
        const ref: RefRow[] = JSON.parse(readFileSync(join(__dirname, '../fixtures', c.ref), 'utf8'))
        const files = readdirSync(framesDir).filter((f) => /^f_\d+\.png$/.test(f)).sort()
        expect(files.length).toBe(c.frames)
        expect(ref.length).toBe(c.frames)

        const seg = new Segmenter()
        const mismatches: string[] = []
        files.forEach((f, i) => {
          const png = PNG.sync.read(readFileSync(join(framesDir, f)))
          const m = classifyFrame(rgbaImage(png.data, png.width, png.height))
          const cf: ClassifiedFrame = { index: i, t: i / SAMPLE_FPS, ...m }
          seg.push(cf)
          const r = ref[i]
          const refCat = r.cat === 'fullscreen' ? 'fullscreen_image' : r.cat
          if (m.cat !== refCat || m.boundary !== r.boundary || Math.abs(m.bm - r.bm) > 1e-5 || Math.abs(m.dk - r.dk) > 1e-5 || Math.abs(m.hd - r.hd) > 1e-5) {
            mismatches.push(`${i}: ts=${m.cat}/${m.boundary} bm=${m.bm.toFixed(5)} dk=${m.dk.toFixed(5)} hd=${m.hd.toFixed(5)} / py=${refCat}/${r.boundary} bm=${r.bm} dk=${r.dk} hd=${r.hd}`)
          }
        })
        seg.finish()
        expect(mismatches).toEqual([])

        const s = summarize(seg)
        expect(s.boundaryRises).toBe(c.boundaryRises)
        expect(s.segments).toBe(c.segments)
        expect(s.mailSegments).toBe(c.mailSegments)
        expect(s.perSegment.map((p) => p.counts.detail > 0)).toEqual(c.hasDetail)
        expect(s.perSegment.map((p) => Object.values(p.counts).reduce((a, b) => a + b, 0))).toEqual(c.sizes)
      },
      300_000,
    )
  })
}
