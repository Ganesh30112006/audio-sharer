import { describe, expect, it, vi } from 'vitest';
import { SyncPublisher, SyncReceiver } from '../../src/services/syncService';
import type { PlaybackState } from '../../src/types/sync';

const input = {
  status: 'playing' as const,
  position: 0,
  rate: 1,
  sourceId: 'a',
  sourceKind: 'file' as const,
  title: 'A',
  duration: 100,
};

describe('SyncPublisher', () => {
  it('sends only meaningful changes', () => {
    let now = 0;
    const send = vi.fn();
    const pub = new SyncPublisher(() => now, send, 'e1');
    expect(pub.update(input)).toBe(true);
    now = 1000;
    // Natural progress (position advanced as expected) is not re-sent.
    expect(pub.update({ ...input, position: 1.05 })).toBe(false);
    // A seek is.
    expect(pub.update({ ...input, position: 30 })).toBe(true);
    now = 2000;
    expect(pub.update({ ...input, position: 31, status: 'paused' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    const revs = send.mock.calls.map((c) => (c[0] as PlaybackState).rev);
    expect(revs).toEqual([0, 1, 2]);
  });

  it('sends snapshots to a single participant', () => {
    const send = vi.fn();
    const pub = new SyncPublisher(() => 0, send, 'e1');
    pub.sendSnapshot('x');
    expect(send).not.toHaveBeenCalled();
    pub.update(input);
    pub.sendSnapshot('listener-1');
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ rev: 0 }), ['listener-1']);
  });
});

describe('SyncReceiver', () => {
  const state = (epoch: string, rev: number): PlaybackState => ({ ...input, epoch, rev, at: 0 });

  it('drops stale and duplicate revisions', () => {
    const rx = new SyncReceiver(() => 0);
    expect(rx.accept(state('e', 2))).toBe(true);
    expect(rx.accept(state('e', 2))).toBe(false);
    expect(rx.accept(state('e', 1))).toBe(false);
    expect(rx.accept(state('e', 3))).toBe(true);
    expect(rx.store.get().dropped).toBe(2);
  });

  it('accepts a new epoch after a host restart', () => {
    const rx = new SyncReceiver(() => 0);
    rx.accept(state('old', 50));
    expect(rx.accept(state('new', 0))).toBe(true);
    expect(rx.store.get().playback?.epoch).toBe('new');
  });

  it('projects the current position from the server clock', () => {
    let now = 0;
    const rx = new SyncReceiver(() => now);
    expect(rx.position()).toBeNull();
    rx.accept({ ...state('e', 0), position: 5 });
    now = 3000;
    expect(rx.position()).toBeCloseTo(8);
  });
});
