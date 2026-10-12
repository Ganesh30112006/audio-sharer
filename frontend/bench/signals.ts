/** Deterministic test signals (integer PCM, interleaved stereo). */
export type SignalName = 'silence' | 'impulses' | 'music' | 'noise' | 'extremes';

export function makeSignal(
  name: SignalName,
  frames: number,
  sampleRate: number,
  bitDepth: number,
): Int32Array {
  const out = new Int32Array(frames * 2);
  const max = 2 ** (bitDepth - 1) - 1;
  const min = -max - 1;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < frames; i++) {
    let l = 0;
    let r = 0;
    const t = i / sampleRate;
    switch (name) {
      case 'silence':
        break;
      case 'impulses':
        // Sparse full-scale clicks: worst case for long Rice quotients.
        if (i % 4801 === 0) l = r = i % 2 ? max : min;
        break;
      case 'music': {
        const base =
          0.3 * Math.sin(2 * Math.PI * 220 * t) +
          0.15 * Math.sin(2 * Math.PI * 331 * t + 1) +
          0.08 * Math.sin(2 * Math.PI * 1763 * t) +
          0.04 * Math.sin(2 * Math.PI * 5200 * t);
        // Noise floor ~ -60 dBFS, like a real recording.
        l = Math.round((base + 0.001 * rand()) * max);
        r = Math.round(
          (0.85 * base + 0.03 * Math.sin(2 * Math.PI * 97 * t) + 0.001 * rand()) * max,
        );
        break;
      }
      case 'noise':
        l = Math.round(rand() * max);
        r = Math.round(rand() * max);
        break;
      case 'extremes':
        l = i % 2 ? max : min;
        r = i % 3 ? min : max;
        break;
    }
    out[i * 2] = l;
    out[i * 2 + 1] = r;
  }
  return out;
}
