import { expect, test, type Page } from '@playwright/test';
import { musicWav } from './wav';

/**
 * End-to-end user flows that change the stream while listeners are connected:
 * a track change with a different sample rate / bit depth (the listener
 * rebuilds its playback graph), and live transport switches lossless -> Opus
 * -> lossless. Both pages must stay free of errors, and continuity must never
 * break without being announced.
 */
async function page(browser: import('@playwright/test').Browser): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    if (location.protocol.startsWith('http'))
      localStorage.setItem(
        'mc.settings.v1',
        JSON.stringify({ displayName: 'U', transport: 'lossless', showDiagnostics: true }),
      );
  });
  return ctx.newPage();
}

function collectErrors(p: Page, name: string, into: string[]) {
  p.on('pageerror', (e) => into.push(`${name} pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') into.push(`${name} console: ${m.text()}`);
  });
}

const metric = async (p: Page, k: string) =>
  ((await p.locator(`[data-metric="lossless ${k}"] dd`).textContent()) ?? '').trim();

test('track change across formats and live transport switches', async ({ browser }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const host = await page(browser);
  const listener = await page(browser);
  collectErrors(host, 'host', errors);
  collectErrors(listener, 'listener', errors);

  await host.goto('/');
  await host.getByRole('button', { name: 'Create room' }).click();
  await host.waitForURL(/\/host\//);
  await expect(host.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
    timeout: 20_000,
  });
  const code = host.url().split('/').pop()!;
  await host.getByTestId('file-input').setInputFiles([
    { name: 'cd.wav', mimeType: 'audio/wav', buffer: musicWav(40, 44_100, 16).wav },
    { name: 'studio.wav', mimeType: 'audio/wav', buffer: musicWav(40, 48_000, 24).wav },
  ]);
  await expect(host.locator('.player-title strong')).toHaveText('cd');
  await host.getByRole('button', { name: 'Go live' }).click();
  await listener.goto(`/room/${code}`);
  await listener.getByRole('button', { name: 'Join and listen' }).click();
  await expect(listener.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
    timeout: 20_000,
  });
  await host.getByRole('button', { name: 'Play', exact: true }).click();
  const badge = listener.getByTestId('lossless-badge');
  await expect(badge).toHaveText('Lossless · 44.1 kHz / 16-bit', { timeout: 15_000 });
  await listener.waitForTimeout(4000);

  // 1. Next track: 48 kHz / 24-bit. The listener rebuilds its playback graph.
  await host.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(host.locator('.player-title strong')).toHaveText('studio');
  await expect(badge).toHaveText('Lossless · 48 kHz / 24-bit', { timeout: 15_000 });
  await listener.waitForTimeout(4000);
  expect(await metric(listener, 'Unannounced gaps')).toBe('0');
  expect(Number(await metric(listener, 'Frames played'))).toBeGreaterThan(48_000);

  // 2. Live switch to Opus: lossless panel goes away, audio keeps flowing.
  await host.getByLabel('Stream quality').selectOption('studio');
  await expect(badge).toBeHidden({ timeout: 15_000 });
  await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({
    timeout: 15_000,
  });
  await listener.waitForTimeout(4000);

  // 3. And back to lossless.
  await host.getByLabel('Stream quality').selectOption('lossless');
  await expect(badge).toHaveText('Lossless · 48 kHz / 24-bit', { timeout: 15_000 });
  await listener.waitForTimeout(4000);
  expect(await metric(listener, 'Unannounced gaps')).toBe('0');
  expect(Number(await metric(listener, 'Frames played'))).toBeGreaterThan(48_000);

  expect(errors, errors.join('\n')).toEqual([]);
});
