import type { ClassifiedFrame, SegmentSummary } from '../core/segment'
import type { DecoderStats } from '../core/decoder'
import type { VideoTrackInfo } from '../core/demux'

export interface OutputItem {
  kind: 'mail' | 'image'
  name: string
  blob: Blob
  seg: number
  index: number
  t: number
  bm: number
  hash: string
  fromStable: boolean
  width: number
  height: number
  /** S-3: スクロールをスティッチした結果か(false なら代表フレーム) */
  stitched: boolean
  /** スティッチで採用したフレーム数 */
  stitchAccepted: number
  /** 複数パートに分割された場合のパート番号(1 始まり)/総数 */
  part?: { index: number; total: number }
}

export type WorkerRequest = { type: 'analyze'; file: File; assetBase: string }

export type WorkerResponse =
  | { type: 'track'; info: Omit<VideoTrackInfo, 'description'>; supported: boolean }
  | { type: 'unsupported'; codec: string; message: string }
  | { type: 'frame'; frame: ClassifiedFrame }
  | { type: 'boundary_rise'; frame: ClassifiedFrame; riseCount: number }
  | { type: 'segment_closed'; id: number; tStart: number; tEnd: number; frames: number; indexStart: number; indexEnd: number }
  | { type: 'ocr'; seg: number; index: number; attempt: number; timestamp: string | null; sender: string | null; rawTimestamp: string; rawSender: string }
  | { type: 'progress'; bytesRead: number; bytesTotal: number; sampled: number; retainedFrames: number }
  | { type: 'done'; summary: SegmentSummary; stats: DecoderStats; elapsedMs: number; path: 'webcodecs' | 'ffmpeg.wasm'; outputs: { mails: number; images: number; skipped: number; peakRetainedImages: number; stitchedMails: number; stitchMsPerFrame: number } }
  | { type: 'stage'; stage: string }
  | { type: 'output'; item: OutputItem }
  | { type: 'skipped'; what: 'mail' | 'image'; reason: string; seg: number; index: number; t: number; hash: string }
  | { type: 'error'; message: string }
