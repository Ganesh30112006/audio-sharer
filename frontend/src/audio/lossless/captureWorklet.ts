/**
 * Long-lived capture processor (one per AudioContext). start/stop arrive as
 * generations; every emitted block is tagged with its generation so the owner
 * can reject anything that is not the active one. Converts float samples to
 * integers at the source bit depth (exact for integer-PCM sources) and hands
 * blocks over with postMessage, which never blocks the audio thread.
 */
import { BlockAssembler, type CapturedBlock } from './captureAssembler';

type Control = { cmd: 'start'; gen: number; bitDepth: number; blockFrames: number } | { cmd: 'stop'; gen: number };

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private asm: BlockAssembler | null = null;
  private gen = 0;
  private lastReport = 0;
  private totals = { quanta: 0, unseenFrames: 0, inactiveQuanta: 0, layoutChanges: 0 };

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    this.port.onmessage = (e: MessageEvent<Control>) => {
      const m = e.data;
      if (m.cmd === 'start') {
        this.finish();
        const gen = m.gen;
        this.gen = gen;
        this.asm = new BlockAssembler(m.blockFrames, m.bitDepth, (b: CapturedBlock) =>
          this.port.postMessage({ ...b, gen }, [b.samples.buffer]),
        );
      } else if (m.cmd === 'stop' && m.gen === this.gen) {
        this.finish();
      }
    };
  }

  /** Flush the generation's last partial block (tagged with its generation) and stop capturing. */
  private finish(): void {
    const a = this.asm;
    if (!a) return;
    a.finish();
    this.totals.quanta += a.quanta;
    this.totals.unseenFrames += a.unseenFrames;
    this.totals.inactiveQuanta += a.inactiveQuanta;
    this.totals.layoutChanges += a.layoutChanges;
    this.asm = null;
  }

  process(inputs: Float32Array[][]): boolean {
    const a = this.asm;
    if (a) {
      const input = inputs[0] ?? null;
      a.push(input, currentFrame, input?.[0]?.length ?? 128);
    }
    if (currentFrame - this.lastReport >= sampleRate) {
      this.lastReport = currentFrame;
      const t = this.totals;
      this.port.postMessage({
        diag: {
          quanta: t.quanta + (a?.quanta ?? 0),
          unseenFrames: t.unseenFrames + (a?.unseenFrames ?? 0),
          inactiveQuanta: t.inactiveQuanta + (a?.inactiveQuanta ?? 0),
          layoutChanges: t.layoutChanges + (a?.layoutChanges ?? 0),
        },
      });
    }
    return true; // long-lived: kept for the context's lifetime
  }
}

registerProcessor('mc-pcm-capture', PcmCaptureProcessor);
