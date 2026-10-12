/**
 * Lossless block codec for PCM audio ("MCL1").
 *
 * Uses the same techniques as FLAC — fixed linear predictors (orders 0–4),
 * mid/side stereo decorrelation and Rice-coded residuals — but it is NOT the
 * FLAC bitstream format. Every block decodes to exactly the integer samples
 * that were encoded; when prediction doesn't help (e.g. white noise) a block
 * is stored verbatim, so output is never larger than raw PCM plus a header.
 *
 * Block layout (little-endian header, 16 bytes, then an MSB-first bitstream):
 *   0  'M' 'L'          magic
 *   2  u8   version (1)
 *   3  u8   flags       bit0 = mid/side, bit1 = verbatim
 *   4  u32  seq         sender block counter (gap detection)
 *   8  u32  sampleRate
 *   12 u8   channels    1..8
 *   13 u8   bitDepth    8..24
 *   14 u16  frames      1..8192
 * Per (decorrelated) channel: order u3 (7 = constant channel: one stored
 * value, used for digital silence), rice k u5, `order` warm-up samples as
 * signed (bitDepth + side?1:0)-bit values, then frames-order residuals
 * (zig-zag, Rice(k)). Verbatim blocks hold interleaved signed bitDepth-bit samples.
 */
export interface PcmBlock {
  seq: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  /** Interleaved integer samples, frames * channels long. */
  samples: Int32Array;
}

export const HEADER_BYTES = 16;
const VERSION = 1;
const FLAG_MID_SIDE = 1;
const FLAG_VERBATIM = 2;
const MAX_ORDER = 4;
/** Channel header order value meaning "every sample equals one stored value". */
const CONSTANT = 7;
const MAX_FRAMES = 8192;
const MAX_K = 30;

export class CodecError extends Error {
  override name = 'CodecError';
}

// ---- bit I/O -------------------------------------------------------------

class BitWriter {
  private buf: Uint8Array;
  private pos = 0; // bytes written
  private acc = 0; // pending bits (< 8 after flushing)
  private accBits = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(64, capacity));
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Writes the low `n` bits of `value` (n <= 24). */
  write(value: number, n: number): void {
    if (n === 0) return;
    this.acc = (this.acc * 2 ** n + (value & (2 ** n - 1))) >>> 0;
    this.accBits += n;
    this.ensure(4);
    while (this.accBits >= 8) {
      this.accBits -= 8;
      this.buf[this.pos++] = (this.acc >>> this.accBits) & 0xff;
    }
    this.acc &= (1 << this.accBits) - 1;
  }

  writeLarge(value: number, n: number): void {
    if (n > 24) {
      this.write(Math.floor(value / 2 ** 24), n - 24);
      this.write(value % 2 ** 24, 24);
    } else {
      this.write(value, n);
    }
  }

  writeUnary(q: number): void {
    // q zeros followed by a one
    while (q >= 24) {
      this.write(0, 24);
      q -= 24;
    }
    this.write(1, q + 1);
  }

  finish(): Uint8Array {
    if (this.accBits > 0) {
      this.ensure(1);
      this.buf[this.pos++] = (this.acc << (8 - this.accBits)) & 0xff;
      this.acc = 0;
      this.accBits = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

class BitReader {
  private bytePos: number;
  private bitPos = 0; // bits consumed in current byte

  constructor(
    private readonly buf: Uint8Array,
    start: number,
  ) {
    this.bytePos = start;
  }

  readBit(): number {
    if (this.bytePos >= this.buf.length) throw new CodecError('Truncated block');
    const bit = (this.buf[this.bytePos]! >>> (7 - this.bitPos)) & 1;
    if (++this.bitPos === 8) {
      this.bitPos = 0;
      this.bytePos++;
    }
    return bit;
  }

  read(n: number): number {
    let v = 0;
    while (n > 0) {
      if (this.bytePos >= this.buf.length) throw new CodecError('Truncated block');
      const avail = 8 - this.bitPos;
      const take = Math.min(avail, n);
      const bits = (this.buf[this.bytePos]! >>> (avail - take)) & ((1 << take) - 1);
      v = v * 2 ** take + bits;
      n -= take;
      this.bitPos += take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return v;
  }

  readSigned(n: number): number {
    const v = this.read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  readUnary(limit: number): number {
    let q = 0;
    while (this.readBit() === 0) {
      if (++q > limit) throw new CodecError('Corrupt residual');
    }
    return q;
  }
}

// ---- prediction ------------------------------------------------------------

function residuals(x: Int32Array, order: number, out: Int32Array): void {
  const n = x.length;
  for (let i = order; i < n; i++) {
    let e: number;
    switch (order) {
      case 0:
        e = x[i]!;
        break;
      case 1:
        e = x[i]! - x[i - 1]!;
        break;
      case 2:
        e = x[i]! - 2 * x[i - 1]! + x[i - 2]!;
        break;
      case 3:
        e = x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!;
        break;
      default:
        e = x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
    }
    out[i] = e;
  }
}

function restore(x: Int32Array, order: number): void {
  for (let i = order; i < x.length; i++) {
    switch (order) {
      case 0:
        break;
      case 1:
        x[i] = x[i]! + x[i - 1]!;
        break;
      case 2:
        x[i] = x[i]! + 2 * x[i - 1]! - x[i - 2]!;
        break;
      case 3:
        x[i] = x[i]! + 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!;
        break;
      default:
        x[i] = x[i]! + 4 * x[i - 1]! - 6 * x[i - 2]! + 4 * x[i - 3]! - x[i - 4]!;
    }
  }
}

const zigzag = (e: number) => (e >= 0 ? e * 2 : -e * 2 - 1);
const unzigzag = (u: number) => (u % 2 === 0 ? u / 2 : -(u + 1) / 2);

interface ChannelPlan {
  order: number;
  k: number;
  bits: number;
  res: Int32Array;
}

function riceBits(res: Int32Array, from: number, k: number): number {
  let bits = 0;
  const div = 2 ** k;
  for (let i = from; i < res.length; i++) bits += Math.floor(zigzag(res[i]!) / div) + 1 + k;
  return bits;
}

function planChannel(x: Int32Array, sampleBits: number): ChannelPlan {
  if (x.every((v) => v === x[0])) return { order: CONSTANT, k: 0, bits: 8 + sampleBits, res: x };
  let best: ChannelPlan | null = null;
  const maxOrder = Math.min(MAX_ORDER, x.length - 1);
  for (let order = 0; order <= maxOrder; order++) {
    const res = new Int32Array(x.length);
    residuals(x, order, res);
    let sum = 0;
    for (let i = order; i < x.length; i++) sum += zigzag(res[i]!);
    const count = Math.max(1, x.length - order);
    const mean = sum / count;
    const k0 = mean < 1 ? 0 : Math.min(MAX_K, Math.floor(Math.log2(mean)));
    for (const k of [k0 - 1, k0, k0 + 1]) {
      if (k < 0 || k > MAX_K) continue;
      const bits = 8 + order * sampleBits + riceBits(res, order, k);
      if (!best || bits < best.bits) best = { order, k, bits, res };
    }
  }
  return best!;
}

// ---- public API ------------------------------------------------------------

function validate(
  block: Pick<PcmBlock, 'channels' | 'bitDepth' | 'sampleRate'>,
  frames: number,
): void {
  const { channels, bitDepth, sampleRate } = block;
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw new CodecError('channels');
  if (!Number.isInteger(bitDepth) || bitDepth < 8 || bitDepth > 24)
    throw new CodecError('bitDepth');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384_000)
    throw new CodecError('sampleRate');
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES)
    throw new CodecError('frames');
}

export function encodeBlock(block: PcmBlock): Uint8Array<ArrayBuffer> {
  const { channels, bitDepth, samples } = block;
  const frames = samples.length / channels;
  validate(block, frames);
  const lo = -(2 ** (bitDepth - 1));
  const hi = 2 ** (bitDepth - 1) - 1;

  const planar: Int32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Int32Array(frames);
    for (let i = 0; i < frames; i++) {
      const v = samples[i * channels + c]!;
      if (v < lo || v > hi) throw new CodecError('Sample out of range for bit depth');
      ch[i] = v;
    }
    planar.push(ch);
  }

  // Try independent channels and, for stereo, mid/side; keep the smaller.
  let plans = planar.map((ch) => planChannel(ch, bitDepth));
  let midSide = false;
  if (channels === 2) {
    const mid = new Int32Array(frames);
    const side = new Int32Array(frames);
    for (let i = 0; i < frames; i++) {
      const l = planar[0]![i]!;
      const r = planar[1]![i]!;
      mid[i] = (l + r) >> 1;
      side[i] = l - r;
    }
    const ms = [planChannel(mid, bitDepth), planChannel(side, bitDepth + 1)];
    if (ms[0]!.bits + ms[1]!.bits < plans[0]!.bits + plans[1]!.bits) {
      plans = ms;
      midSide = true;
    }
  }

  const predictedBits = plans.reduce((a, p) => a + p.bits, 0);
  const verbatimBits = frames * channels * bitDepth;
  const verbatim = verbatimBits <= predictedBits;

  const w = new BitWriter(HEADER_BYTES + Math.ceil(Math.min(predictedBits, verbatimBits) / 8) + 8);
  const header = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(header.buffer);
  header[0] = 0x4d;
  header[1] = 0x4c;
  header[2] = VERSION;
  header[3] = (midSide && !verbatim ? FLAG_MID_SIDE : 0) | (verbatim ? FLAG_VERBATIM : 0);
  dv.setUint32(4, block.seq >>> 0, true);
  dv.setUint32(8, block.sampleRate, true);
  header[12] = channels;
  header[13] = bitDepth;
  dv.setUint16(14, frames, true);

  if (verbatim) {
    for (let i = 0; i < samples.length; i++) w.write(samples[i]!, bitDepth);
  } else {
    plans.forEach((p, c) => {
      const sampleBits = midSide && c === 1 ? bitDepth + 1 : bitDepth;
      const src = midSide ? null : planar[c]!;
      w.write(p.order, 3);
      w.write(p.k, 5);
      if (p.order === CONSTANT) {
        const v = src ? src[0]! : warmup(planar, c, 0);
        w.writeLarge(v < 0 ? v + 2 ** sampleBits : v, sampleBits);
        return;
      }
      for (let i = 0; i < p.order; i++) {
        // Warm-up samples are the original (or mid/side) values: recompute from residual base.
        const v = src ? src[i]! : warmup(planar, c, i);
        w.writeLarge(v < 0 ? v + 2 ** sampleBits : v, sampleBits);
      }
      const div = 2 ** p.k;
      for (let i = p.order; i < frames; i++) {
        const u = zigzag(p.res[i]!);
        w.writeUnary(Math.floor(u / div));
        w.writeLarge(u % div, p.k);
      }
    });
  }

  const body = w.finish();
  const out = new Uint8Array(HEADER_BYTES + body.length);
  out.set(header, 0);
  out.set(body, HEADER_BYTES);
  return out;
}

function warmup(planar: Int32Array[], c: number, i: number): number {
  const l = planar[0]![i]!;
  const r = planar[1]![i]!;
  return c === 0 ? (l + r) >> 1 : l - r;
}

export function peekHeader(bytes: Uint8Array): Omit<PcmBlock, 'samples'> & { frames: number } {
  if (bytes.length < HEADER_BYTES || bytes[0] !== 0x4d || bytes[1] !== 0x4c)
    throw new CodecError('Bad magic');
  if (bytes[2] !== VERSION) throw new CodecError('Unsupported version');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = {
    seq: dv.getUint32(4, true),
    sampleRate: dv.getUint32(8, true),
    channels: bytes[12]!,
    bitDepth: bytes[13]!,
    frames: dv.getUint16(14, true),
  };
  validate(meta, meta.frames);
  return meta;
}

export function decodeBlock(bytes: Uint8Array): PcmBlock {
  const meta = peekHeader(bytes);
  const { channels, bitDepth, frames } = meta;
  const flags = bytes[3]!;
  const out = new Int32Array(frames * channels);
  const r = new BitReader(bytes, HEADER_BYTES);

  if (flags & FLAG_VERBATIM) {
    for (let i = 0; i < out.length; i++) out[i] = r.readSigned(bitDepth);
    return { ...meta, samples: out };
  }

  const midSide = (flags & FLAG_MID_SIDE) !== 0;
  if (midSide && channels !== 2) throw new CodecError('mid/side requires stereo');
  const planar: Int32Array[] = [];
  const maxQuotient = 2 ** (bitDepth + 6);
  for (let c = 0; c < channels; c++) {
    const sampleBits = midSide && c === 1 ? bitDepth + 1 : bitDepth;
    const order = r.read(3);
    const k = r.read(5);
    if (order === CONSTANT) {
      planar.push(new Int32Array(frames).fill(r.readSigned(sampleBits)));
      continue;
    }
    if (order > MAX_ORDER || order > frames - 1 || k > MAX_K)
      throw new CodecError('Bad channel header');
    const x = new Int32Array(frames);
    for (let i = 0; i < Math.min(order, frames); i++) x[i] = r.readSigned(sampleBits);
    const div = 2 ** k;
    for (let i = order; i < frames; i++) {
      const q = r.readUnary(maxQuotient);
      x[i] = unzigzag(q * div + r.read(k));
    }
    restore(x, order);
    planar.push(x);
  }

  for (let i = 0; i < frames; i++) {
    if (midSide) {
      const mid = planar[0]![i]!;
      const side = planar[1]![i]!;
      const m = mid * 2 + (side & 1);
      out[i * 2] = (m + side) >> 1;
      out[i * 2 + 1] = (m - side) >> 1;
    } else {
      for (let c = 0; c < channels; c++) out[i * channels + c] = planar[c]![i]!;
    }
  }
  const lo = -(2 ** (bitDepth - 1));
  const hi = 2 ** (bitDepth - 1) - 1;
  for (let i = 0; i < out.length; i++) {
    if (out[i]! < lo || out[i]! > hi) throw new CodecError('Decoded sample out of range');
  }
  return { ...meta, samples: out };
}
