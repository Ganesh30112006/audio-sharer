import type { BrowserContext, Page } from '@playwright/test';

/**
 * Test-only instrumentation injected before the app loads. It observes audio
 * streams the app creates — never modifies them — and records wall-clock
 * onset times of tone bursts.
 *
 * - host: the MediaStreamAudioDestinationNode stream (pre-encode)
 * - listener: MediaStreams assigned to media elements (post-decode)
 *
 * Both pages run on the same machine, so performance.timeOrigin + now() is a
 * shared clock. ScriptProcessor (256 frames ≈ 5.3 ms at 48 kHz) adds the same
 * quantisation on both sides.
 */
export async function installOnsetProbe(
  ctx: BrowserContext,
  side: 'host' | 'listener',
): Promise<void> {
  await ctx.addInitScript((which: string) => {
    const w = window as unknown as { __onsets: number[]; __probed: Set<string> };
    w.__onsets = [];
    w.__probed = new Set();
    const probe = (stream: MediaStream) => {
      const track = stream.getAudioTracks()[0];
      if (!track || w.__probed.has(track.id)) return;
      w.__probed.add(track.id);
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(256, 1, 1);
      let above = false;
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
        if (!above && peak > 0.15) {
          above = true;
          w.__onsets.push(performance.timeOrigin + performance.now());
        } else if (above && peak < 0.02) {
          above = false;
        }
      };
      src.connect(proc);
      proc.connect(ctx.destination);
    };
    if (which === 'host') {
      const orig = AudioContext.prototype.createMediaStreamDestination;
      AudioContext.prototype.createMediaStreamDestination = function (this: AudioContext) {
        const dest = orig.call(this);
        queueMicrotask(() => probe(dest.stream));
        return dest;
      };
    } else {
      const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')!;
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        ...desc,
        set(this: HTMLMediaElement, v: MediaProvider | null) {
          desc.set!.call(this, v);
          if (v instanceof MediaStream) probe(v);
        },
      });
    }
  }, side);
}

export const readOnsets = (page: Page) =>
  page.evaluate(() => (window as unknown as { __onsets: number[] }).__onsets.slice());

/** Pair each listener onset with the latest host onset before it (within one period). */
export function pairLatencies(host: number[], listener: number[], maxMs = 900): number[] {
  const out: number[] = [];
  for (const l of listener) {
    let best: number | undefined;
    for (const h of host) if (h <= l && l - h < maxMs) best = h;
    if (best !== undefined) out.push(l - best);
  }
  return out;
}

export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
}
