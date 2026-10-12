import { expect, test } from '@playwright/test';
import { installOnsetProbe, pairLatencies, percentile, readOnsets } from './probes';
import { burstWav } from './wav';

/**
 * Measures the media pipeline latency: host pre-encode → Opus encode → SFU →
 * listener jitter buffer → decode. It excludes output-device latency
 * (speakers/Bluetooth), which browsers can't observe. Results are written to
 * the test annotations and stdout; only a loose sanity bound is asserted
 * because the number depends on machine and network.
 */
interface Scenario {
  name: string;
  bufferMode: 'auto' | 'stable';
  /** Listener-side WebRTC impairment via Chrome DevTools network emulation. */
  impair?: { latency: number; packetLoss: number; packetReordering?: boolean };
}

const scenarios: Scenario[] = [
  { name: 'clean network, auto buffer', bufferMode: 'auto' },
  { name: 'clean network, stable buffer', bufferMode: 'stable' },
  {
    name: '3% packet loss, auto buffer',
    bufferMode: 'auto',
    impair: { latency: 0, packetLoss: 3 },
  },
  {
    name: '3% packet loss, stable buffer',
    bufferMode: 'stable',
    impair: { latency: 0, packetLoss: 3 },
  },
];

for (const { name, bufferMode, impair } of scenarios) {
  test(`pipeline latency: ${name}`, async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const listenerCtx = await browser.newContext();
    for (const c of [hostCtx, listenerCtx]) {
      await c.addInitScript((mode) => {
        localStorage.setItem(
          'mc.settings.v1',
          JSON.stringify({ displayName: 'Probe', bufferMode: mode, showDiagnostics: true }),
        );
      }, bufferMode);
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
      .setInputFiles({ name: 'clicks.wav', mimeType: 'audio/wav', buffer: burstWav(40) });
    await host.getByRole('button', { name: 'Go live' }).click();

    if (impair) {
      const cdp = await listenerCtx.newCDPSession(listener);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: impair.latency,
        downloadThroughput: -1,
        uploadThroughput: -1,
        packetLoss: impair.packetLoss,
        packetReordering: impair.packetReordering ?? false,
      });
    }
    await listener.goto(`/room/${code}`);
    await listener.getByRole('button', { name: 'Join and listen' }).click();
    await expect(listener.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(listener.getByText('Receiving audio from the host.')).toBeVisible({
      timeout: 15_000,
    });

    await host.getByRole('button', { name: 'Play', exact: true }).click();
    // Let the jitter buffer settle, then measure ~20 bursts.
    await host.waitForTimeout(25_000);

    const lat = pairLatencies(await readOnsets(host), await readOnsets(listener)).slice(3);
    const metric = async (k: string) =>
      ((await listener.locator(`[data-metric="${k}"] dd`).textContent()) ?? '').trim();
    const result = {
      scenario: name,
      samples: lat.length,
      medianMs: Math.round(percentile(lat, 50)),
      p95Ms: Math.round(percentile(lat, 95)),
      minMs: Math.round(Math.min(...lat)),
      maxMs: Math.round(Math.max(...lat)),
      packetLoss: await metric('Packet loss'),
      concealmentEvents: await metric('Concealment events'),
      jitterBuffer: await metric('Jitter buffer'),
    };
    console.log(`[latency] ${JSON.stringify(result)}`);
    test.info().annotations.push({ type: 'latency', description: JSON.stringify(result) });
    expect(lat.length).toBeGreaterThanOrEqual(10);
    expect(result.medianMs).toBeGreaterThan(0);
    expect(result.medianMs).toBeLessThan(1000);
    await hostCtx.close();
    await listenerCtx.close();
  });
}
