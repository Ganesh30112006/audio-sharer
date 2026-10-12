/**
 * Lossless block codec for PCM audio ("MCL1").
 *
 * Uses the same techniques as FLAC — fixed linear predictors (orders 0–4),
 * mid/side stereo decorrelation and Rice-coded residuals — but it is NOT the
 * FLAC bitstream format. Every block decodes to exactly the integer samples
 * that were encoded; when prediction doesn't help (e.g. white noise) a block
 * is stored verbatim, so output is never larger than raw PCM plus a header.
 *
 * Block layout (little-endian header, 24 bytes, then an MSB-first bitstream):
 *   0  'M' 'L'          magic
 *   2  u8   version (2)
 *   3  u8   flags       bit0 = mid/side, bit1 = verbatim,
 *                       bit2 = discontinuity (first block after an interruption)
 *   4  u32  seq         sender block counter (gap / duplicate / reorder detection)
 *   8  u32  sampleRate
 *   12 u8   channels    1..8
 *   13 u8   bitDepth    8..24
 *   14 u16  frames      1..8192
 *   16 u32  firstFrame  stream sample index of this block's first frame (mod 2^32)
 *   20 u32  captureMs   sender capture time on the shared server clock (ms mod 2^32)
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
  /** Stream sample index of the first frame (mod 2^32); 0 if unused. */
  firstFrame?: number;
  /** Capture time on the shared server clock, ms (mod 2^32); 0 if unused. */
  captureMs?: number;
  /** First block after an interruption: receivers must not treat the gap as loss. */
  discontinuity?: boolean;
}

export interface BlockHeader {
  seq: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  frames: number;
  firstFrame: number;
  captureMs: number;
  discontinuity: boolean;
}

export const HEADER_BYTES = 24;
const VERSION = 2;
const FLAG_MID_SIDE = 1;
const FLAG_VERBATIM = 2;
const FLAG_DISCONTINUITY = 4;
const KNOWN_FLAGS = FLAG_MID_SIDE | FLAG_VERBATIM | FLAG_DISCONTINUITY;
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
  private acc = 0; // pending bits (< 8 between writes)
  private accBits = 0;

  /** Writes into `buf` starting at byte `start` (grows by copying only if a size estimate was wrong). */
  constructor(buf: Uint8Array, start: number) {
    this.buf = buf;
    this.pos = start;
  }

  get buffer(): Uint8Array {
    return this.buf;
  }

  private grow(): void {
    const next = new Uint8Array(Math.max(64, this.buf.length * 2));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  /** Writes the low `n` bits of `value` (1 <= n <= 24). */
  write(value: number, n: number): void {
    this.acc = ((this.acc << n) | (value & ((1 << n) - 1))) >>> 0;
    this.accBits += n;
    // Grow only if the bytes about to be flushed don't fit (never for exactly-sized buffers).
    if (this.pos + (this.accBits >> 3) > this.buf.length) this.grow();
    while (this.accBits >= 8) {
      this.accBits -= 8;
      this.buf[this.pos++] = (this.acc >>> this.accBits) & 0xff;
    }
    this.acc &= (1 << this.accBits) - 1;
  }

  writeLarge(value: number, n: number): void {
    if (n === 0) return;
    if (n > 24) {
      this.write(Math.floor(value / 0x1000000), n - 24);
      this.write(value & 0xffffff, 24);
    } else {
      this.write(value, n);
    }
  }

  /** Rice code: unary quotient (zeros then a one) followed by k remainder bits. */
  writeRice(u: number, k: number): void {
    const q = k >= 31 ? 0 : u >>> k;
    if (q + 1 + k <= 24) {
      // Common case: one write for quotient terminator + remainder.
      this.write((1 << k) | (u & ((1 << k) - 1)), q + 1 + k);
      return;
    }
    let z = q;
    while (z >= 24) {
      this.write(0, 24);
      z -= 24;
    }
    this.write(1, z + 1);
    this.writeLarge(u - q * 2 ** k, k);
  }

  /** Flushes pending bits; returns the total number of bytes used in the buffer. */
  finish(): number {
    if (this.accBits > 0) {
      if (this.pos + 1 > this.buf.length) this.grow();
      this.buf[this.pos++] = (this.acc << (8 - this.accBits)) & 0xff;
      this.acc = 0;
      this.accBits = 0;
    }
    return this.pos;
  }
}

class BitReader {
  private bits = 0; // unread bits, right-aligned, `count` of them
  private count = 0;
  private pos: number;
  private readonly len: number;

  constructor(
    private readonly buf: Uint8Array,
    start: number,
  ) {
    this.pos = start;
    this.len = buf.length;
  }

  private refill(): void {
    while (this.count <= 24 && this.pos < this.len) {
      this.bits = ((this.bits << 8) | this.buf[this.pos++]!) >>> 0;
      this.count += 8;
    }
  }

  private keep(): void {
    this.bits = this.count === 0 ? 0 : (this.bits & (0xffffffff >>> (32 - this.count))) >>> 0;
  }

  /** Reads n bits (n <= 30). */
  read(n: number): number {
    if (n === 0) return 0;
    if (n > 24) return this.read(n - 24) * 0x1000000 + this.read(24);
    if (this.count < n) this.refill();
    if (this.count < n) throw new CodecError('Truncated block');
    this.count -= n;
    const v = (this.bits >>> this.count) & ((1 << n) - 1);
    this.keep();
    return v;
  }

  readSigned(n: number): number {
    const v = this.read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  /** True if every remaining bit is padding (< 8 zero bits) — i.e. the block was consumed exactly. */
  atEnd(): boolean {
    return this.pos === this.len && this.count < 8 && this.bits === 0;
  }

  readUnary(limit: number): number {
    let q = 0;
    for (;;) {
      if (this.count === 0) this.refill();
      if (this.count === 0) throw new CodecError('Truncated block');
      const window = (this.bits << (32 - this.count)) >>> 0;
      if (window === 0) {
        q += this.count;
        this.count = 0;
        this.bits = 0;
        if (q > limit) throw new CodecError('Corrupt residual');
        continue;
      }
      const lz = Math.clz32(window);
      q += lz;
      this.count -= lz + 1;
      this.keep();
      if (q > limit) throw new CodecError('Corrupt residual');
      return q;
    }
  }
}

// ---- prediction ------------------------------------------------------------

function residuals(x: Int32Array, order: number, out: Int32Array): void {
  const n = x.length;
  switch (order) {
    case 0:
      for (let i = 0; i < n; i++) out[i] = x[i]!;
      break;
    case 1:
      for (let i = 1; i < n; i++) out[i] = x[i]! - x[i - 1]!;
      break;
    case 2:
      for (let i = 2; i < n; i++) out[i] = x[i]! - 2 * x[i - 1]! + x[i - 2]!;
      break;
    case 3:
      for (let i = 3; i < n; i++) out[i] = x[i]! - 3 * x[i - 1]! + 3 * x[i - 2]! - x[i - 3]!;
      break;
    default:
      for (let i = 4; i < n; i++)
        out[i] = x[i]! - 4 * x[i - 1]! + 6 * x[i - 2]! - 4 * x[i - 3]! + x[i - 4]!;
  }
}

function restore(x: Int32Array, order: number): void {
  const n = x.length;
  switch (order) {
    case 0:
      break;
    case 1:
      for (let i = 1; i < n; i++) x[i] = x[i]! + x[i - 1]!;
      break;
    case 2:
      for (let i = 2; i < n; i++) x[i] = x[i]! + 2 * x[i - 1]! - x[i - 2]!;
      break;
    case 3:
      for (let i = 3; i < n; i++) x[i] = x[i]! + 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!;
      break;
    default:
      for (let i = 4; i < n; i++)
        x[i] = x[i]! + 4 * x[i - 1]! - 6 * x[i - 2]! + 4 * x[i - 3]! - x[i - 4]!;
  }
}

/** Zig-zag map, valid for |e| < 2^30 (residuals of <= 25-bit samples stay below 2^29). */
const zigzag = (e: number) => ((e << 1) ^ (e >> 31)) >>> 0;
const unzigzag = (u: number) =>
  u < 0x80000000 ? (u >>> 1) ^ -(u & 1) : u % 2 === 0 ? u / 2 : -(u + 1) / 2;

interface ChannelPlan {
  order: number;
  k: number;
  bits: number;
  res: Int32Array;
}

// ---- scratch buffers -------------------------------------------------------
// Reused across blocks so steady-state encoding/decoding allocates only the
// output buffer. Safe because encode/decode are synchronous and never
// re-entered; buffers never escape the codec.
const pool: Int32Array[] = [];
const SLOT_PLANAR = 0; // 0..7
const SLOT_MID = 8;
const SLOT_SIDE = 9;
const SLOT_RES = 10; // 10..19
const SLOT_DECODE = 20; // 20..27

function scratch(slot: number, n: number): Int32Array {
  let b = pool[slot];
  if (!b || b.length !== n) pool[slot] = b = new Int32Array(n);
  return b;
}

/**
 * Mean |residual| for fixed orders 0..4 in one branch-free pass using the
 * difference recurrence e_k[i] = e_(k-1)[i] - e_(k-1)[i-1]. All orders are
 * compared over the same range (i >= 4), as FLAC's fixed-predictor search does.
 */
const costBuf = new Float64Array(5);
function orderCosts(x: Int32Array): Float64Array {
  const n = x.length;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let l0 = x[3]!;
  let l1 = x[3]! - x[2]!;
  let l2 = l1 - (x[2]! - x[1]!);
  let l3 = l2 - (x[2]! - x[1]! - (x[1]! - x[0]!));
  for (let i = 4; i < n; i++) {
    const e0 = x[i]!;
    const e1 = e0 - l0;
    const e2 = e1 - l1;
    const e3 = e2 - l2;
    const e4 = e3 - l3;
    s0 += Math.abs(e0);
    s1 += Math.abs(e1);
    s2 += Math.abs(e2);
    s3 += Math.abs(e3);
    s4 += Math.abs(e4);
    l0 = e0;
    l1 = e1;
    l2 = e2;
    l3 = e3;
  }
  const m = n - 4;
  costBuf[0] = s0 / m;
  costBuf[1] = s1 / m;
  costBuf[2] = s2 / m;
  costBuf[3] = s3 / m;
  costBuf[4] = s4 / m;
  return costBuf;
}

function planChannel(x: Int32Array, sampleBits: number, resSlot: number): ChannelPlan {
  const n = x.length;
  const first = x[0];
  let constant = true;
  for (let i = 1; i < n; i++) {
    if (x[i] !== first) {
      constant = false;
      break;
    }
  }
  if (constant) return { order: CONSTANT, k: 0, bits: 8 + sampleBits, res: x };

  let order = 0;
  let meanAbs: number;
  if (n > 8) {
    const costs = orderCosts(x);
    for (let o = 1; o <= MAX_ORDER; o++) if (costs[o]! < costs[order]!) order = o;
    meanAbs = costs[order]!;
  } else {
    // Tiny blocks: order 0 is as good as anything and keeps the search trivial.
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(x[i]!);
    meanAbs = sum / n;
  }
  const res = scratch(resSlot, n);
  residuals(x, order, res);

  // Evaluate three Rice parameters around the estimate in a single pass.
  const mean = meanAbs * 2; // mean zig-zag value ≈ 2 × mean |e|
  const k0 = mean < 1 ? 0 : Math.min(MAX_K, Math.floor(Math.log2(mean)));
  const ka = Math.max(0, Math.min(MAX_K - 2, k0 - 1));
  let sa = 0;
  let sb = 0;
  let sc = 0;
  for (let i = order; i < n; i++) {
    const u = zigzag(res[i]!);
    sa += u >>> ka;
    sb += u >>> (ka + 1);
    sc += u >>> (ka + 2);
  }
  const count = n - order;
  const base = 8 + order * sampleBits;
  const ba = base + sa + count * (1 + ka);
  const bb = base + sb + count * (2 + ka);
  const bc = base + sc + count * (3 + ka);
  if (ba <= bb && ba <= bc) return { order, k: ka, bits: ba, res };
  if (bb <= bc) return { order, k: ka + 1, bits: bb, res };
  return { order, k: ka + 2, bits: bc, res };
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
    const ch = scratch(SLOT_PLANAR + c, frames);
    for (let i = 0, j = c; i < frames; i++, j += channels) {
      const v = samples[j]!;
      if (v < lo || v > hi) throw new CodecError('Sample out of range for bit depth');
      ch[i] = v;
    }
    planar.push(ch);
  }

  // Try independent channels and, for stereo, mid/side; keep the smaller.
  let plans = planar.map((ch, c) => planChannel(ch, bitDepth, SLOT_RES + c));
  let midSide = false;
  if (channels === 2) {
    const l = planar[0]!;
    const r = planar[1]!;
    const mid = scratch(SLOT_MID, frames);
    const side = scratch(SLOT_SIDE, frames);
    for (let i = 0; i < frames; i++) {
      mid[i] = (l[i]! + r[i]!) >> 1;
      side[i] = l[i]! - r[i]!;
    }
    const ms = [
      planChannel(mid, bitDepth, SLOT_RES + 8),
      planChannel(side, bitDepth + 1, SLOT_RES + 9),
    ];
    if (ms[0]!.bits + ms[1]!.bits < plans[0]!.bits + plans[1]!.bits) {
      plans = ms;
      midSide = true;
    }
  }

  let predictedBits = 0;
  for (const p of plans) predictedBits += p.bits;
  const verbatimBits = frames * channels * bitDepth;
  const verbatim = verbatimBits <= predictedBits;

  // Exact size is known from the plan: one allocation, which is the returned payload.
  const out = new Uint8Array(HEADER_BYTES + Math.ceil(Math.min(predictedBits, verbatimBits) / 8));
  const dv = new DataView(out.buffer);
  out[0] = 0x4d;
  out[1] = 0x4c;
  out[2] = VERSION;
  out[3] =
    (midSide && !verbatim ? FLAG_MID_SIDE : 0) |
    (verbatim ? FLAG_VERBATIM : 0) |
    (block.discontinuity ? FLAG_DISCONTINUITY : 0);
  dv.setUint32(4, block.seq >>> 0, true);
  dv.setUint32(8, block.sampleRate, true);
  out[12] = channels;
  out[13] = bitDepth;
  dv.setUint16(14, frames, true);
  dv.setUint32(16, (block.firstFrame ?? 0) >>> 0, true);
  dv.setUint32(20, (block.captureMs ?? 0) >>> 0, true);

  if (verbatim && (bitDepth === 16 || bitDepth === 24)) {
    // Byte-aligned fast path; identical to the bitstream (MSB-first = big-endian).
    let o = HEADER_BYTES;
    if (bitDepth === 16) {
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i]!;
        out[o++] = (v >> 8) & 0xff;
        out[o++] = v & 0xff;
      }
    } else {
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i]!;
        out[o++] = (v >> 16) & 0xff;
        out[o++] = (v >> 8) & 0xff;
        out[o++] = v & 0xff;
      }
    }
    return out;
  }

  const w = new BitWriter(out, HEADER_BYTES);
  if (verbatim) {
    for (let i = 0; i < samples.length; i++) w.write(samples[i]!, bitDepth);
  } else {
    for (let c = 0; c < plans.length; c++) {
      const p = plans[c]!;
      const sampleBits = midSide && c === 1 ? bitDepth + 1 : bitDepth;
      const src = midSide ? null : planar[c]!;
      w.write(p.order, 3);
      w.write(p.k, 5);
      if (p.order === CONSTANT) {
        const v = src ? src[0]! : warmup(planar, c, 0);
        w.writeLarge(v < 0 ? v + 2 ** sampleBits : v, sampleBits);
        continue;
      }
      for (let i = 0; i < p.order; i++) {
        // Warm-up samples are stored verbatim (original or mid/side values).
        const v = src ? src[i]! : warmup(planar, c, i);
        w.writeLarge(v < 0 ? v + 2 ** sampleBits : v, sampleBits);
      }
      const res = p.res;
      const k = p.k;
      for (let i = p.order; i < frames; i++) w.writeRice(zigzag(res[i]!), k);
    }
  }
  const used = w.finish();
  const buf = w.buffer as Uint8Array<ArrayBuffer>;
  return used === buf.length ? buf : buf.slice(0, used);
}

function warmup(planar: Int32Array[], c: number, i: number): number {
  const l = planar[0]![i]!;
  const r = planar[1]![i]!;
  return c === 0 ? (l + r) >> 1 : l - r;
}

export function peekHeader(bytes: Uint8Array): BlockHeader {
  if (bytes.length < HEADER_BYTES || bytes[0] !== 0x4d || bytes[1] !== 0x4c)
    throw new CodecError('Bad magic');
  if (bytes[2] !== VERSION) throw new CodecError('Unsupported version');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta: BlockHeader = {
    seq: dv.getUint32(4, true),
    sampleRate: dv.getUint32(8, true),
    channels: bytes[12]!,
    bitDepth: bytes[13]!,
    frames: dv.getUint16(14, true),
    firstFrame: dv.getUint32(16, true),
    captureMs: dv.getUint32(20, true),
    discontinuity: (bytes[3]! & FLAG_DISCONTINUITY) !== 0,
  };
  validate(meta, meta.frames);
  return meta;
}

export function decodeBlock(bytes: Uint8Array): PcmBlock {
  const meta = peekHeader(bytes);
  const { channels, bitDepth, frames } = meta;
  const flags = bytes[3]!;
  if (flags & ~KNOWN_FLAGS) throw new CodecError('Unknown flags');
  if (flags & FLAG_VERBATIM && flags & FLAG_MID_SIDE) throw new CodecError('Invalid flag combination');
  const out = new Int32Array(frames * channels);
  const r = new BitReader(bytes, HEADER_BYTES);

  if (flags & FLAG_VERBATIM) {
    if (bitDepth === 16 || bitDepth === 24) {
      const bpsBytes = bitDepth / 8;
      if (bytes.length !== HEADER_BYTES + out.length * bpsBytes) throw new CodecError('Bad block length');
      let o = HEADER_BYTES;
      if (bitDepth === 16) {
        for (let i = 0; i < out.length; i++, o += 2)
          out[i] = ((bytes[o]! << 24) | (bytes[o + 1]! << 16)) >> 16;
      } else {
        for (let i = 0; i < out.length; i++, o += 3)
          out[i] = ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8)) >> 8;
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] = r.readSigned(bitDepth);
      if (!r.atEnd()) throw new CodecError('Trailing data after block');
    }
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
      planar.push(scratch(SLOT_DECODE + c, frames).fill(r.readSigned(sampleBits)));
      continue;
    }
    if (order > MAX_ORDER || order > frames - 1 || k > MAX_K)
      throw new CodecError('Bad channel header');
    const x = scratch(SLOT_DECODE + c, frames);
    for (let i = 0; i < Math.min(order, frames); i++) x[i] = r.readSigned(sampleBits);
    const div = 2 ** k;
    for (let i = order; i < frames; i++) {
      const q = r.readUnary(maxQuotient);
      x[i] = unzigzag(q * div + r.read(k));
    }
    restore(x, order);
    planar.push(x);
  }
  if (!r.atEnd()) throw new CodecError('Trailing data after block');

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

/** Internals exposed for unit tests only. */
export const __test = { BitWriter, BitReader };
