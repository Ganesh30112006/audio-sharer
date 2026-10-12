import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { sineWav } from './wav';

/**
 * Real-stack tests: two isolated browser contexts (host and listener) talk to
 * the FastAPI control plane and a LiveKit SFU. Audio is a generated sine tone,
 * so "audio arrived" is verified by the receiver's measured audio level.
 */

async function newContext(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem(
      'mc.settings.v1',
      JSON.stringify({ displayName: 'E2E', showDiagnostics: true, bufferMode: 'auto', quality: 'high' }),
    );
    // Count peer connections so tests can assert none are leaked or duplicated.
    const Native = window.RTCPeerConnection;
    const w = window as unknown as { __pcs: RTCPeerConnection[] };
    w.__pcs = [];
    window.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        super(...args);
        w.__pcs.push(this);
      }
    } as typeof RTCPeerConnection;
  });
  return ctx;
}

const openPeerConnections = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.filter((pc) => pc.connectionState !== 'closed').length,
  );

async function metric(page: Page, name: string): Promise<string> {
  return (await page.locator(`[data-metric="${name}"] dd`).textContent())?.trim() ?? '';
}

async function createHostedRoom(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Room name').fill('E2E room');
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.waitForURL(/\/host\/[A-Z2-9]{6}$/);
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({ timeout: 20_000 });
  return page.url().split('/').pop()!;
}

async function startTone(page: Page): Promise<void> {
  await page.getByTestId('file-input').setInputFiles({
    name: 'tone.wav',
    mimeType: 'audio/wav',
    buffer: sineWav(30),
  });
  await expect(page.locator('.player-title strong')).toHaveText('tone');
  await page.getByRole('button', { name: 'Go live' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
}

async function join(page: Page, code: string): Promise<void> {
  await page.goto(`/room/${code}`);
  await expect(page.getByRole('heading', { name: 'E2E room' })).toBeVisible();
  await page.getByRole('button', { name: 'Join and listen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({ timeout: 20_000 });
}

test('host streams a file and a listener receives audible Opus audio', async ({ browser }) => {
  const hostCtx = await newContext(browser);
  const listenerCtx = await newContext(browser);
  const host = await hostCtx.newPage();
  const listener = await listenerCtx.newPage();

  const code = await createHostedRoom(host);
  await startTone(host);
  await join(listener, code);

  await expect(listener.getByTestId('now-playing-title')).toHaveText('tone');
  await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => metric(listener, 'Codec'), { timeout: 15_000 }).toContain('opus');
  await expect
    .poll(async () => Number.parseFloat(await metric(listener, 'Audio level')) || 0, { timeout: 15_000 })
    .toBeGreaterThan(0.05);
  await expect
    .poll(async () => Number.parseFloat(await metric(listener, 'Bitrate')) || 0, { timeout: 15_000 })
    .toBeGreaterThan(48);

  // The host sees the listener (batched participant updates).
  await expect(host.getByLabel('1 listeners')).toBeVisible();

  // Pausing on the host is reflected on the listener via the sync channel.
  await host.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(listener.getByText('Waiting for host')).toBeVisible();

  // Record measured numbers in the test output (not asserted beyond sanity).
  const report = {
    rtt: await metric(listener, 'Round trip'),
    jitterBuffer: await metric(listener, 'Jitter buffer'),
    concealed: await metric(listener, 'Concealed audio'),
    estDelay: await metric(listener, 'Est. playback delay'),
  };
  test.info().annotations.push({ type: 'listener-metrics', description: JSON.stringify(report) });

  await listener.getByRole('button', { name: 'Leave' }).click();
  await expect(host.getByLabel('0 listeners')).toBeVisible({ timeout: 10_000 });
  await hostCtx.close();
  await listenerCtx.close();
});

test('repeated join/leave cycles leave no peer connections behind', async ({ browser }) => {
  const hostCtx = await newContext(browser);
  const listenerCtx = await newContext(browser);
  const host = await hostCtx.newPage();
  const listener = await listenerCtx.newPage();
  const code = await createHostedRoom(host);
  await startTone(host);

  const cycles = 5;
  for (let i = 0; i < cycles; i++) {
    await join(listener, code);
    await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({ timeout: 15_000 });
    // One room connection at a time, even under React StrictMode double-mount.
    expect(await openPeerConnections(listener)).toBeLessThanOrEqual(2);
    await listener.getByRole('button', { name: 'Leave' }).click();
    await listener.waitForURL('**/');
    await expect.poll(() => openPeerConnections(listener)).toBe(0);
  }
  await expect(host.getByLabel('0 listeners')).toBeVisible({ timeout: 10_000 });
  // The host kept exactly one connection throughout.
  expect(await openPeerConnections(host)).toBeLessThanOrEqual(2);
  await hostCtx.close();
  await listenerCtx.close();
});

test('a second host tab replaces the first instead of double-publishing', async ({ browser }) => {
  const ctx = await newContext(browser);
  const first = await ctx.newPage();
  const code = await createHostedRoom(first);
  // Same context = same sessionStorage origin, but sessionStorage is per tab; copy the key.
  const key = await first.evaluate((c) => sessionStorage.getItem(`mc.host.${c}`), code);
  const second = await ctx.newPage();
  await second.addInitScript(([c, k]) => sessionStorage.setItem(`mc.host.${c}`, k!), [code, key] as const);
  await second.goto(`/host/${code}`);
  await expect(second.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({ timeout: 20_000 });
  await expect(first.getByText(/opened as host in another tab/)).toBeVisible({ timeout: 10_000 });
  await ctx.close();
});
