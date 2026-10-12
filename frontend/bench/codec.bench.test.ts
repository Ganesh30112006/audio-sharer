/**
 * Reproducible lossless-codec benchmark. Measures encode and decode
 * separately per signal × format × block size, and records throughput,
 * typed-array allocations, compression ratio and round-trip correctness.
 *
 *   npm run bench:codec                         # current codec
 *   CODEC_PATH=/abs/path/codec.ts BENCH_LABEL=baseline npm run bench:codec
 *
 * Results: bench/results/<label>.json and a table on stdout.
 */
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { makeSignal, type SignalName } from './signals';

interface Codec {
  encodeBlock(b: {
    seq: number;
    sampleRate: number;
    channels: number;
    bitDepth: number;
    samples: Int32Array;
  }): Uint8Array;
  decodeBlock(b: Uint8Array): { samples: Int32Array };
}

// Count typed-array allocations made inside the codec (patched before import).
let allocCount = 0;
let allocBytes = 0;
for (const name of ['Int32Array', 'Uint8Array', 'Float32Array'] as const) {
  const Native = globalThis[name] as unknown as new (...a: unknown[]) => ArrayBufferView;
  const Counting = class extends (Native as unknown as new (...a: unknown[]) => ArrayBufferView) {
    constructor(...args: unknown[]) {
      super(...args);
      allocCount++;
      allocBytes += this.byteLength;
    }
  };
  (globalThis as Record<string, unknown>)[name] = Counting;
}

const SIGNALS: SignalName[] = ['music', 'silence', 'impulses', 'noise', 'extremes'];
const FORMATS = [
  [44_100, 16],
  [48_000, 24],
  [96_000, 24],
  [192_000, 24],
] as const;
const BLOCK_MS = [5, 20, 40];
const SECONDS = Number(process.env.BENCH_SECONDS ?? 5);
const RUNS = 5;

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;

it('codec benchmark', async () => {
  const codec = (await import(process.env.CODEC_PATH ?? '../src/audio/lossless/codec')) as Codec;
  const label = process.env.BENCH_LABEL ?? 'current';
  const rows: Array<Record<string, string | number>> = [];

  for (const [rate, bits] of FORMATS) {
    for (const blockMs of BLOCK_MS) {
      const frames = Math.min(8192, Math.round((rate * blockMs) / 1000));
      const nBlocks = Math.ceil((rate * SECONDS) / frames);
      for (const signal of SIGNALS) {
        const all = makeSignal(signal, nBlocks * frames, rate, bits);
        const blocks = Array.from({ length: nBlocks }, (_, b) => ({
          seq: b,
          sampleRate: rate,
          channels: 2,
          bitDepth: bits,
          samples: all.subarray(b * frames * 2, (b + 1) * frames * 2),
        }));
        // Warm-up (JIT) + correctness on every block.
        let mismatches = 0;
        let encodedBytes = 0;
        const encoded = blocks.map((b) => codec.encodeBlock(b));
        encoded.forEach((e, i) => {
          encodedBytes += e.length;
          const d = codec.decodeBlock(e).samples;
          const src = blocks[i]!.samples;
          for (let j = 0; j < src.length; j++) if (d[j] !== src[j]) mismatches++;
        });
        const encT: number[] = [];
        const decT: number[] = [];
        let encAlloc = 0;
        let encAllocBytes = 0;
        let decAlloc = 0;
        let decAllocBytes = 0;
        for (let r = 0; r < RUNS; r++) {
          allocCount = allocBytes = 0;
          let t0 = performance.now();
          for (const b of blocks) codec.encodeBlock(b);
          encT.push(performance.now() - t0);
          encAlloc = allocCount;
          encAllocBytes = allocBytes;
          allocCount = allocBytes = 0;
          t0 = performance.now();
          for (const e of encoded) codec.decodeBlock(e);
          decT.push(performance.now() - t0);
          decAlloc = allocCount;
          decAllocBytes = allocBytes;
        }
        const rawBytes = (nBlocks * frames * 2 * bits) / 8;
        rows.push({
          format: `${rate / 1000}k/${bits}`,
          blockMs,
          signal,
          encMsPerSec: +(median(encT) / SECONDS).toFixed(2),
          decMsPerSec: +(median(decT) / SECONDS).toFixed(2),
          encXRealtime: Math.round((SECONDS * 1000) / median(encT)),
          decXRealtime: Math.round((SECONDS * 1000) / median(decT)),
          ratio: +(encodedBytes / rawBytes).toFixed(3),
          encAllocsPerBlock: +(encAlloc / nBlocks).toFixed(1),
          encAllocKBPerSec: Math.round(encAllocBytes / SECONDS / 1024),
          decAllocsPerBlock: +(decAlloc / nBlocks).toFixed(1),
          decAllocKBPerSec: Math.round(decAllocBytes / SECONDS / 1024),
          mismatches,
        });
      }
    }
  }

  const cols = Object.keys(rows[0]!);
  const table = [
    cols.join(' | '),
    cols.map(() => '---').join(' | '),
    ...rows.map((r) => cols.map((c) => r[c]).join(' | ')),
  ].join('\n');
  console.log(
    `\n[codec-bench:${label}] node ${process.version}, ${SECONDS}s per case, median of ${RUNS}\n${table}\n`,
  );
  writeFileSync(
    new URL(`./results/${label}.json`, import.meta.url),
    JSON.stringify({ label, node: process.version, seconds: SECONDS, rows }, null, 1),
  );
  const bad = rows.filter((r) => r.mismatches !== 0);
  if (bad.length) throw new Error(`Round-trip mismatches in ${bad.length} cases`);
});
