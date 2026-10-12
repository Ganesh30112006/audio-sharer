/** Generates a 16-bit PCM stereo WAV with a sine tone (test fixture, no binaries in git). */
export function sineWav(seconds: number, freq = 440, sampleRate = 48_000, amplitude = 0.4): Buffer {
  const channels = 2;
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude * 32767);
    buf.writeInt16LE(v, o);
    buf.writeInt16LE(v, o + 2);
    o += 4;
  }
  return buf;
}

/** Silence with short tone bursts every `periodS` seconds — onsets are easy to detect. */
export function burstWav(seconds: number, periodS = 1, burstS = 0.05, sampleRate = 48_000): Buffer {
  const tone = sineWav(seconds, 1000, sampleRate, 0.6);
  const frames = Math.floor(seconds * sampleRate);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    if (t % periodS >= burstS) {
      tone.writeInt16LE(0, 44 + i * 4);
      tone.writeInt16LE(0, 44 + i * 4 + 2);
    }
  }
  return tone;
}

/** Uncorrelated stereo white noise — worst case for the encoder, so it shows the real bitrate ceiling. */
export function noiseWav(seconds: number, sampleRate = 48_000, amplitude = 0.3): Buffer {
  const buf = sineWav(seconds, 440, sampleRate, 0);
  const frames = Math.floor(seconds * sampleRate);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < frames * 2; i++)
    buf.writeInt16LE(Math.round(rand() * amplitude * 32767), 44 + i * 2);
  return buf;
}

/** Deterministic "music-like" stereo signal (harmonics + a little noise) as integer PCM WAV (16 or 24-bit). */
export function musicWav(
  seconds: number,
  sampleRate = 44_100,
  bitDepth: 16 | 24 = 16,
): { wav: Buffer; pcm: Int32Array } {
  const frames = Math.floor(seconds * sampleRate);
  const pcm = new Int32Array(frames * 2);
  const full = 2 ** (bitDepth - 1) - 1;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const base =
      0.3 * Math.sin(2 * Math.PI * 220 * t) +
      0.15 * Math.sin(2 * Math.PI * 330 * t + 1) +
      0.1 * Math.sin(2 * Math.PI * 1760 * t);
    pcm[i * 2] = Math.round((base + 0.02 * rand()) * full);
    pcm[i * 2 + 1] = Math.round(
      (0.8 * base + 0.05 * Math.sin(2 * Math.PI * 97 * t) + 0.02 * rand()) * full,
    );
  }
  const bytesPer = bitDepth / 8;
  const dataBytes = pcm.length * bytesPer;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2 * bytesPer, 28);
  wav.writeUInt16LE(2 * bytesPer, 32);
  wav.writeUInt16LE(bitDepth, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) wav.writeIntLE(pcm[i]!, 44 + i * bytesPer, bytesPer);
  return { wav, pcm };
}
