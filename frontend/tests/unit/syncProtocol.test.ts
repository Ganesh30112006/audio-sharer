import { describe, expect, it } from 'vitest';
import { decodeState, encodeState, projectPosition } from '../../src/services/syncProtocol';
import type { PlaybackState } from '../../src/types/sync';

const base: PlaybackState = {
  epoch: 'abc',
  rev: 3,
  status: 'playing',
  position: 10,
  rate: 1,
  sourceId: 'f1',
  sourceKind: 'file',
  title: 'Song',
  duration: 200,
  at: 1_000_000,
};

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

describe('sync protocol', () => {
  it('round-trips a valid state', () => {
    expect(decodeState(encodeState(base))).toEqual(base);
  });

  it.each([
    ['not json', new TextEncoder().encode('{nope')],
    ['wrong type', enc({ t: 'other', s: base })],
    ['missing state', enc({ t: 'state' })],
    ['bad status', enc({ t: 'state', s: { ...base, status: 'boom' } })],
    ['negative position', enc({ t: 'state', s: { ...base, position: -1 } })],
    ['absurd rate', enc({ t: 'state', s: { ...base, rate: 100 } })],
    ['fractional rev', enc({ t: 'state', s: { ...base, rev: 1.5 } })],
    ['huge title', enc({ t: 'state', s: { ...base, title: 'x'.repeat(300) } })],
    ['bad kind', enc({ t: 'state', s: { ...base, sourceKind: 'video' } })],
    ['empty', new Uint8Array()],
    ['oversized', new Uint8Array(5000)],
  ])('rejects %s', (_label, bytes) => {
    expect(decodeState(bytes)).toBeNull();
  });

  it('projects position while playing, clamped to duration', () => {
    expect(projectPosition(base, base.at + 2500)).toBeCloseTo(12.5);
    expect(projectPosition({ ...base, rate: 2 }, base.at + 1000)).toBeCloseTo(12);
    expect(projectPosition(base, base.at + 1e9)).toBe(200);
    expect(projectPosition({ ...base, status: 'paused' }, base.at + 5000)).toBe(10);
    // Clock skew where the state appears to come from the future never runs backwards.
    expect(projectPosition(base, base.at - 500)).toBe(10);
  });
});
