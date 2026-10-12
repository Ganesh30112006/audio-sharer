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
