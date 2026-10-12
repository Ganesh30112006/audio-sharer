import { describe, expect, it } from 'vitest';
import { __test, CodecError, decodeBlock, encodeBlock } from '../../src/audio/lossless/codec';

const { BitWriter, BitReader } = __test;
let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

describe('bit I/O', () => {
  it('round-trips random fields of every width 1..30 across byte and word boundaries', () => {
    const ops: Array<[number, number]> = [];
    for (let i = 0; i < 20_000; i++) {
      const n = 1 + Math.floor(rnd() * 30);
      ops.push([Math.floor(rnd() * 2 ** n), n]);
    }
    const w = new BitWriter(new Uint8Array(8), 3); // tiny buffer forces growth; non-zero start offset
    for (const [v, n] of ops) w.writeLarge(v, n);
    const used = w.finish();
    const r = new BitReader(w.buffer.subarray(0, used), 3);
    for (const [v, n] of ops) expect(r.read(n)).toBe(v);
  });

  it('round-trips Rice codes for k = 0..30, including quotients far beyond one word', () => {
    const vals: Array<[number, number]> = [];
    for (let k = 0; k <= 30; k++) {
      for (const q of [0, 1, 7, 23, 24, 25, 31, 32, 33, 100, 1000]) {
        const rem = k ? Math.floor(rnd() * 2 ** k) : 0;
        const u = q * 2 ** k + rem;
        if (u < 2 ** 31) vals.push([u, k]);
      }
    }
    const w = new BitWriter(new Uint8Array(16), 0);
    for (const [u, k] of vals) w.writeRice(u, k);
    const used = w.finish();
    const r = new BitReader(w.buffer.subarray(0, used), 0);
    for (const [u, k] of vals) {
      const q = r.readUnary(1 << 30);
      expect(q * 2 ** k + r.read(k)).toBe(u);
    }
  });

  it('reads unary runs spanning many all-zero bytes (clz32 zero-window path)', () => {
    const w = new BitWriter(new Uint8Array(4), 0);
    for (const q of [0, 8, 31, 32, 33, 64, 200]) w.writeRice(q, 0);
    const used = w.finish();
    const r = new BitReader(w.buffer.subarray(0, used), 0);
    for (const q of [0, 8, 31, 32, 33, 64, 200]) expect(r.readUnary(1000)).toBe(q);
  });

  it('throws on truncation and on runaway unary codes instead of looping', () => {
    expect(() => new BitReader(new Uint8Array([0xff]), 0).read(9)).toThrow(CodecError);
    expect(() => new BitReader(new Uint8Array(16), 0).readUnary(1 << 20)).toThrow(CodecError);
    expect(() => new BitReader(new Uint8Array(16), 0).readUnary(50)).toThrow(/Corrupt/);
  });
});

describe('codec boundary signals', () => {
  const block = (frames: number, bits: number, gen: (i: number, c: number) => number) => {
    const s = new Int32Array(frames * 2);
    for (let i = 0; i < frames; i++) for (let c = 0; c < 2; c++) s[i * 2 + c] = gen(i, c);
    return { seq: 1, sampleRate: 48_000, channels: 2, bitDepth: bits, samples: s };
  };
  const max = (b: number) => 2 ** (b - 1) - 1;
  const cases: Array<[string, ReturnType<typeof block>]> = [
    [
      'lone full-scale spike in silence (huge quotient)',
      block(960, 24, (i) => (i === 500 ? max(24) : 0)),
    ],
    ['negative full-scale spike', block(960, 16, (i, c) => (i === 3 && c ? -max(16) - 1 : 0))],
    [
      'spike at block start and end',
      block(960, 24, (i) => (i === 0 || i === 959 ? -max(24) - 1 : 0)),
    ],
    [
      'square wave min/max (order-4 residuals near 2^28)',
      block(960, 24, (i) => (i % 2 ? max(24) : -max(24) - 1)),
    ],
    ['slow ramp then cliff', block(960, 24, (i) => (i < 900 ? i * 9000 : -max(24)))],
    ['5 frames (shortest planned block)', block(5, 16, (i) => i * 1000 - 2000)],
    ['9 frames', block(9, 24, (i, c) => (c ? i : -i) * 100_000)],
  ];
  it.each(cases)('round-trips: %s', (_n, b) => {
    expect(decodeBlock(encodeBlock(b)).samples).toEqual(b.samples);
  });

  it('round-trips a long stream block by block (buffer reuse across calls is safe)', () => {
    const frames = 2000;
    for (let blk = 0; blk < 300; blk++) {
      const b = block(frames, 24, (i, c) =>
        Math.round(Math.sin((blk * frames + i) * 0.003 + c) * 0.7 * max(24) + (rnd() - 0.5) * 50),
      );
      const enc = encodeBlock(b);
      const encAgain = encodeBlock(b);
      // Deterministic: no state leaks between calls through the reused scratch buffers.
      expect(enc.length).toBe(encAgain.length);
      let diff = 0;
      for (let i = 0; i < enc.length; i++) if (enc[i] !== encAgain[i]) diff++;
      const out = decodeBlock(enc).samples;
      for (let i = 0; i < out.length; i++) if (out[i] !== b.samples[i]) diff++;
      expect(diff).toBe(0);
    }
  }, 30_000);
});
