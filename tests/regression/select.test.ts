/**
 * S-2 パリティ: 全フレームの pHash が imagehash.phash とビット一致し、
 * 代表フレーム選定・重複排除の結果(mail/image の index・t・hash)が rescue.py と一致する。
 * フィクスチャ: tests/fixtures/*.ref_select.json(scratchpad の ref_select.py で生成)
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { classifyFrame, rgbaImage } from '../../src/core/classify'
import { rgbaToGray } from '../../src/core/gray'
import { Segmenter, type ClassifiedFrame } from '../../src/core/segment'
import { phashFromGray, phashToHex } from '../../src/core/phash'
import { RepresentativeSelector, type SelectEvent } from '../../src/core/select'
import { SAMPLE_FPS } from '../../src/core/regions'

interface Ref {
  frames: Array<{ i: number; hash: string; cat: string }>
  mails: Array<{ seg: number; index: number; t: number; bm: number; hash: string; fromStable: boolean; dup: boolean }>
  images: Array<{ seg: number; index: number; t: number; hash: string }>
}

const CASES = [
  { name: 'タップ方式 31 秒版', framesDir: 'frames', ref: 'sample_31s.ref_select.json', mails: 7, images: 2 },
  { name: '連続スクロール方式 24 秒版', framesDir: 'frames_scroll', ref: 'sample_scroll_24s.ref_select.json', mails: 10, images: 0 },
]

for (const c of CASES) {
  const framesDir = join(__dirname, '../fixtures', c.framesDir)
  const have = existsSync(framesDir) && readdirSync(framesDir).some((f) => f.endsWith('.png'))
  describe.skipIf(!have)(`S-2 パリティ: ${c.name}`, () => {
    it(
      `pHash 全一致、mail ${c.mails} / image ${c.images} の選定結果が rescue.py と一致`,
      () => {
        const ref: Ref = JSON.parse(readFileSync(join(__dirname, '../fixtures', c.ref), 'utf8'))
        const files = readdirSync(framesDir).filter((f) => /^f_\d+\.png$/.test(f)).sort()
        expect(files.length).toBe(ref.frames.length)

        const seg = new Segmenter()
        const released: number[] = []
        const sel = new RepresentativeSelector<number>((img) => released.push(img))
        const events: SelectEvent<number>[] = []
        const hashMismatch: string[] = []
        let peakRetained = 0

        files.forEach((f, i) => {
          const png = PNG.sync.read(readFileSync(join(framesDir, f)))
          const src = rgbaImage(png.data, png.width, png.height)
          const m = classifyFrame(src)
          const gray = rgbaToGray(png.data)
          const hash = phashFromGray(gray, png.width, png.height)
          if (phashToHex(hash) !== ref.frames[i].hash) hashMismatch.push(`${i}: ts=${phashToHex(hash)} py=${ref.frames[i].hash}`)
          const cf: ClassifiedFrame = { index: i, t: i / SAMPLE_FPS, ...m }
          for (const ev of seg.push(cf)) if (ev.kind === 'segment_closed') events.push(...sel.closeSegment())
          if (cf.cat !== 'loading') sel.push({ index: i, t: cf.t, bm: cf.bm, cat: cf.cat, hash, capture: () => i })
          peakRetained = Math.max(peakRetained, sel.retained)
        })
        for (const ev of seg.finish()) if (ev.kind === 'segment_closed') events.push(...sel.closeSegment())

        expect(hashMismatch).toEqual([])

        const mails = events.filter((e) => e.kind === 'selected' && e.item.kind === 'mail').map((e) => (e.kind === 'selected' ? e.item : null)!)
        const images = events.filter((e) => e.kind === 'selected' && e.item.kind === 'image').map((e) => (e.kind === 'selected' ? e.item : null)!)
        expect(mails.map((m) => [m.seg, m.index, phashToHex(m.hash), m.fromStable])).toEqual(
          ref.mails.filter((m) => !m.dup).map((m) => [m.seg, m.index, m.hash, m.fromStable]),
        )
        expect(images.map((m) => [m.seg, m.index, phashToHex(m.hash)])).toEqual(ref.images.map((m) => [m.seg, m.index, m.hash]))
        expect(mails.length).toBe(c.mails)
        expect(images.length).toBe(c.images)
        // 採用された画像は解放されず、それ以外の capture は解放されている
        const kept = new Set([...mails, ...images].map((m) => m.image))
        for (const r of released) expect(kept.has(r)).toBe(false)
        expect(peakRetained).toBeLessThanOrEqual(4)
      },
      600_000,
    )
  })
}
