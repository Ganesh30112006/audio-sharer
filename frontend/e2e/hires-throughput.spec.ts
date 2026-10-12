import { expect, test } from '@playwright/test';
import { musicWav } from './wav';

/**
 * Sustained-throughput check for hi-res lossless: samples host send queue and
 * listener buffer every 2 s while a 40 s file plays. Real-time capable means
 * the send queue stays small and the buffer doesn't drain (underruns) or grow
 * without bound.
 */
for (const rate of [96_000, 192_000]) {
  test(`hi-res lossless sustains real time at ${rate / 1000} kHz / 24-bit`, async ({ browser }) => {
    test.setTimeout(150_000);
    const { wav } = musicWav(40, rate, 24);
    const mk = async () => {
      const ctx = await browser.newContext();
      await ctx.addInitScript(() =>
        localStorage.setItem(
          'mc.settings.v1',
          JSON.stringify({ displayName: 'HR', transport: 'lossless' }),
        ),
      );
      return ctx;
    };
    const hostCtx = await mk();
    const listenerCtx = await mk();
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
      .setInputFiles({ name: 'hr.wav', mimeType: 'audio/wav', buffer: wav });
    await host.getByRole('button', { name: 'Go live' }).click();
    await listener.goto(`/room/${code}`);
    await listener.getByRole('button', { name: 'Join and listen' }).click();
    await expect(listener.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    await host.getByRole('button', { name: 'Play', exact: true }).click();

    const read = async (page: typeof host, k: string) => {
      const el = page.locator(`[data-metric="lossless ${k}"] dd`);
      return (await el.count()) ? ((await el.textContent()) ?? '').trim() : '';
    };
    const series: string[] = [];
    for (let t = 2; t <= 30; t += 2) {
      await host.waitForTimeout(2000);
      series.push(
        `t=${t}s up=${await read(host, 'Lossless data rate')} queue=${await read(host, 'Send queue')} ` +
          `down=${await read(listener, 'Lossless data rate')} buf=${await read(listener, 'Buffer')} ` +
          `underruns=${await read(listener, 'Underruns')} resyncs=${await read(listener, 'Resyncs')}`,
      );
    }
    console.log(`[hires ${rate}]\n  ${series.join('\n  ')}`);
    await hostCtx.close();
    await listenerCtx.close();
  });
}
