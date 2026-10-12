/**
 * Reads the native sample rate / bit depth of lossless files from their
 * headers so the lossless transport can run without resampling or
 * re-quantising. Lossy formats (MP3, AAC, Opus…) have no "original" PCM; they
 * are carried at 24-bit / 48 kHz, which preserves the browser decoder's output.
 */
export interface SourceFormat {
  sampleRate: number;
  bitDepth: number;
  /** True when the file itself stores integer PCM (WAV/FLAC/AIFF-like). */
  integerPcm: boolean;
}

export const DEFAULT_FORMAT: SourceFormat = { sampleRate: 48_000, bitDepth: 24, integerPcm: false };

const SUPPORTED_RATES = new Set([
  8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
]);

export function parseFormat(bytes: Uint8Array): SourceFormat | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let o = 12;
    while (o + 8 <= bytes.length) {
      const id = tag(o);
      const size = dv.getUint32(o + 4, true);
      if (id === 'fmt ' && o + 24 <= bytes.length) {
        let format = dv.getUint16(o + 8, true);
        const sampleRate = dv.getUint32(o + 12, true);
        const bits = dv.getUint16(o + 22, true);
        if (format === 0xfffe && o + 34 <= bytes.length) format = dv.getUint16(o + 32, true);
        if (format !== 1) return { sampleRate, bitDepth: 24, integerPcm: false }; // float/compressed WAV
        return { sampleRate, bitDepth: Math.min(24, Math.max(8, bits)), integerPcm: bits <= 24 };
      }
      o += 8 + size + (size % 2);
    }
    return null;
  }
  if (bytes.length >= 22 && tag(0) === 'fLaC') {
    // STREAMINFO is always the first metadata block.
    const b = (i: number) => bytes[i]!;
    const sampleRate = (b(18) << 12) | (b(19) << 4) | (b(20) >> 4);
    const bits = (((b(20) & 1) << 4) | (b(21) >> 4)) + 1;
    return { sampleRate, bitDepth: Math.min(24, bits), integerPcm: bits <= 24 };
  }
  return null;
}

export async function probeFormat(file: Blob): Promise<SourceFormat> {
  try {
    const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
    const f = parseFormat(head);
    if (f && SUPPORTED_RATES.has(f.sampleRate)) return f;
  } catch {
    // unreadable header: fall through
  }
  return DEFAULT_FORMAT;
}
