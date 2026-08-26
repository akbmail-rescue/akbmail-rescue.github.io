import { describe, expect, it } from 'vitest'
import { demuxVideo, scanTopLevelBoxes } from '../../src/core/demux'

function box(type: string, payload = new Uint8Array(0)): Uint8Array {
  const b = new Uint8Array(8 + payload.length)
  new DataView(b.buffer).setUint32(0, b.length)
  b.set(new TextEncoder().encode(type), 4)
  b.set(payload, 8)
  return b
}

describe('demux: 想定外入力(F12)', () => {
  it('MP4 でないデータは例外になる(moov 無し)', async () => {
    const blob = new Blob([new Uint8Array(4096).fill(0x41)])
    await expect(demuxVideo(blob, { onTrack() {}, onSamples() {} })).rejects.toThrow()
  })
  it('空ファイルは例外になる', async () => {
    await expect(demuxVideo(new Blob([]), { onTrack() {}, onSamples() {} })).rejects.toThrow()
  })
  it('壊れたボックス長は例外になる', async () => {
    const bad = new Uint8Array(16)
    new DataView(bad.buffer).setUint32(0, 3) // size < 8
    bad.set(new TextEncoder().encode('ftyp'), 4)
    await expect(scanTopLevelBoxes(new Blob([bad]))).rejects.toThrow(/broken box/)
  })
  it('映像トラックの無い MP4(空の moov)は例外になる', async () => {
    const blob = new Blob([box('ftyp', new Uint8Array(8)), box('moov', box('mvhd', new Uint8Array(100)))])
    await expect(demuxVideo(blob, { onTrack() {}, onSamples() {} })).rejects.toThrow()
  })
  it('scanTopLevelBoxes は ftyp/mdat/moov の並びを返す', async () => {
    const blob = new Blob([box('ftyp', new Uint8Array(8)), box('mdat', new Uint8Array(100)), box('moov', new Uint8Array(20))])
    const boxes = await scanTopLevelBoxes(blob)
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov'])
    expect(boxes[1].size).toBe(108)
  })
})
