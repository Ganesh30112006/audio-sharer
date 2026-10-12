import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { analyse, dist, type SideDump } from './latencyAnalysis';
import { installOnsetProbe, pairLatencies, readOnsets } from './probes';
import { burstWav } from './wav';

/**
 * Per-stage lossless latency profile (manual benchmark, not run in CI).
 *
 *   PROFILE_SECONDS     trial length (default 120)
 *   PROFILE_VARIANT     value of localStorage 'mc.experiment' ('baseline' by default)
 *   PROFILE_CONTENTION  number of busy-loop processes during the trial (default 0)
 *   PROFILE_OUT         directory for the raw JSON result (default bench/latency/results)
 *
 * Clock domains: per-stage values come from latencyAnalysis.ts (each stage in
 * one domain; transport through the server clock with its ± uncertainty).
 * The onset-based end-to-end figure compares two pages' wall clocks and is
 * only valid because both pages run on the same machine; it is labelled so.
 */
const SECONDS = Number(process.env.PROFILE_SECONDS ?? 120);
const VARIANT = process.env.PROFILE_VARIANT ?? 'baseline';
const CONTENTION = Number(process.env.PROFILE_CONTENTION ?? 0);
const OUT = process.env.PROFILE_OUT ?? join(__dirname, '..', 'bench', 'latency', 'results');

function startContention(n: number): ChildProcess[] {
  return Array.from({ length: n }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
  );
}

async function metric(page: Page, key: string): Promise<string> {
  const el = page.locator(`[data-metric="${key}"] dd`);
  return (await el.count()) ? ((await el.textContent()) ?? '').trim() : '';
}

test(`lossless latency profile (${VARIANT}, contention ${CONTENTION})`, async ({ browser }) => {
  test.setTimeout((SECONDS + 90) * 1000);
  const hostCtx = await browser.newContext();
  const listenerCtx = await browser.newContext();
  for (const c of [hostCtx, listenerCtx]) {
    await c.addInitScript((variant) => {
      if (!location.protocol.startsWith('http')) return;
      localStorage.setItem(
        'mc.settings.v1',
        JSON.stringify({
          displayName: 'Probe',
          bufferMode: 'auto',
          showDiagnostics: true,
          transport: 'lossless',
        }),
      );
      localStorage.setItem('mc.latencyTrace', '1');
      localStorage.setItem('mc.experiment', variant);
    }, VARIANT);
  }
  await installOnsetProbe(hostCtx, 'host');
  await installOnsetProbe(listenerCtx, 'listener');
  const host = await hostCtx.newPage();
  const listener = await listenerCtx.newPage();

  await host.goto('/');
  await host.getByRole('button', { name: 'Create room' }).click();
  await host.waitForURL(/\/host\//);
  await expect(host.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
    timeout: 20_000,
  });
  const code = host.url().split('/').pop()!;
  await host
    .getByTestId('file-input')
    .setInputFiles({ name: 'clicks.wav', mimeType: 'audio/wav', buffer: burstWav(SECONDS + 20) });
  await host.getByRole('button', { name: 'Go live' }).click();
  await listener.goto(`/room/${code}`);
  await listener.getByRole('button', { name: 'Join and listen' }).click();
  await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({
    timeout: 20_000,
  });

  const load0 = loadavg();
  const burners = startContention(CONTENTION);
  try {
    await host.getByRole('button', { name: 'Play', exact: true }).click();
    await host.waitForTimeout(SECONDS * 1000);
  } finally {
    for (const b of burners) b.kill('SIGKILL');
  }
  const load1 = loadavg();

  // UI metrics and onsets first: serialising a trace blocks that page's thread
  // for ~0.2 s, which would itself cause an outage on the listener.
  const ui = {
    listener: {
      outages: await metric(listener, 'lossless Outages'),
      lastRecovery: await metric(listener, 'lossless Last recovery'),
      silence: await metric(listener, 'lossless Silence inserted'),
      announcedGaps: await metric(listener, 'lossless Announced gaps'),
      unannouncedGaps: await metric(listener, 'lossless Unannounced gaps'),
      clockCorrections: await metric(listener, 'lossless Clock corrections'),
      bufferTarget: await metric(listener, 'lossless Buffer target'),
    },
    host: {
      interruptions: await metric(host, 'lossless Interruptions'),
      audioNotSent: await metric(host, 'lossless Audio not sent'),
    },
  };
  const onsets = pairLatencies(await readOnsets(host), await readOnsets(listener)).slice(5);
  const heap = (p: Page) =>
    p.evaluate(
      () =>
        Math.round(
          ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0) / 1e5,
        ) / 10,
    );
  const memory = { hostHeapMB: await heap(host), listenerHeapMB: await heap(listener) };

  const dump = (p: Page, side: 'host' | 'listener') =>
    p.evaluate((s) => {
      const t = (window as unknown as { __mcLatency?: Record<string, { dump(): unknown }> })
        .__mcLatency?.[s];
      return t ? t.dump() : null;
    }, side) as Promise<SideDump | null>;
  const l = await dump(listener, 'listener');
  const h = await dump(host, 'host');
  expect(h, 'host trace (mc.latencyTrace)').not.toBeNull();
  expect(l, 'listener trace (mc.latencyTrace)').not.toBeNull();

  const result = {
    variant: VARIANT,
    contention: CONTENTION,
    seconds: SECONDS,
    startedAt: new Date().toISOString(),
    machine: {
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      loadAvg1Before: load0[0],
      loadAvg1After: load1[0],
      browser: `${browser.browserType().name()} ${browser.version()}`,
    },
    analysis: analyse(h!, l!),
    /** Same-machine wall clock (two pages' performance.timeOrigin); not valid across devices. */
    onsetSameMachineMs: dist(onsets),
    ...ui,
    memory,
  };
  mkdirSync(OUT, { recursive: true });
  const file = join(
    OUT,
    `${result.startedAt.replace(/[:.]/g, '-')}-${VARIANT}-c${CONTENTION}.json`,
  );
  writeFileSync(file, JSON.stringify(result, null, 2));
  // Optional raw per-block traces (large; for ad-hoc analysis, not committed).
  if (process.env.PROFILE_RAW) {
    mkdirSync(process.env.PROFILE_RAW, { recursive: true });
    writeFileSync(
      join(process.env.PROFILE_RAW, basename(file).replace('.json', '.raw.json.gz')),
      gzipSync(JSON.stringify({ host: h, listener: l })),
    );
  }
  const a = result.analysis;
  console.log(
    `[profile] ${VARIANT} c${CONTENTION} onset p50/p95/p99 ${result.onsetSameMachineMs.p50}/${result.onsetSameMachineMs.p95}/${result.onsetSameMachineMs.p99}` +
      ` pipeline ${a.pipeline.p50}/${a.pipeline.p95}/${a.pipeline.p99} buffer ${a.stages.buffer.p50}/${a.stages.buffer.p95}` +
      ` transport ${a.stages.transport.p50}/${a.stages.transport.p99} outages ${result.listener.outages} -> ${file}`,
  );
  expect(a.blocks.analysed).toBeGreaterThan(SECONDS * 50);
  await hostCtx.close();
  await listenerCtx.close();
});
