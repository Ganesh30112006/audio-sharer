/**
 * Lossless codec off the main thread. Requests are processed strictly in
 * order, so replies come back in submission order. Every request carries the
 * pipeline generation and block seq so stale replies (after a stop/restart)
 * are recognised and ignored by the owner.
 */
import { decodeBlock, encodeBlock, type PcmBlock } from './codec';

export type CodecRequest =
  | { op: 'encode'; gen: number; block: PcmBlock }
  | { op: 'decode'; gen: number; seq: number; payload: Uint8Array };

export type CodecReply =
  | { op: 'encoded'; gen: number; seq: number; payload: Uint8Array<ArrayBuffer>; busyMs: number }
  | {
      op: 'decoded';
      gen: number;
      seq: number;
      pcm: Float32Array<ArrayBuffer>;
      sampleRate: number;
      channels: number;
      bitDepth: number;
      busyMs: number;
    }
  | { op: 'error'; gen: number; seq: number; message: string; busyMs: number };

/** Shared by the worker and the in-thread fallback. */
export function handle(req: CodecRequest): { reply: CodecReply; transfer: Transferable[] } {
  const t0 = performance.now();
  const seq = req.op === 'encode' ? req.block.seq : req.seq;
  try {
    if (req.op === 'encode') {
      const payload = encodeBlock(req.block);
      return {
        reply: { op: 'encoded', gen: req.gen, seq, payload, busyMs: performance.now() - t0 },
        transfer: [payload.buffer],
      };
    }
    const block = decodeBlock(req.payload);
    const scale = 1 / 2 ** (block.bitDepth - 1);
    const pcm = new Float32Array(block.samples.length);
    for (let i = 0; i < pcm.length; i++) pcm[i] = block.samples[i]! * scale;
    return {
      reply: {
        op: 'decoded',
        gen: req.gen,
        seq,
        pcm,
        sampleRate: block.sampleRate,
        channels: block.channels,
        bitDepth: block.bitDepth,
        busyMs: performance.now() - t0,
      },
      transfer: [pcm.buffer],
    };
  } catch (err) {
    return {
      reply: {
        op: 'error',
        gen: req.gen,
        seq,
        message: (err as Error).message,
        busyMs: performance.now() - t0,
      },
      transfer: [],
    };
  }
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<CodecRequest>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
  WorkerGlobalScope?: unknown;
};
if (typeof scope.WorkerGlobalScope !== 'undefined') {
  scope.onmessage = (e) => {
    const { reply, transfer } = handle(e.data);
    scope.postMessage(reply, transfer);
  };
}
