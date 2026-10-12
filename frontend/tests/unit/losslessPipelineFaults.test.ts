/**
 * Fault paths of the lossless pipelines, driven step by step: transport
 * unavailable (reconnect/disconnect), a failed encode, a failed decode. In
 * every case lost audio must be counted in an explicit interruption, and the
 * first block after the gap must be flagged so receivers restart cleanly.
 */
import { describe, expect, it } from 'vitest';
import { encodeBlock, peekHeader } from '../../src/audio/lossless/codec';
import {
  ReceivePipeline,
  SendPipeline,
  type DecodeJob,
  type EncodeJob,
} from '../../src/audio/lossless/pipeline';

const FRAMES = 480;
const samples = () => new Int32Array(FRAMES * 2).fill(3);

function sender(opts: { canSend?: () => boolean } = {}) {
  const jobs: EncodeJob[] = [];
  const sent: Uint8Array[] = [];
  const p = new SendPipeline({
    now: () => 0,
    serverNow: () => 0,
    encode: (job) => jobs.push(job),
    send: async (payload) => {
      sent.push(payload);
    },
    ...opts,
  });
  let frame = 0;
  const capture = () => {
    p.capture(samples(), 2, 48_000, 16, frame);
    frame += FRAMES;
  };
  /** Completes every queued encode, in order. */
  const encodeAll = () => {
    while (jobs.length) {
      const j = jobs.shift()!;
      p.encoded(j.gen, j.block.seq, encodeBlock(j.block));
    }
  };
  return { p, jobs, sent, capture, encodeAll };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SendPipeline transport availability', () => {
  it('one interruption per outage, every frame counted, flagged block on resume', async () => {
    let up = true;
    const s = sender({ canSend: () => up });
    for (let i = 0; i < 5; i++) s.capture();
    s.encodeAll();
    await flush();
    up = false; // reconnecting
    for (let i = 0; i < 100; i++) s.capture(); // 1 s of audio while the link is down
    s.encodeAll();
    await flush();
    let st = s.p.stats();
    expect(st.interruptions).toBe(1);
    expect(st.current?.cause).toBe('transport-error');
    up = true;
    s.capture();
    s.encodeAll();
    await flush();
    st = s.p.stats();
    expect(st.interruptions).toBe(1);
    expect(st.current).toBeNull();
    const last = peekHeader(s.sent[s.sent.length - 1]!);
    expect(last.discontinuity).toBe(true);
    expect(st.capturedFrames).toBe(st.sentFrames + st.droppedFrames);
    expect(st.droppedFrames).toBe(100 * FRAMES);
  });
});

describe('SendPipeline encode failure', () => {
  it('never sends blocks behind a failed encode without a discontinuity before them', async () => {
    const s = sender();
    for (let i = 0; i < 4; i++) s.capture(); // seq 0..3 in the encoder
    const [first, ...rest] = s.jobs.splice(0);
    s.p.encodeFailed(first!.gen, first!.block.seq);
    for (const j of rest) s.p.encoded(j.gen, j.block.seq, encodeBlock(j.block));
    s.capture(); // seq 4
    s.encodeAll();
    await flush();
    const headers = s.sent.map((b) => peekHeader(b));
    // Whatever reaches the receiver after the failed block starts with a flagged block.
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]!.discontinuity).toBe(true);
    const st = s.p.stats();
    expect(st.capturedFrames).toBe(st.sentFrames + st.droppedFrames);
  });
});

describe('ReceivePipeline decode failure', () => {
  it('records the lost block as an interruption with its frames', () => {
    const jobs: DecodeJob[] = [];
    const r = new ReceivePipeline({
      now: () => 0,
      serverNow: () => 0,
      peek: peekHeader,
      decode: (j) => jobs.push(j),
    });
    for (let seq = 0; seq < 3; seq++)
      r.receive(
        encodeBlock({
          seq,
          sampleRate: 48_000,
          channels: 2,
          bitDepth: 16,
          samples: samples(),
          firstFrame: seq * FRAMES,
        }),
      );
    r.decoded(jobs[0]!.gen, 0);
    r.decodeFailed(jobs[1]!.gen, 1);
    const st = r.stats();
    expect(st.interruptions).toBe(1);
    expect(st.droppedFrames).toBe(FRAMES);
  });
});
