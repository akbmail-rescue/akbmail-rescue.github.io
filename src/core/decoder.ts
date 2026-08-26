/**
 * WebCodecs VideoDecoder のラッパ。
 * - サンプルを EncodedVideoChunk として投入し、decodeQueueSize と open フレーム数でバックプレッシャをかける
 * - 出力 VideoFrame は FpsSampler で 6fps に間引き(ffmpeg fps=6 と同一規則)、採用フレームだけ onSampled に渡す
 * - VideoFrame はサンプラが解放を指示した時点(onSampled 完了後)に必ず close する。
 *   同時に open なフレームは held 1 枚+処理待ち分のみで、MAX_OPEN_FRAMES を超えたら投入を止める(INV-2)
 */
import { FpsSampler } from './sampler'
import { MAX_RETAINED_FRAMES } from './regions'
import type { Sample } from 'mp4box'
import type { VideoTrackInfo } from './demux'

export interface SampledFrame {
  /** 6fps 列でのインデックス(ffmpeg fps=6 の出力番号と一致) */
  slot: number
  /** 秒 */
  t: number
  frame: VideoFrame
}

export interface DecoderStats {
  decoded: number
  sampled: number
  /** 同時に open だった VideoFrame の最大数(INV-2 の実証用) */
  peakRetainedFrames: number
}

const MAX_DECODE_QUEUE = 8
/** open フレームがこれ以上なら投入を待つ。デコーダ内部キュー分を足しても INV-2 の 30 を超えない値 */
const MAX_OPEN_FRAMES = 16

export function hasWebCodecs(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

export function buildDecoderConfig(info: VideoTrackInfo): VideoDecoderConfig {
  return {
    codec: info.codec,
    codedWidth: info.codedWidth,
    codedHeight: info.codedHeight,
    description: info.description,
    // 画素を読むだけなので GPU 経路は要求しない(環境差を減らす)
    hardwareAcceleration: 'no-preference',
  }
}

export class SampledVideoDecoder {
  private decoder: VideoDecoder
  private sampler: FpsSampler<VideoFrame>
  private stats: DecoderStats = { decoded: 0, sampled: 0, peakRetainedFrames: 0 }
  private open = 0
  private chain: Promise<void> = Promise.resolve()
  private failed: Error | null = null
  private waiters: Array<() => void> = []

  constructor(
    config: VideoDecoderConfig,
    private readonly fps: number,
    private readonly onSampled: (f: SampledFrame) => void | Promise<void>,
  ) {
    if (MAX_OPEN_FRAMES + MAX_DECODE_QUEUE > MAX_RETAINED_FRAMES) throw new Error('frame budget exceeds INV-2')
    this.sampler = new FpsSampler<VideoFrame>(fps)
    this.decoder = new VideoDecoder({
      output: (frame) => this.handleOutput(frame),
      error: (e) => {
        this.failed = e instanceof Error ? e : new Error(String(e))
        this.wake()
      },
    })
    this.decoder.configure(config)
    this.decoder.addEventListener('dequeue', () => this.wake())
  }

  private wake() {
    const w = this.waiters
    this.waiters = []
    for (const fn of w) fn()
  }

  private track(frame: VideoFrame) {
    this.open++
    if (this.open > this.stats.peakRetainedFrames) this.stats.peakRetainedFrames = this.open
    void frame
  }

  private handleOutput(frame: VideoFrame) {
    this.stats.decoded++
    this.track(frame)
    const out = this.sampler.push(frame.timestamp, frame.duration ?? 0, frame)
    this.schedule(out.emit, out.release)
  }

  /** emit を直列に処理し、その後 release フレームを close する。 */
  private schedule(emit: Array<{ slot: number; item: VideoFrame }>, release: VideoFrame | null) {
    for (const { slot, item } of emit) {
      this.stats.sampled++
      this.chain = this.chain
        .then(() => this.onSampled({ slot, t: slot / this.fps, frame: item }))
        .catch((e) => {
          this.failed = e instanceof Error ? e : new Error(String(e))
        })
    }
    if (release) {
      this.chain = this.chain.finally(() => {
        release.close()
        this.open--
        this.wake()
      })
    }
  }

  /** デマックスされたサンプルを投入する。キューが上限に達していれば空くまで待つ。 */
  async feed(samples: Sample[]): Promise<void> {
    for (const s of samples) {
      while ((this.decoder.decodeQueueSize >= MAX_DECODE_QUEUE || this.open >= MAX_OPEN_FRAMES) && !this.failed) {
        await new Promise<void>((r) => this.waiters.push(r))
      }
      if (this.failed) throw this.failed
      if (!s.data) throw new Error(`sample ${s.number} has no data`)
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((s.cts * 1e6) / s.timescale),
          duration: Math.round((s.duration * 1e6) / s.timescale),
          data: s.data,
        }),
      )
    }
  }

  /** 残りをフラッシュし、全 onSampled の完了を待つ。 */
  async finish(): Promise<DecoderStats> {
    await this.decoder.flush()
    const out = this.sampler.flush()
    this.schedule(out.emit, out.release)
    await this.chain
    if (this.failed) throw this.failed
    this.decoder.close()
    return { ...this.stats }
  }

  abort() {
    try {
      this.decoder.close()
    } catch {
      /* already closed */
    }
  }
}
