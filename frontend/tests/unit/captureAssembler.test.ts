import { describe, expect, it } from 'vitest';
import { BlockAssembler, type CapturedBlock } from '../../src/audio/lossless/captureAssembler';

const BITS = 16;
const SCALE = 2 ** (BITS - 1);
const BLOCK = 8;

/** Deterministic integer sample for (timeline frame, channel, layout). */
const val = (frame: number, ch: number, layout: number) =>
  ((frame * 31 + ch * 7 + layout * 1000) % 30000) - 15000;

type Step =
  | { kind: 'audio'; frames: number; channels: number }
  | { kind: 'inactive'; frames: number }
  | { kind: 'skip'; frames: number };

/** Feeds quanta of `quantum` frames following the script; returns emitted blocks and the expected per-frame truth. */
function run(script: Step[], quantum = 1) {
  const blocks: CapturedBlock[] = [];
  const asm = new BlockAssembler(BLOCK, BITS, (b) => blocks.push(b));
  const truth = new Map<number, { channels: number; values: number[] }>(); // timeline frame -> expected
  let frame = 1000;
  let channels = 0;
  for (const step of script) {
    if (step.kind === 'skip') {
      frame += step.frames; // engine never calls process() for these
      continue;
    }
    for (let done = 0; done < step.frames; done += quantum) {
      const len = Math.min(quantum, step.frames - done);
      if (step.kind === 'audio') {
        channels = step.channels;
        const input = Array.from({ length: channels }, (_, c) =>
          Float32Array.from({ length: len }, (_, i) => val(frame + i, c, channels) / SCALE),
        );
        for (let i = 0; i < len; i++)
          truth.set(frame + i, { channels, values: input.map((ch) => Math.round(ch[i]! * SCALE)) });
        asm.push(input, frame, len);
      } else {
        if (channels > 0)
          for (let i = 0; i < len; i++)
            truth.set(frame + i, { channels, values: Array(channels).fill(0) });
        asm.push(null, frame, len);
      }
      frame += len;
    }
  }
  asm.finish();
  return { blocks, truth, asm };
}

function verify({ blocks, truth }: ReturnType<typeof run>, expectedGaps: number[]) {
  let emitted = 0;
  let prevEnd: number | null = null;
  const gaps: number[] = [];
  for (const b of blocks) {
    const frames = b.samples.length / b.channels;
    expect(Number.isInteger(frames)).toBe(true);
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(BLOCK);
    // Continuity: any jump must be explained by gapBefore.
    if (prevEnd !== null) expect(b.frame - prevEnd).toBe(b.gapBefore);
    if (b.gapBefore) gaps.push(b.gapBefore);
    for (let i = 0; i < frames; i++) {
      const t = truth.get(b.frame + i);
      expect(t, `frame ${b.frame + i} emitted but never fed`).toBeDefined();
      expect(t!.channels, 'no mixed layouts within a block').toBe(b.channels);
      for (let c = 0; c < b.channels; c++) expect(b.samples[i * b.channels + c]).toBe(t!.values[c]);
    }
    emitted += frames;
    prevEnd = b.frame + frames;
  }
  expect(emitted, 'every fed frame emitted exactly once').toBe(truth.size);
  expect(gaps).toEqual(expectedGaps);
}

describe('BlockAssembler', () => {
  it('emits full blocks for steady stereo input with any quantum size', () => {
    for (const q of [1, 3, 8, 128])
      verify(run([{ kind: 'audio', frames: 300, channels: 2 }], q), []);
  });

  it('channel-layout change at every offset within a block never loses or mixes frames', () => {
    for (let offset = 0; offset < BLOCK; offset++) {
      // offset = BLOCK-1 is "one frame before the block fills".
      const r = run([
        { kind: 'audio', frames: BLOCK * 3 + offset, channels: 2 },
        { kind: 'audio', frames: BLOCK * 2 + 3, channels: 1 },
        { kind: 'audio', frames: BLOCK + 5, channels: 6 },
      ]);
      verify(r, []);
      expect(r.asm.layoutChanges).toBe(2);
    }
  });

  it('timeline gap at every offset is reported, never hidden', () => {
    for (let offset = 0; offset < BLOCK; offset++) {
      const r = run([
        { kind: 'audio', frames: BLOCK * 2 + offset, channels: 2 },
        { kind: 'skip', frames: 512 },
        { kind: 'audio', frames: BLOCK * 2, channels: 2 },
      ]);
      verify(r, [512]);
      expect(r.asm.unseenFrames).toBe(512);
    }
  });

  it('inactive input before start is ignored; after start it is captured as silence', () => {
    const r = run([
      { kind: 'inactive', frames: 50 },
      { kind: 'audio', frames: 20, channels: 2 },
      { kind: 'inactive', frames: 13 },
      { kind: 'audio', frames: 20, channels: 2 },
    ]);
    verify(r, []);
    expect(r.blocks[0]!.gapBefore).toBe(0);
  });

  it('gap combined with a layout change in the same place', () => {
    const r = run([
      { kind: 'audio', frames: 11, channels: 2 },
      { kind: 'skip', frames: 128 },
      { kind: 'audio', frames: 9, channels: 1 },
    ]);
    verify(r, [128]);
  });

  it('finish() flushes the final partial block', () => {
    const r = run([{ kind: 'audio', frames: BLOCK + 3, channels: 2 }]);
    expect(r.blocks.map((b) => b.samples.length / b.channels)).toEqual([BLOCK, 3]);
  });

  it('clips out-of-range floats to the integer range', () => {
    const blocks: CapturedBlock[] = [];
    const asm = new BlockAssembler(2, 16, (b) => blocks.push(b));
    asm.push([Float32Array.of(2, -2)], 0, 2);
    expect(Array.from(blocks[0]!.samples)).toEqual([32767, -32768]);
  });
});
