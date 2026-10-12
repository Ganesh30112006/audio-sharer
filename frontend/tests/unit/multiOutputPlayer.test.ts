import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/audio/capabilities', () => ({
  getCapabilities: () => ({ setSinkId: true }),
}));

const { MultiOutputPlayer, MAX_OUTPUTS } = await import('../../src/audio/MultiOutputPlayer');

beforeEach(() => {
  // jsdom has no media pipeline; stub the parts the player touches.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  Object.assign(HTMLMediaElement.prototype, {
    setSinkId: vi.fn(async () => undefined),
    sinkId: '',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const dev = (id: string) => ({ deviceId: id, label: `Device ${id || 'default'}` });

describe('MultiOutputPlayer', () => {
  it('bounds the number of outputs and rejects duplicate devices', async () => {
    const p = new MultiOutputPlayer();
    for (let i = 0; i < MAX_OUTPUTS; i++) await p.addOutput(dev(String(i)));
    await expect(p.addOutput(dev('extra'))).rejects.toThrow(/At most/);
    await expect(p.addOutput(dev('0'))).rejects.toThrow(/already in use/);
    expect(p.store.get().slots).toHaveLength(MAX_OUTPUTS);
    p.dispose();
  });

  it('flags autoplay blocking instead of failing silently', async () => {
    const p = new MultiOutputPlayer();
    await p.addOutput(dev(''));
    p.setSource({ kind: 'url', url: 'blob:x' });
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError'),
    );
    await p.play();
    expect(p.store.get().needsGesture).toBe(true);
    p.dispose();
  });

  it('nudges a drifting follower with playbackRate, not pauses', async () => {
    vi.useFakeTimers();
    const p = new MultiOutputPlayer();
    await p.addOutput(dev('a'));
    await p.addOutput(dev('b'));
    p.setSource({ kind: 'url', url: 'blob:x' });
    await p.play();
    const els = document.querySelectorAll('audio');
    expect(els).toHaveLength(0); // elements are detached, never in the DOM

    // Reach into the slots through the public seek/current API: give the follower a 60 ms lead.
    const internals = p as unknown as { slots: Array<{ el: HTMLAudioElement }> };
    const [leader, follower] = internals.slots;
    for (const el of [leader!.el, follower!.el]) {
      Object.defineProperty(el, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(el, 'seeking', { value: false, configurable: true });
    }
    Object.defineProperty(leader!.el, 'currentTime', {
      value: 10,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(follower!.el, 'currentTime', {
      value: 10.06,
      configurable: true,
      writable: true,
    });
    vi.advanceTimersByTime(300);
    expect(follower!.el.playbackRate).toBeLessThan(1);
    expect(follower!.el.paused).toBe(false);
    expect(p.driftMs(p.store.get().slots[1]!.slotId)).toBeCloseTo(60, 0);

    p.pause();
    expect(follower!.el.playbackRate).toBe(1);
    p.dispose();
  });

  it('routes a stream directly and only builds Web Audio when a delay is set', async () => {
    const ctxClose = vi.fn(async () => undefined);
    const node = () => ({
      connect: vi.fn((n: unknown) => n),
      disconnect: vi.fn(),
      delayTime: { value: 0, setTargetAtTime: vi.fn() },
    });
    class FakeCtx {
      close = ctxClose;
      resume = vi.fn(async () => undefined);
      createMediaStreamSource = vi.fn(node);
      createDelay = vi.fn(node);
      createMediaStreamDestination = vi.fn(() => ({
        ...node(),
        stream: { getTracks: () => [{ stop: vi.fn() }] },
      }));
    }
    vi.stubGlobal('AudioContext', FakeCtx);
    const p = new MultiOutputPlayer();
    await p.addOutput(dev(''));
    const stream = {} as MediaStream;
    p.setSource({ kind: 'stream', stream });
    const slotId = p.store.get().slots[0]!.slotId;
    const el = (p as unknown as { slots: Array<{ el: HTMLAudioElement }> }).slots[0]!.el;
    expect(el.srcObject).toBe(stream);
    expect(p.store.get().graphActive).toBe(false);

    p.setDelay(slotId, 120);
    expect(p.store.get().graphActive).toBe(true);
    expect(el.srcObject).not.toBe(stream);

    p.setDelay(slotId, 0);
    expect(p.store.get().graphActive).toBe(false);
    expect(el.srcObject).toBe(stream);
    expect(ctxClose).toHaveBeenCalledTimes(1);
    p.dispose();
    vi.unstubAllGlobals();
  });

  it('marks outputs whose device disappeared', async () => {
    const p = new MultiOutputPlayer();
    await p.addOutput(dev(''));
    await p.addOutput(dev('bt'));
    p.reconcileDevices([dev('')]);
    expect(p.store.get().slots[1]!.status).toBe('missing');
    p.reconcileDevices([dev(''), dev('bt')]);
    expect(p.store.get().slots[1]!.status).toBe('ok');
    p.dispose();
  });
});
