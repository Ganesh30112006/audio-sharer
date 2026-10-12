import { describe, expect, it } from 'vitest';
import { parseFormat } from '../../src/media/audioFormat';

function wavHeader(rate: number, bits: number, format = 1): Uint8Array {
  const b = new Uint8Array(44);
  const dv = new DataView(b.buffer);
  b.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  b.set(
    [...'WAVE'].map((c) => c.charCodeAt(0)),
    8,
  );
  b.set(
    [...'fmt '].map((c) => c.charCodeAt(0)),
    12,
  );
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, 2, true);
  dv.setUint32(24, rate, true);
  dv.setUint16(34, bits, true);
  return b;
}

function flacHeader(rate: number, bits: number, channels = 2): Uint8Array {
  const b = new Uint8Array(42);
  b.set(
    [...'fLaC'].map((c) => c.charCodeAt(0)),
    0,
  );
  b[18] = (rate >> 12) & 0xff;
  b[19] = (rate >> 4) & 0xff;
  b[20] = ((rate & 0xf) << 4) | ((channels - 1) << 1) | (((bits - 1) >> 4) & 1);
  b[21] = ((bits - 1) & 0xf) << 4;
  return b;
}

describe('parseFormat', () => {
  it('reads WAV PCM rate and bit depth', () => {
    expect(parseFormat(wavHeader(44100, 16))).toEqual({
      sampleRate: 44100,
      bitDepth: 16,
      integerPcm: true,
    });
    expect(parseFormat(wavHeader(96000, 24))).toEqual({
      sampleRate: 96000,
      bitDepth: 24,
      integerPcm: true,
    });
  });
  it('marks float WAV as not integer PCM', () => {
    expect(parseFormat(wavHeader(48000, 32, 3))).toEqual({
      sampleRate: 48000,
      bitDepth: 24,
      integerPcm: false,
    });
  });
  it('reads FLAC STREAMINFO', () => {
    expect(parseFormat(flacHeader(44100, 16))).toEqual({
      sampleRate: 44100,
      bitDepth: 16,
      integerPcm: true,
    });
    expect(parseFormat(flacHeader(192000, 24))).toEqual({
      sampleRate: 192000,
      bitDepth: 24,
      integerPcm: true,
    });
  });
  it('returns null for other formats', () => {
    expect(parseFormat(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
