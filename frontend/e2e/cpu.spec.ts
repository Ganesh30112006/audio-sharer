import { expect, test, type Browser, type CDPSession } from '@playwright/test';
import { musicWav, noiseWav } from './wav';

/**
 * CPU cost of the full pipeline, host and listener measured separately.
 *
 * Each side runs in its own browser instance; per-process cpuTime (Chrome's
 * SystemInfo.getProcessInfo) is sampled at the start and end of the same
 * window, grouped by process type (renderer = page main thread + codec worker
 * + audio rendering thread; utility = audio service; gpu; browser).
 * "mainThreadBusy" is CDP TaskDuration of the page's main thread only.
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

/** CPU % per process type over the window, for one browser instance (its whole process tree). */
function cpuByType(before: Proc[], after: Proc[], wallS: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of after) {
    const prev = before.find((b) => b.id === p.id)?.cpuTime ?? 0;
    out[p.type] = (out[p.type] ?? 0) + ((p.cpuTime - prev) / wallS) * 100;
  }
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(out)) out[k] = +out[k]!.toFixed(1);
  return out;
}

for (const sc of SCENARIOS) {
  test(`cpu: ${sc.name}`, async ({ playwright, launchOptions }) => {
    test.setTimeout(120_000);
    // Host and listener each get their own browser instance, so each side's
    // full process tree (renderer + workers + audio service + GPU) is
    // attributed unambiguously.
    const hostBrowser = await playwright.chromium.launch(launchOptions);
    const listenerBrowser = await playwright.chromium.launch(launchOptions);
    const setup = async (b: Browser) => {
      const ctx = await b.newContext({ baseURL: 'http://127.0.0.1:5173' });
      await ctx.addInitScript(
        ([transport, inline]) => {
          if (location.protocol.startsWith('http'))
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
    const hostCtx = await setup(hostBrowser);
    const listenerCtx = await setup(listenerBrowser);
    const host = await hostCtx.newPage();
    const listener = await listenerCtx.newPage();
    await host.goto('/');
    await host.getByRole('button', { name: 'Create room' }).click();
    await host.waitForURL(/\/host\//);
    await expect(host.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    const code = host.url().split('/').pop()!;
    const { wav } =
      sc.transport === 'opus' ? { wav: noiseWav(40, sc.rate) } : musicWav(40, sc.rate, sc.bits);
    await host
      .getByTestId('file-input')
      .setInputFiles({ name: 'cpu.wav', mimeType: 'audio/wav', buffer: wav });
    await host.getByRole('button', { name: 'Go live' }).click();
    await listener.goto(`/room/${code}`);
    await listener.getByRole('button', { name: 'Join and listen' }).click();
    await expect(listener.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    await host.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({
      timeout: 15_000,
    });
    await host.waitForTimeout(4000); // settle

    const hb = await hostBrowser.newBrowserCDPSession();
    const lb = await listenerBrowser.newBrowserCDPSession();
    const hcdp = await hostCtx.newCDPSession(host);
    const lcdp = await listenerCtx.newCDPSession(listener);
    await hcdp.send('Performance.enable');
    await lcdp.send('Performance.enable');
    const task = async (c: CDPSession) =>
      (await c.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')
        ?.value ?? 0;

    const [hp0, lp0, h0, l0] = [
      await processes(hb),
      await processes(lb),
      await task(hcdp),
      await task(lcdp),
    ];
    const t0 = Date.now();
    await host.waitForTimeout(WINDOW_MS);
    const [hp1, lp1, h1, l1] = [
      await processes(hb),
      await processes(lb),
      await task(hcdp),
      await task(lcdp),
    ];
    const wall = (Date.now() - t0) / 1000;

    const row = {
      scenario: sc.name,
      windowS: +wall.toFixed(1),
      host: {
        ...cpuByType(hp0, hp1, wall),
        mainThreadBusy: +(((h1 - h0) / wall) * 100).toFixed(1),
      },
      listener: {
        ...cpuByType(lp0, lp1, wall),
        mainThreadBusy: +(((l1 - l0) / wall) * 100).toFixed(1),
      },
    };
    console.log(`[cpu] ${JSON.stringify(row)}`);
    test.info().annotations.push({ type: 'cpu', description: JSON.stringify(row) });
    await hostBrowser.close();
    await listenerBrowser.close();
  });
}
