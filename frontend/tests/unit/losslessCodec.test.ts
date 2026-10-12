import { describe, expect, it } from 'vitest';
import {
  CodecError,
  decodeBlock,
  encodeBlock,
  HEADER_BYTES,
  type PcmBlock,
} from '../../src/audio/lossless/codec';

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

function block(
  frames: number,
  channels: number,
  bitDepth: number,
  gen: (i: number, c: number) => number,
): PcmBlock {
  const samples = new Int32Array(frames * channels);
  const max = 2 ** (bitDepth - 1) - 1;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++)
      samples[i * channels + c] = Math.max(-max - 1, Math.min(max, Math.round(gen(i, c))));
  return { seq: 7, sampleRate: 48_000, channels, bitDepth, samples };
}

const music = (bits: number) => (i: number, c: number) =>
  (Math.sin(i * 0.031 + c) * 0.5 + Math.sin(i * 0.0071) * 0.3 + rand() * 0.01) * 2 ** (bits - 1);

describe('lossless codec', () => {
  const cases: Array<[string, PcmBlock]> = [
    ['16-bit stereo music-like', block(960, 2, 16, music(16))],
    ['24-bit stereo music-like', block(960, 2, 24, music(24))],
    ['16-bit white noise', block(960, 2, 16, () => rand() * 32767)],
    ['24-bit full-scale noise', block(1024, 2, 24, () => rand() * 8_388_607)],
    ['digital silence', block(960, 2, 16, () => 0)],
    ['extremes', block(64, 2, 16, (i) => (i % 2 ? 32767 : -32768))],
    ['hard-panned (L only)', block(480, 2, 16, (i, c) => (c === 0 ? Math.sin(i / 7) * 30000 : 0))],
    ['mono', block(960, 1, 16, music(16))],
    ['6 channels', block(256, 6, 16, music(16))],
    ['single frame', block(1, 2, 16, () => 1234)],
    ['DC offset, one channel silent', block(960, 2, 24, (_i, c) => (c ? 0 : -4_000_000))],
    ['two frames', block(2, 1, 24, (i) => (i ? -8_388_608 : 8_388_607))],
  ];

  it.each(cases)('round-trips bit-exactly: %s', (_name, b) => {
    const decoded = decodeBlock(encodeBlock(b));
    expect(decoded.seq).toBe(b.seq);
    expect(decoded.sampleRate).toBe(b.sampleRate);
    expect(decoded.channels).toBe(b.channels);
    expect(decoded.bitDepth).toBe(b.bitDepth);
    expect(decoded.samples).toEqual(b.samples);
  });

  it('compresses predictable audio and never grows noise beyond raw + header', () => {
    const tonal = block(960, 2, 16, music(16));
    const raw = 960 * 2 * 2;
    expect(encodeBlock(tonal).length).toBeLessThan(raw * 0.75);
    expect(encodeBlock(block(960, 2, 16, () => 0)).length).toBeLessThan(HEADER_BYTES + 20);
    const noise = block(960, 2, 16, () => rand() * 32767);
    expect(encodeBlock(noise).length).toBeLessThanOrEqual(raw + HEADER_BYTES + 1);
  });

  it('rejects out-of-range samples and invalid formats when encoding', () => {
    expect(() =>
      encodeBlock({ ...block(4, 1, 16, () => 0), samples: Int32Array.of(0, 40000, 0, 0) }),
    ).toThrow(CodecError);
    expect(() => encodeBlock({ ...block(4, 1, 16, () => 0), bitDepth: 32 })).toThrow(CodecError);
    expect(() => encodeBlock({ ...block(4, 2, 16, () => 0), samples: new Int32Array(3) })).toThrow(
      CodecError,
    );
  });

  it('rejects malformed input instead of producing garbage', () => {
    const good = encodeBlock(block(960, 2, 16, music(16)));
    expect(() => decodeBlock(new Uint8Array(4))).toThrow(CodecError);
    const badMagic = good.slice();
    badMagic[0] = 0;
    expect(() => decodeBlock(badMagic)).toThrow(CodecError);
    expect(() => decodeBlock(good.slice(0, good.length >> 1))).toThrow(CodecError);
    const badChannels = good.slice();
    badChannels[12] = 0;
    expect(() => decodeBlock(badChannels)).toThrow(CodecError);
  });

  it('encodes a second of 48 kHz stereo quickly enough for real time', () => {
    const blocks = Array.from({ length: 50 }, () => block(960, 2, 16, music(16)));
    const t0 = performance.now();
    for (const b of blocks) decodeBlock(encodeBlock(b));
    const ms = performance.now() - t0;
    // Generous bound for CI; typical is a few ms. Real-time needs < 1000 ms.
    expect(ms).toBeLessThan(250);
  });
});

describe('block sizing', () => {
  it('keeps every block under one data-channel message, even for hi-res', async () => {
    const { blockFramesFor } = await import('../../src/audio/lossless/LosslessSender');
    expect(blockFramesFor(44_100, 16)).toBe(882); // 20 ms
    expect(blockFramesFor(48_000, 24)).toBe(960); // 20 ms
    for (const [rate, bits] of [
      [96_000, 24],
      [192_000, 24],
      [384_000, 24],
    ] as const) {
      const frames = blockFramesFor(rate, bits);
      expect(frames * 2 * 3).toBeLessThanOrEqual(12_000);
      const worst = encodeBlock(block(frames, 2, bits, () => rand() * 8_388_607));
      expect(worst.length).toBeLessThan(15 * 1024);
    }
  });
});
