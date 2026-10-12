import { expect, test, type BrowserContext } from '@playwright/test';
import { musicWav } from './wav';

/**
 * Lossless transport, real stack: the listener must receive exactly the
 * integer samples stored in the host's WAV file — no resampling, no
 * re-quantisation, nothing missing or reordered.
 */
async function ctxFor(
  browser: import('@playwright/test').Browser,
  capture: boolean,
): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript((cap) => {
    localStorage.setItem(
      'mc.settings.v1',
      JSON.stringify({ displayName: 'LL', transport: 'lossless', showDiagnostics: true }),
    );
    if (!cap) return;
    // Observe (copy) PCM handed to the playback worklet; nothing is modified.
    const w = window as unknown as { __rx: Float32Array[] };
    w.__rx = [];
    const orig = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (
      this: MessagePort,
      msg: unknown,
      ...rest: unknown[]
    ) {
      const m = msg as { type?: string; pcm?: Float32Array };
      if (m && m.type === 'pcm' && m.pcm instanceof Float32Array) w.__rx.push(m.pcm.slice());
      return (orig as (...a: unknown[]) => void).call(this, msg, ...rest);
    };
  }, capture);
  return ctx;
}

const FORMATS = [
  { rate: 44_100, bits: 16, label: '44.1 kHz / 16-bit' }, // CD / Apple Music "Lossless"
  { rate: 96_000, bits: 24, label: '96 kHz / 24-bit' }, // Apple Music "Hi-Res Lossless"
  { rate: 192_000, bits: 24, label: '192 kHz / 24-bit' }, // Hi-Res Lossless maximum
] as const;

for (const { rate, bits, label } of FORMATS) {
  test(`lossless mode delivers bit-exact ${label} samples to the listener`, async ({ browser }) => {
    const { wav, pcm } = musicWav(rate > 48_000 ? 12 : 20, rate, bits);
    const hostCtx = await ctxFor(browser, false);
    const listenerCtx = await ctxFor(browser, true);
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
      .setInputFiles({ name: 'cd.wav', mimeType: 'audio/wav', buffer: wav });
    await expect(host.locator('.player-title strong')).toHaveText('cd');
    await expect(host.getByLabel('Stream quality')).toHaveValue('lossless');
    await host.getByRole('button', { name: 'Go live' }).click();

    await listener.goto(`/room/${code}`);
    await listener.getByRole('button', { name: 'Join and listen' }).click();
    await expect(listener.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible({
      timeout: 20_000,
    });
    await host.getByRole('button', { name: 'Play', exact: true }).click();

    await expect(listener.getByTestId('lossless-badge')).toHaveText(`Lossless · ${label}`, {
      timeout: 15_000,
    });
    await expect(host.locator('[data-metric="lossless Format"] dd')).toHaveText(label);
    await listener.waitForTimeout(6000);

    const received = await listener.evaluate(
      (scale) => {
        const chunks = (window as unknown as { __rx: Float32Array[] }).__rx;
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Int32Array(total);
        let o = 0;
        for (const c of chunks)
          for (let i = 0; i < c.length; i++) out[o++] = Math.round(c[i]! * scale);
        return Array.from(out);
      },
      2 ** (bits - 1),
    );
    expect(received.length).toBeGreaterThan(rate * 2 * 3); // > 3 s of stereo audio

    // Skip leading silence (sent before Play was pressed) and locate the first real sample in the file.
    const firstNonZero = received.findIndex((v) => v !== 0);
    expect(firstNonZero).toBeGreaterThanOrEqual(0);
    const start = firstNonZero - (firstNonZero % 2); // align to a stereo frame
    const probe = received.slice(start, start + 64);
    let offset = -1;
    for (let i = 0; i + probe.length <= pcm.length; i += 2) {
      let ok = true;
      for (let j = 0; j < probe.length; j++)
        if (pcm[i + j] !== probe[j]) {
          ok = false;
          break;
        }
      if (ok) {
        offset = i;
        break;
      }
    }
    expect(offset, 'received audio not found in the source file').toBeGreaterThanOrEqual(0);

    // Everything after that point must match the file exactly.
    const tail = received.slice(start);
    const n = Math.min(tail.length, pcm.length - offset);
    let mismatches = 0;
    for (let i = 0; i < n; i++) if (tail[i] !== pcm[offset + i]) mismatches++;
    console.log(
      `[lossless] ${label}: compared ${n} samples (${(n / 2 / rate).toFixed(1)} s), mismatches=${mismatches}`,
    );
    expect(mismatches).toBe(0);

    const metric = async (k: string) =>
      ((await listener.locator(`[data-metric="lossless ${k}"] dd`).textContent()) ?? '').trim();
    const stats = {
      rate: await metric('Lossless data rate'),
      buffer: await metric('Buffer'),
      underruns: await metric('Underruns'),
      gaps: await metric('Sequence gaps'),
      compression: (
        (await host.locator('[data-metric="lossless Compression"] dd').textContent()) ?? ''
      ).trim(),
    };
    console.log(`[lossless] ${label}: ${JSON.stringify(stats)}`);
    expect(stats.gaps).toBe('0');
    await hostCtx.close();
    await listenerCtx.close();
  });
}
