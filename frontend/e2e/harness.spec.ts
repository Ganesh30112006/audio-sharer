import { expect, test, type Page } from '@playwright/test';

/**
 * Integration gates for the lossless pipeline using the REAL sender, codec
 * workers, capture/playback worklets and receiver (harness/lossless.html).
 * Only the transport is simulated, to impose stalls / throughput limits.
 *
 * Gates: fidelity (bit-exact for every delivered block), accounting (every
 * captured frame delivered or reported lost), announced gaps only, no stale
 * generation reaching playback, bounded queues, measured recovery.
 */
type Result = {
  verify: { blocks: number; frames: number; mismatches: number; unaligned: number };
  sender: Record<string, number | boolean | string[]>;
  receiver: Record<string, number | null>;
  peak: Record<string, number>;
};

async function runHarness(page: Page, opts: object): Promise<Result> {
  await page.goto('/harness/lossless.html');
  await page.waitForSelector('body[data-ready="true"]');
  return page.evaluate(
    (o) => (window as unknown as { runHarness: (o: object) => Promise<Result> }).runHarness(o),
    opts,
  );
}

function report(name: string, r: Result) {
  const { verify, sender, receiver, peak, jumps, firstBlocks, captureDiag, mismatchLog } =
    r as Result & {
      jumps: unknown[];
      firstBlocks: unknown[];
      captureDiag: unknown;
      mismatchLog: unknown[];
    };
  console.log(
    `[harness] ${name} ${JSON.stringify({ verify, mismatchLog, jumps, firstBlocks, captureDiag, sender, receiver, peak })}`,
  );
  test.info().annotations.push({
    type: 'harness',
    description: JSON.stringify({ name, verify, sender, receiver, peak }),
  });
}

type Num = Record<string, number>;

function gates(r: Result, opts: { accounting?: boolean; ordered?: boolean } = {}) {
  const S = r.sender as unknown as Num;
  const R = r.receiver as unknown as Num;
  expect(r.verify.mismatches, 'bit-exact for every delivered frame').toBe(0);
  expect(r.verify.blocks, 'verified blocks').toBeGreaterThan(50);
  if (opts.ordered !== false) {
    expect(R.unexpectedGaps, 'only announced gaps').toBe(0);
    expect(R.stale, 'no stale/out-of-order blocks').toBe(0);
  }
  expect(R.duplicates).toBe(0);
  expect(R.corrupt).toBe(0);
  expect(r.peak.sendBlocks, 'bounded encode/send queues').toBeLessThanOrEqual(51);
  expect(r.peak.decodeBlocks, 'bounded decode queue').toBeLessThanOrEqual(51);
  expect(r.peak.oldestAgeMs, 'queue age bounded while streaming').toBeLessThanOrEqual(800);
  if (opts.accounting !== false) {
    // Stage-by-stage reconciliation (after drain). Interrupted frames are never counted as delivered.
    expect(S.capturedFrames + S.captureGapFrames, 'timeline = sent + announced interruptions').toBe(
      S.sentFrames + S.droppedFrames,
    );
    expect(S.encodedFrames, 'encoded >= sent').toBeGreaterThanOrEqual(S.sentFrames);
    expect(R.deliveredFrames + R.droppedFrames, 'reliable FIFO: everything sent is received').toBe(
      S.sentFrames,
    );
    expect(R.decodedFrames, 'all delivered frames decoded').toBe(R.deliveredFrames);
    // Exact: every decoded frame was played once, discarded (reset / clock skip), or is still buffered.
    // (Clock-correction repeats output an already-played frame twice; they are extra output, not data.)
    expect(
      R.playedFrames + R.skippedFrames + R.bufferedFrames,
      'played frames reconcile with decoded',
    ).toBe(R.decodedFrames);
  }
}

/** Interruptions other than engine capture gaps (which are reported, not prevented). */
const nonCaptureInterruptions = (r: Result) =>
  (r.sender.liveCauses as string[]).filter((c) => c !== 'capture-gap').length;

test.describe.configure({ mode: 'serial' });

test('real pipeline, normal conditions, 48 kHz/24-bit', async ({ page }) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, { seconds: 15, rate: 48_000, bits: 24 });
  report('normal-48-24', r);
  gates(r);
  expect(nonCaptureInterruptions(r)).toBe(0);
  expect(r.receiver.outages).toBe(0);
  expect(r.sender.offMainThread).toBe(true);
});

test('real pipeline, 192 kHz/24-bit', async ({ page }) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, { seconds: 10, rate: 192_000, bits: 24 });
  report('normal-192-24', r);
  gates(r);
  expect(nonCaptureInterruptions(r)).toBe(0);
});

test('network stall of 3 s: announced interruption, recovery measured', async ({ page }) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, {
    seconds: 14,
    rate: 48_000,
    bits: 24,
    link: [{ fromMs: 4000, toMs: 7000, kbps: 0 }],
  });
  report('stall-3s', r);
  gates(r);
  expect(r.sender.interruptions).toBeGreaterThanOrEqual(1);
  expect(r.sender.causes).toContain('network-congestion');
  expect(r.receiver.announcedGaps).toBeGreaterThanOrEqual(1);
  expect(r.receiver.outages).toBeGreaterThanOrEqual(1);
  expect(r.receiver.lastRecoveryMs).not.toBeNull();
});

test('throughput below the stream bitrate for 6 s: bounded queues, explicit interruptions', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, {
    seconds: 14,
    rate: 48_000,
    bits: 24,
    link: [{ fromMs: 3000, toMs: 9000, kbps: 400 }],
  });
  report('slow-link', r);
  gates(r);
  expect(r.sender.causes).toContain('network-congestion');
});

test('sender restarts mid-stream: stale generations never reach playback', async ({ page }) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, {
    seconds: 12,
    rate: 48_000,
    bits: 24,
    restartSenderAtMs: [3000, 3030, 3060, 6000, 9000],
  });
  report('sender-restarts', r);
  // Blocks in flight at each restart are abandoned by design (new generation)
  // and must appear in the accounting as session-reset interruptions.
  gates(r);
  expect(r.receiver.announcedGaps).toBeGreaterThanOrEqual(1);
});

test('receiver restarts mid-stream: stale decodes are discarded, playback recovers', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, {
    seconds: 12,
    rate: 48_000,
    bits: 24,
    restartReceiverAtMs: [4000, 8000],
  });
  report('receiver-restarts', r);
  gates(r, { accounting: false });
});

test('unreliable reordering transport: out-of-order data is detected, never spliced', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const r = await runHarness(page, { seconds: 8, rate: 48_000, bits: 24, reorderEvery: 25 });
  report('reordering-transport', r);
  gates(r, { ordered: false, accounting: false });
  const R = r.receiver as unknown as Num;
  expect(R.unexpectedGaps, 'reordering detected as gaps').toBeGreaterThan(0);
  expect(R.stale, 'late blocks rejected').toBeGreaterThan(0);
});

const SOAK_S = Number(process.env.LIFECYCLE_SOAK_SECONDS ?? 20);
for (const cfg of [
  { rate: 48_000, bits: 24, channels: 2 },
  { rate: 44_100, bits: 16, channels: 1 },
  { rate: 96_000, bits: 24, channels: 2 },
  { rate: 192_000, bits: 24, channels: 1 },
] as const) {
  test(`lifecycle soak: restart every 700 ms for ${SOAK_S}s at ${cfg.rate / 1000}k/${cfg.bits} ${cfg.channels}ch`, async ({
    page,
  }) => {
    test.setTimeout((SOAK_S + 60) * 1000);
    const r = await runHarness(page, { seconds: SOAK_S, ...cfg, restartEveryMs: 700 });
    report(`lifecycle-${cfg.rate}-${cfg.bits}-${cfg.channels}ch`, r);
    gates(r);
    const S = r.sender as unknown as Num;
    const restarts = Math.floor((SOAK_S * 1000) / 700);
    expect(
      r.receiver.announcedGaps as number,
      'each restart is an announced discontinuity',
    ).toBeGreaterThanOrEqual(restarts - 2);
    expect(S.sentFrames).toBeGreaterThan(cfg.rate * SOAK_S * 0.8);
  });
}
