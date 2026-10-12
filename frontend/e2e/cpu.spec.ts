import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { musicWav, noiseWav } from './wav';

/**
 * CPU cost of the full pipeline, host and listener measured separately.
 *
 * - "renderer CPU %": all threads of that page's renderer process (main,
 *   codec worker, audio rendering), from Chrome's per-process cpuTime.
 * - "main-thread busy %": CDP TaskDuration of the page's main thread only.
 * - "audio service CPU %": Chrome's audio output service process (shared).
 *
 * Variants with `inlineCodec` delete window.Worker so the codec runs on the
 * main thread — showing what the worker moves off the UI thread versus what it
 * actually saves in total CPU. Absolute numbers depend on the machine; compare
 * rows from the same run.
 */
type Scenario = {
  name: string;
  transport: 'opus' | 'lossless';
  rate: number;
  bits: 16 | 24;
  inlineCodec?: boolean;
};
const SCENARIOS: Scenario[] = [
  { name: 'opus studio, 48k file', transport: 'opus', rate: 48_000, bits: 16 },
  { name: 'lossless 44.1/16', transport: 'lossless', rate: 44_100, bits: 16 },
  { name: 'lossless 192/24', transport: 'lossless', rate: 192_000, bits: 24 },
  {
    name: 'lossless 192/24, codec inline (no worker)',
    transport: 'lossless',
    rate: 192_000,
    bits: 24,
    inlineCodec: true,
  },
];
const WINDOW_MS = 15_000;

interface Proc {
  id: number;
  type: string;
  cpuTime: number;
}

async function processes(cdp: CDPSession): Promise<Proc[]> {
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: Proc[] };
  return processInfo;
}

async function rendererPidFor(
  browser: Browser,
  cdp: CDPSession,
  open: () => Promise<Page>,
): Promise<{ page: Page; pid: number }> {
  const before = new Set(
    (await processes(cdp)).filter((p) => p.type === 'renderer').map((p) => p.id),
  );
  const page = await open();
  await page.waitForTimeout(500);
  const fresh = (await processes(cdp)).filter((p) => p.type === 'renderer' && !before.has(p.id));
  expect(fresh.length, 'expected exactly one new renderer process').toBe(1);
  void browser;
  return { page, pid: fresh[0]!.id };
}

for (const sc of SCENARIOS) {
  test(`cpu: ${sc.name}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const bcdp = await browser.newBrowserCDPSession();
    const mkCtx = async () => {
      const ctx = await browser.newContext();
      await ctx.addInitScript(
        ([transport, inline]) => {
          localStorage.setItem(
            'mc.settings.v1',
            JSON.stringify({
              displayName: 'CPU',
              transport,
              quality: 'studio',
              showDiagnostics: false,
            }),
          );
          if (inline) (window as unknown as { Worker?: unknown }).Worker = undefined;
        },
        [sc.transport, !!sc.inlineCodec] as const,
      );
      return ctx;
    };
    const hostCtx = await mkCtx();
    const listenerCtx = await mkCtx();
    const host = await rendererPidFor(browser, bcdp, async () => {
      const p = await hostCtx.newPage();
      await p.goto('/');
      return p;
    });
    await host.page.getByRole('button', { name: 'Create room' }).click();
    await host.page.waitForURL(/\/host\//);
    await expect(host.page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    const code = host.page.url().split('/').pop()!;
    const { wav } =
      sc.transport === 'opus' ? { wav: noiseWav(40, sc.rate) } : musicWav(40, sc.rate, sc.bits);
    await host.page
      .getByTestId('file-input')
      .setInputFiles({ name: 'cpu.wav', mimeType: 'audio/wav', buffer: wav });
    await host.page.getByRole('button', { name: 'Go live' }).click();

    const listener = await rendererPidFor(browser, bcdp, async () => {
      const p = await listenerCtx.newPage();
      await p.goto(`/room/${code}`);
      return p;
    });
    await listener.page.getByRole('button', { name: 'Join and listen' }).click();
    await expect(listener.page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    await host.page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(listener.page.getByText('Receiving audio from the host.')).toBeVisible({
      timeout: 15_000,
    });
    await host.page.waitForTimeout(4000); // settle

    const hcdp = await hostCtx.newCDPSession(host.page);
    const lcdp = await listenerCtx.newCDPSession(listener.page);
    await hcdp.send('Performance.enable');
    await lcdp.send('Performance.enable');
    const task = async (c: CDPSession) =>
      (await c.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')
        ?.value ?? 0;

    const p0 = await processes(bcdp);
    const [h0, l0] = [await task(hcdp), await task(lcdp)];
    const t0 = Date.now();
    await host.page.waitForTimeout(WINDOW_MS);
    const p1 = await processes(bcdp);
    const [h1, l1] = [await task(hcdp), await task(lcdp)];
    const wall = (Date.now() - t0) / 1000;

    const cpu = (pred: (p: Proc) => boolean) => {
      const a = p0.filter(pred).reduce((s, p) => s + p.cpuTime, 0);
      const b = p1.filter(pred).reduce((s, p) => s + p.cpuTime, 0);
      return +(((b - a) / wall) * 100).toFixed(1);
    };
    const row = {
      scenario: sc.name,
      hostRendererCpuPct: cpu((p) => p.id === host.pid),
      hostMainThreadBusyPct: +(((h1 - h0) / wall) * 100).toFixed(1),
      listenerRendererCpuPct: cpu((p) => p.id === listener.pid),
      listenerMainThreadBusyPct: +(((l1 - l0) / wall) * 100).toFixed(1),
      audioServiceCpuPct: cpu((p) => p.type === 'utility'),
      gpuProcessCpuPct: cpu((p) => p.type === 'gpu'),
    };
    console.log(`[cpu] ${JSON.stringify(row)}`);
    test.info().annotations.push({ type: 'cpu', description: JSON.stringify(row) });
    await hostCtx.close();
    await listenerCtx.close();
  });
}
