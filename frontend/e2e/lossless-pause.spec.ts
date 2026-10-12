import { expect, test, type Page } from '@playwright/test';
import { burstWav } from './wav';

/**
 * Pausing the host suspends its audio graph (after 1.5 s idle). On resume the
 * stream's sample timeline continues seamlessly, but wall time jumped. The
 * listener must treat that as a restart, not as network jitter: its playback
 * buffer must come back at its normal size, not inflate by the pause length.
 */
async function ctxWithSettings(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    if (location.protocol.startsWith('http'))
      localStorage.setItem(
        'mc.settings.v1',
        JSON.stringify({
          displayName: 'P',
          transport: 'lossless',
          bufferMode: 'auto',
          showDiagnostics: true,
        }),
      );
  });
  return ctx;
}

const targetMs = async (p: Page) =>
  Number(
    ((await p.locator('[data-metric="lossless Buffer target"] dd').textContent()) ?? '').split(
      ' ',
    )[0],
  );
const metric = async (p: Page, k: string) =>
  ((await p.locator(`[data-metric="lossless ${k}"] dd`).textContent()) ?? '').trim();

// 2 s: the host still sends 1.5 s of silence before suspending, so only a
// 0.5 s jump remains. 5 s: a long pause.
for (const pauseMs of [2000, 5000])
  test(`host pause of ${pauseMs / 1000} s: listener buffer recovers at its normal size`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const host = await (await ctxWithSettings(browser)).newPage();
    const listener = await (await ctxWithSettings(browser)).newPage();
    await host.goto('/');
    await host.getByRole('button', { name: 'Create room' }).click();
    await host.waitForURL(/\/host\//);
    await expect(host.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    const code = host.url().split('/').pop()!;
    await host
      .getByTestId('file-input')
      .setInputFiles({ name: 'clicks.wav', mimeType: 'audio/wav', buffer: burstWav(90) });
    await host.getByRole('button', { name: 'Go live' }).click();
    await listener.goto(`/room/${code}`);
    await listener.getByRole('button', { name: 'Join and listen' }).click();
    await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({
      timeout: 20_000,
    });
    await host.getByRole('button', { name: 'Play', exact: true }).click();
    await listener.waitForTimeout(10_000);
    const before = await targetMs(listener);
    expect(before).toBeGreaterThan(0);

    const outagesBefore = await metric(listener, 'Outages');
    await host.getByRole('button', { name: 'Pause', exact: true }).click();
    await host.waitForTimeout(pauseMs); // > 1.5 s: the host's audio graph is suspended
    await host.getByRole('button', { name: 'Play', exact: true }).click();
    await listener.waitForTimeout(15_000);

    const after = await targetMs(listener);
    console.log(
      `[pause ${pauseMs}] target before ${before} ms, after ${after} ms; ` +
        `announced gaps ${await metric(listener, 'Announced gaps')}, ` +
        `unannounced ${await metric(listener, 'Unannounced gaps')}, ` +
        `corrections ${await metric(listener, 'Clock corrections')}`,
    );
    // Without the fix the pause is mistaken for jitter: the target jumps to its
    // 750 ms cap and stays there for minutes.
    expect(after).toBeLessThan(Math.max(before, 60) + 40);
    expect(await metric(listener, 'Unannounced gaps')).toBe('0');
    // The host pausing is not a listener outage.
    expect(await metric(listener, 'Outages')).toBe(outagesBefore);
  });
