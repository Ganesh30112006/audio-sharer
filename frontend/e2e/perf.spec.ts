import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { sineWav } from './wav';

/**
 * Resource measurements against the real stack. Numbers are printed as
 * `[perf] {...}` lines and attached as annotations; assertions only check
 * properties that must hold regardless of machine speed (constant host uplink
 * as listeners grow, bounded memory, no listener/DOM leaks).
 *
 *   SOAK_MINUTES=60 npx playwright test e2e/perf.spec.ts -g soak
 */
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? 3);
/** PERF_TRANSPORT=lossless runs the same measurements over the lossless data-channel path. */
const TRANSPORT = process.env.PERF_TRANSPORT === 'lossless' ? 'lossless' : 'opus';

async function ctxWithSettings(browser: Browser, name: string): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ([n, transport]) => {
      localStorage.setItem(
        'mc.settings.v1',
        JSON.stringify({ displayName: n, showDiagnostics: true, transport }),
      );
    },
    [name, TRANSPORT] as const,
  );
  return ctx;
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

async function gcAndSample(cdp: CDPSession) {
  await cdp.send('HeapProfiler.collectGarbage');
  const m = await metrics(cdp);
  return {
    heapMB: +(m.JSHeapUsedSize! / 2 ** 20).toFixed(2),
    nodes: m.Nodes!,
    listeners: m.JSEventListeners!,
    taskSec: m.TaskDuration!,
  };
}

const metric = async (page: Page, k: string) => {
  const el = page.locator(`[data-metric="${k}"] dd`);
  return (await el.count()) ? ((await el.textContent()) ?? '').trim() : '';
};

async function hostWithQueue(
  browser: Browser,
): Promise<{ ctx: BrowserContext; page: Page; code: string; cdp: CDPSession }> {
  const ctx = await ctxWithSettings(browser, 'Host');
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto('/');
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.waitForURL(/\/host\//);
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
    timeout: 20_000,
  });
  const code = page.url().split('/').pop()!;
  await page.getByTestId('file-input').setInputFiles([
    { name: 'a.wav', mimeType: 'audio/wav', buffer: sineWav(20, 330) },
    { name: 'b.wav', mimeType: 'audio/wav', buffer: sineWav(20, 440) },
    { name: 'c.wav', mimeType: 'audio/wav', buffer: sineWav(20, 550) },
  ]);
  await page.getByRole('button', { name: 'Repeat queue' }).click();
  await page.getByRole('button', { name: 'Go live' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  return { ctx, page, code, cdp };
}

async function addListener(browser: Browser, code: string, i: number) {
  const ctx = await ctxWithSettings(browser, `L${i}`);
  const page = await ctx.newPage();
  await page.goto(`/room/${code}`);
  await page.getByRole('button', { name: 'Join and listen' }).click();
  await expect(page.getByText('Receiving audio from the host.')).toBeVisible({ timeout: 20_000 });
  return { ctx, page };
}

test('host cost stays flat as listeners join (SFU fan-out)', async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await hostWithQueue(browser);
  const listeners: Array<{ ctx: BrowserContext; page: Page }> = [];
  const rows: Array<Record<string, number | string>> = [];

  for (const target of [1, 4, 8]) {
    while (listeners.length < target)
      listeners.push(await addListener(browser, host.code, listeners.length));
    await expect(host.page.getByLabel(`${target} listeners`)).toBeVisible({ timeout: 15_000 });
    await host.page.waitForTimeout(4000);
    const before = await metrics(host.cdp);
    const t0 = Date.now();
    await host.page.waitForTimeout(10_000);
    const after = await metrics(host.cdp);
    const wall = (Date.now() - t0) / 1000;
    rows.push({
      listeners: target,
      hostUplinkKbps: Number.parseFloat(
        await metric(
          host.page,
          TRANSPORT === 'lossless' ? 'lossless Lossless data rate' : 'Bitrate',
        ),
      ),
      hostMainThreadBusyPct: +(((after.TaskDuration! - before.TaskDuration!) / wall) * 100).toFixed(
        2,
      ),
      hostScriptMsPerSec: +(
        ((after.ScriptDuration! - before.ScriptDuration!) / wall) *
        1000
      ).toFixed(2),
      hostHeapMB: +(after.JSHeapUsedSize! / 2 ** 20).toFixed(1),
    });
  }
  console.log(`[perf] scaling (${TRANSPORT}) ${JSON.stringify(rows)}`);
  test.info().annotations.push({ type: 'scaling', description: JSON.stringify(rows) });

  // One upstream regardless of audience size: uplink must not grow with listeners.
  const uplinks = rows.map((r) => r.hostUplinkKbps as number);
  expect(Math.max(...uplinks)).toBeLessThan(Math.min(...uplinks) * 1.5);
  for (const l of listeners) await l.ctx.close();
  await host.ctx.close();
});

test(`soak: ${SOAK_MINUTES} min of playback with track changes stays bounded`, async ({
  browser,
}) => {
  test.setTimeout((SOAK_MINUTES * 60 + 180) * 1000);
  const host = await hostWithQueue(browser);
  const listener = await addListener(browser, host.code, 0);
  const lcdp = await listener.ctx.newCDPSession(listener.page);
  await lcdp.send('Performance.enable');

  const samples: Array<Record<string, number>> = [];
  const sampleEveryMs = 30_000;
  const end = Date.now() + SOAK_MINUTES * 60_000;
  // Warm-up sample after the first track transition has happened.
  await host.page.waitForTimeout(25_000);
  while (Date.now() < end) {
    const h = await gcAndSample(host.cdp);
    const l = await gcAndSample(lcdp);
    samples.push({
      tMin: +((Date.now() - (end - SOAK_MINUTES * 60_000)) / 60_000).toFixed(1),
      hostHeapMB: h.heapMB,
      hostNodes: h.nodes,
      hostListeners: h.listeners,
      listenerHeapMB: l.heapMB,
      listenerNodes: l.nodes,
      listenerListeners: l.listeners,
      concealmentEvents:
        Number.parseInt(await metric(listener.page, 'Concealment events'), 10) || 0,
      reconnects: Number.parseInt(await metric(listener.page, 'Reconnects'), 10) || 0,
      losslessUnderruns:
        Number.parseInt(await metric(listener.page, 'lossless Underruns'), 10) || 0,
      losslessResyncs: Number.parseInt(await metric(listener.page, 'lossless Resyncs'), 10) || 0,
      losslessClockCorrections:
        Number.parseInt(await metric(listener.page, 'lossless Clock corrections'), 10) || 0,
    });
    await host.page.waitForTimeout(Math.min(sampleEveryMs, Math.max(0, end - Date.now())));
  }
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const summary = {
    minutes: SOAK_MINUTES,
    samples: samples.length,
    hostHeapGrowthMB: +(last.hostHeapMB! - first.hostHeapMB!).toFixed(2),
    listenerHeapGrowthMB: +(last.listenerHeapMB! - first.listenerHeapMB!).toFixed(2),
    hostListenersDelta: last.hostListeners! - first.hostListeners!,
    listenerListenersDelta: last.listenerListeners! - first.listenerListeners!,
    hostNodesDelta: last.hostNodes! - first.hostNodes!,
    transport: TRANSPORT,
    concealmentEvents: last.concealmentEvents,
    reconnects: last.reconnects,
    losslessUnderruns: last.losslessUnderruns,
    losslessResyncs: last.losslessResyncs,
    losslessClockCorrections: last.losslessClockCorrections,
  };
  console.log(`[perf] soak-samples ${JSON.stringify(samples)}`);
  console.log(`[perf] soak ${JSON.stringify(summary)}`);
  test.info().annotations.push({ type: 'soak', description: JSON.stringify(summary) });

  expect(summary.hostHeapGrowthMB).toBeLessThan(10);
  expect(summary.listenerHeapGrowthMB).toBeLessThan(10);
  expect(Math.abs(summary.hostListenersDelta)).toBeLessThan(50);
  expect(summary.reconnects).toBe(0);
  await listener.ctx.close();
  await host.ctx.close();
});
