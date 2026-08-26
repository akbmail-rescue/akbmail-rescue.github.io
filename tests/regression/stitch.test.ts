/**
 * S-3 スティッチ回帰(INV-5 / 要件 §10):
 *  - 合成スクロール動画(synth_gen.py 相当)の 6fps フレームをスティッチし、
 *    正解画像に対して高さ誤差 ≤1%、バンド一致 ≥7/8(NCC > 0.9)を満たすこと
 *  - フレーム対ごとの (dx, dy, resp) が cv2.phaseCorrelate と一致すること(パリティ)
 * フィクスチャ: `PY=<venv> bash scripts/make-synth-fixtures.sh` で生成(frames / ground_truth は gitignore)
 */
import { describe, expect, it } from 'vitest'

/** CI では REQUIRE_FIXTURES に列挙したフィクスチャが無ければ skip ではなく fail にする(F11) */
const REQUIRED = (process.env.REQUIRE_FIXTURES ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const fixtureGate = (name: string, have: boolean) => {
  if (!have && REQUIRED.includes(name)) throw new Error(`フィクスチャ ${name} が無いためテストを実行できません(REQUIRE_FIXTURES=${REQUIRED.join(',')})`)
  return have
}
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { ArrayCompositor, STITCH_FIXED_TOP, Stitcher, rgbaToGrayCv } from '../../src/core/stitch'

const DIR = join(__dirname, '../fixtures/synth')
const have = existsSync(join(DIR, 'frames')) && existsSync(join(DIR, 'ground_truth.png'))

interface Pairs {
  fixed_top: number
  pairs: Array<{ dx: number; dy: number; resp: number }>
  height: number
  width: number
  frames: number
}

/** fixed_top 行を除いた RGBA を返す */
function cropTop(png: PNG, top: number): { rgba: Uint8Array; width: number; height: number } {
  const w = png.width
  const h = png.height - top
  return { rgba: new Uint8Array(png.data.buffer, png.data.byteOffset + top * w * 4, w * h * 4), width: w, height: h }
}

function toGray(rgb: Uint8Array, ch: number): Float64Array {
  const n = rgb.length / ch
  const g = new Float64Array(n)
  for (let i = 0, j = 0; i < n; i++, j += ch) g[i] = (rgb[j] * 4899 + rgb[j + 1] * 9617 + rgb[j + 2] * 1868 + (1 << 13)) >> 14
  return g
}

/**
 * cv2.matchTemplate(TM_CCOEFF_NORMED) 相当。stitch.py の validate は全 (x,y) を走査するが、
 * ほぼ無地のテンプレート(std < 1)は白地のどこかで 1.0 になり判定として無意味なので、
 * cv2 と同じく 1.0 とみなし、それ以外は切り出し原点 x=100 固定で縦方向のみ走査する(より厳しい判定)。
 */
function bestNcc(canvas: Float64Array, cw: number, chh: number, tpl: Float64Array, tw: number, th: number, x0: number): number {
  let tMean = 0
  for (let i = 0; i < tpl.length; i++) tMean += tpl[i]
  tMean /= tpl.length
  let tVar = 0
  for (let i = 0; i < tpl.length; i++) tVar += (tpl[i] - tMean) ** 2
  if (Math.sqrt(tVar / tpl.length) < 1.0) return 1.0
  let best = -1
  for (let y = 0; y + th <= chh; y++) {
    let mean = 0
    for (let r = 0; r < th; r++) for (let c = 0; c < tw; c++) mean += canvas[(y + r) * cw + x0 + c]
    mean /= tpl.length
    let num = 0
    let den = 0
    for (let r = 0; r < th; r++)
      for (let c = 0; c < tw; c++) {
        const v = canvas[(y + r) * cw + x0 + c] - mean
        num += v * (tpl[r * tw + c] - tMean)
        den += v * v
      }
    const s = num / Math.sqrt(den * tVar + 1e-12)
    if (s > best) best = s
  }
  return best
}

describe.skipIf(!fixtureGate('synth', have))('S-3 スティッチ回帰(合成スクロール動画)', () => {
  const files = have ? readdirSync(join(DIR, 'frames')).filter((f) => /^t_\d+\.png$/.test(f)).sort() : []

  it(
    'cv2.phaseCorrelate とフレーム対ごとに一致し(fixed_top=154px)、最終高さも一致',
    () => {
      const ref: Pairs = JSON.parse(readFileSync(join(DIR, 'pairs_154.json'), 'utf8'))
      expect(files.length).toBe(ref.frames)
      let stitcher: Stitcher<Uint8Array> | null = null
      let comp: ArrayCompositor | null = null
      const gray = { buf: new Uint8Array(0) }
      for (const f of files) {
        const png = PNG.sync.read(readFileSync(join(DIR, 'frames', f)))
        const c = cropTop(png, ref.fixed_top)
        if (!stitcher) {
          comp = new ArrayCompositor(c.width, 4)
          // cv2 パリティは固定行推定なし(stitch.py と同条件)
          stitcher = new Stitcher<Uint8Array>(c.width, c.height, comp, 0, false, 1, false)
          gray.buf = new Uint8Array(c.width * c.height)
        }
        stitcher.push(rgbaToGrayCv(c.rgba, gray.buf), c.rgba)
      }
      const dec = stitcher!.decisions.slice(1)
      expect(dec.length).toBe(ref.pairs.length)
      const bad: string[] = []
      dec.forEach((d, i) => {
        const p = ref.pairs[i]
        if (Math.abs(d.dx - p.dx) > 0.05 || Math.abs(d.dy - p.dy) > 0.05 || Math.abs(d.response - p.resp) > 2e-3) {
          bad.push(`${i}: ts=(${d.dx.toFixed(3)}, ${d.dy.toFixed(3)}, ${d.response.toFixed(4)}) cv2=(${p.dx.toFixed(3)}, ${p.dy.toFixed(3)}, ${p.resp.toFixed(4)})`)
        }
      })
      expect(bad).toEqual([])
      expect(comp!.height).toBe(ref.height)
    },
    600_000,
  )

  it(
    '1/2 縮小相関(再判定なし)が cv2 の縮小版とフレーム対ごとに一致(fixed_top=153px)',
    () => {
      const ref = JSON.parse(readFileSync(join(DIR, 'pairs_153_scale2.json'), 'utf8')) as { fixed_top: number; scale: number; pairs: Array<{ dx: number; dy: number; resp: number }> }
      let stitcher: Stitcher<Uint8Array> | null = null
      let comp: ArrayCompositor | null = null
      let buf = new Uint8Array(0)
      for (const f of files) {
        const png = PNG.sync.read(readFileSync(join(DIR, 'frames', f)))
        const c = cropTop(png, ref.fixed_top)
        if (!stitcher) {
          comp = new ArrayCompositor(c.width, 4)
          stitcher = new Stitcher<Uint8Array>(c.width, c.height, comp, 0, false, ref.scale, false)
          buf = new Uint8Array(c.width * c.height)
        }
        stitcher.push(rgbaToGrayCv(c.rgba, buf), c.rgba)
      }
      const dec = stitcher!.decisions.slice(1)
      const bad: string[] = []
      dec.forEach((d, i) => {
        const p = ref.pairs[i]
        if (Math.abs(d.dx - p.dx) > 0.1 || Math.abs(d.dy - p.dy) > 0.1 || Math.abs(d.response - p.resp) > 2e-3) bad.push(`${i}: ts=(${d.dx.toFixed(3)}, ${d.dy.toFixed(3)}, ${d.response.toFixed(4)}) cv2=(${p.dx.toFixed(3)}, ${p.dy.toFixed(3)}, ${p.resp.toFixed(4)})`)
      })
      expect(bad).toEqual([])
    },
    600_000,
  )

  it(
    '相対座標 fixed_top=h×0.055 でスティッチし、正解画像に対して高さ誤差 ≤1%・バンド一致 ≥7/8',
    () => {
      const gt = PNG.sync.read(readFileSync(join(DIR, 'ground_truth.png')))
      let stitcher: Stitcher<Uint8Array> | null = null
      let comp: ArrayCompositor | null = null
      let grayBuf = new Uint8Array(0)
      for (const f of files) {
        const png = PNG.sync.read(readFileSync(join(DIR, 'frames', f)))
        const top = Math.trunc(png.height * STITCH_FIXED_TOP)
        const c = cropTop(png, top)
        if (!stitcher) {
          comp = new ArrayCompositor(c.width, 4)
          // 本番と同じ設定(固定行の自動推定あり・1/2 縮小+曖昧域は原寸再判定)
          stitcher = new Stitcher<Uint8Array>(c.width, c.height, comp)
          grayBuf = new Uint8Array(c.width * c.height)
        }
        stitcher.push(rgbaToGrayCv(c.rgba, grayBuf), c.rgba)
      }
      const canvasRGB = comp!.toRGB()
      const cw = comp!.width
      const chh = comp!.height
      const dh = Math.abs(gt.height - chh)
      expect(dh / gt.height).toBeLessThanOrEqual(0.01)

      // stitch.py validate: 正解画像の 8 バンド(120 行、x 100..w-100)がスティッチ結果に存在するか
      const canvasGray = toGray(canvasRGB, 3)
      const gtGray = toGray(new Uint8Array(gt.data.buffer, gt.data.byteOffset, gt.data.length), 4)
      const tw = gt.width - 200
      const th = 120
      let hit = 0
      const scores: number[] = []
      for (let i = 0; i < 8; i++) {
        const y = Math.trunc((gt.height * (i + 0.5)) / 8)
        const tpl = new Float64Array(tw * th)
        for (let r = 0; r < th; r++) for (let c = 0; c < tw; c++) tpl[r * tw + c] = gtGray[(y + r) * gt.width + 100 + c]
        const s = bestNcc(canvasGray, cw, chh, tpl, tw, th, 100)
        scores.push(s)
        if (s > 0.9) hit++
      }
      // eslint-disable-next-line no-console
      console.log(`stitched ${cw}x${chh} (gt ${gt.width}x${gt.height}, diff ${dh}px) bands=${hit}/8 scores=${scores.map((s) => s.toFixed(3)).join(' ')} fixedRows=${stitcher!.fixedRows} scales=${stitcher!.decisions.map((d) => d.scaleUsed ?? '-').join('')}`)
      expect(hit).toBeGreaterThanOrEqual(7)
    },
    600_000,
  )
})
