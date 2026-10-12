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
