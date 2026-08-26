/**
 * MP4 デマックス(mp4box.js、npm 同梱・セルフホスト)。
 * ファイルを一括で読み込まず、Blob.slice でチャンク単位に appendBuffer する(INV-2)。
 * iOS 画面収録は moov が末尾にあるため、先に最上位ボックスを走査して moov だけを先読みし、
 * その後 mdat を先頭からチャンク供給する。mp4box は fileStart 付きの順不同 append を扱える。
 */
import { createFile, DataStream, Endianness, MP4BoxBuffer, type ISOFile, type Movie, type Sample } from 'mp4box'

export interface VideoTrackInfo {
  trackId: number
  codec: string
  codedWidth: number
  codedHeight: number
  timescale: number
  durationSec: number
  nbSamples: number
  /** avcC / hvcC 等のデコーダ設定ボックス本体(box ヘッダー 8 byte を除いたもの) */
  description: Uint8Array | undefined
}

export interface DemuxHandlers {
  onTrack(info: VideoTrackInfo): void | Promise<void>
  /** サンプル(=エンコード済みフレーム)が取り出されるたびに呼ばれる。返す Promise が解決するまで次のチャンクを読まない。 */
  onSamples(samples: Sample[]): void | Promise<void>
  onProgress?(bytesRead: number, bytesTotal: number): void
}

interface TopLevelBox {
  type: string
  offset: number
  size: number
}

/** 最上位ボックス(ftyp/mdat/moov ...)のオフセットとサイズを走査する。 */
export async function scanTopLevelBoxes(file: Blob): Promise<TopLevelBox[]> {
  const boxes: TopLevelBox[] = []
  let off = 0
  while (off + 8 <= file.size) {
    const head = new DataView(await file.slice(off, Math.min(off + 16, file.size)).arrayBuffer())
    let size = head.getUint32(0)
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7))
    if (size === 1) {
      // 64bit largesize
      size = Number(head.getBigUint64(8))
    } else if (size === 0) {
      size = file.size - off
    }
    if (size < 8) throw new Error(`broken box at ${off}: size=${size}`)
    boxes.push({ type, offset: off, size })
    off += size
  }
  return boxes
}

function extractDescription(isoFile: ISOFile, trackId: number): Uint8Array | undefined {
  const trak = isoFile.getTrackById(trackId)
  const entries = (trak as unknown as { mdia: { minf: { stbl: { stsd: { entries: Array<Record<string, unknown>> } } } } })
    .mdia.minf.stbl.stsd.entries
  for (const entry of entries) {
    const box = (entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C) as
      | { write(stream: DataStream): void }
      | undefined
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
      box.write(stream)
      return new Uint8Array(stream.buffer, 8) // box header (size + type) を除く
    }
  }
  return undefined
}

const CHUNK_SIZE = 4 * 1024 * 1024

/**
 * 動画ファイルをデマックスし、映像トラックのサンプルを順に handlers.onSamples へ渡す。
 * handlers.onSamples の Promise を待ってから次のチャンクを読むことでバックプレッシャをかける。
 */
export async function demuxVideo(file: Blob, handlers: DemuxHandlers): Promise<void> {
  const isoFile = createFile()
  let trackInfo: VideoTrackInfo | null = null
  let pending: Sample[] = []
  let error: Error | null = null

  isoFile.onError = (module, message) => {
    error = new Error(`mp4box ${module}: ${message}`)
  }
  isoFile.onReady = (info: Movie) => {
    const v = info.videoTracks[0]
    if (!v || !v.video) {
      error = new Error('映像トラックが見つかりません')
      return
    }
    trackInfo = {
      trackId: v.id,
      codec: v.codec,
      codedWidth: v.video.width,
      codedHeight: v.video.height,
      timescale: v.timescale,
      durationSec: v.duration / v.timescale,
      nbSamples: v.nb_samples,
      description: extractDescription(isoFile, v.id),
    }
    isoFile.setExtractionOptions(v.id, undefined, { nbSamples: 30 })
    isoFile.start()
  }
  let lastSampleNumber = -1
  let samplesSeen = 0
  isoFile.onSamples = (_id, _user, samples) => {
    // seek 後に mp4box が同じサンプルを再抽出することがあるため、番号で重複を落とす
    for (const s of samples) {
      if (s.number <= lastSampleNumber) continue
      lastSampleNumber = s.number
      samplesSeen++
      pending.push(s)
    }
  }

  const append = async (start: number, end: number): Promise<number> => {
    const ab = await file.slice(start, end).arrayBuffer()
    const next = isoFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, start))
    if (error) throw error
    return next
  }
  const drain = async () => {
    if (pending.length === 0 || !trackInfo) return
    const batch = pending
    pending = []
    await handlers.onSamples(batch)
    // 取り出し済みサンプルのデータを mp4box 内部バッファから解放する
    isoFile.releaseUsedSamples(trackInfo.trackId, batch[batch.length - 1].number)
  }

  // mp4box は先頭から逐次パースし、appendBuffer の戻り値で「次に必要なファイル位置」を返す。
  // moov が末尾にある iOS 録画では mdat をスキップして moov の位置が返るので、それに従って読む。
  // moov 解析後(onReady)は seek(0) で最初のサンプル位置に戻り、mdat を順に供給する。
  const trace: string[] = []
  let pos = 0
  let trackReported = false
  let bytesRead = 0
  while (pos < file.size) {
    const end = Math.min(pos + CHUNK_SIZE, file.size)
    const next = await append(pos, end)
    trace.push(`${pos}-${end}->${next}`)
    bytesRead += end - pos
    handlers.onProgress?.(Math.min(bytesRead, file.size), file.size)
    if (trackInfo && !trackReported) {
      trackReported = true
      await handlers.onTrack(trackInfo)
      await drain()
      if (samplesSeen === 0) {
        // moov が末尾にあり mdat を飛ばして来た場合: 最初のサンプル位置へ戻る
        const s = isoFile.seek(0, true)
        console.debug('[demux] moov parsed, seek ->', s.offset)
        pos = s.offset < file.size ? s.offset : 0
        continue
      }
    }
    await drain()
    pos = next > end ? next : end
  }
  if (!trackInfo) throw new Error(`moov を解析できませんでした(MP4 ではない、または破損) trace=${trace.join(' ')} size=${file.size}`)
  isoFile.flush()
  await drain()
}
