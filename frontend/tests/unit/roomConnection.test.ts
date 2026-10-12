import { beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal fake of the livekit-client surface RoomConnection uses.
const rooms: FakeRoom[] = [];

class FakeRoom {
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  remoteParticipants = new Map<string, unknown>();
  localParticipant = {
    identity: 'host',
    publishTrack: vi.fn(async (track: MediaStreamTrack, _opts?: unknown) => ({
      track: { mediaStreamTrack: track },
      audioTrack: { mediaStreamTrack: track, replaceTrack: vi.fn() },
    })),
    unpublishTrack: vi.fn(async () => undefined),
    publishData: vi.fn(async () => undefined),
  };
  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => undefined);
  startAudio = vi.fn(async () => undefined);
  constructor() {
    rooms.push(this);
  }
  on(e: string, h: (...args: unknown[]) => void) {
    if (!this.handlers.has(e)) this.handlers.set(e, new Set());
    this.handlers.get(e)!.add(h);
    return this;
  }
  off(e: string, h: (...args: unknown[]) => void) {
    this.handlers.get(e)?.delete(h);
    return this;
  }
  emit(e: string, ...args: unknown[]) {
    this.handlers.get(e)?.forEach((h) => h(...args));
  }
  get listenerCount() {
    let n = 0;
    this.handlers.forEach((s) => (n += s.size));
    return n;
  }
}

vi.mock('livekit-client', () => ({
  Room: FakeRoom,
  RoomEvent: {
    Reconnecting: 'reconnecting',
    SignalReconnecting: 'signalReconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
    ParticipantConnected: 'participantConnected',
    ParticipantDisconnected: 'participantDisconnected',
    ConnectionQualityChanged: 'connectionQualityChanged',
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
  },
  DisconnectReason: { DUPLICATE_IDENTITY: 2, ROOM_DELETED: 5, PARTICIPANT_REMOVED: 4 },
  Track: { Source: { Microphone: 'microphone', ScreenShareAudio: 'screen_share_audio' } },
}));

class FakeMediaStream {
  constructor(public tracks: unknown[]) {}
}
vi.stubGlobal('MediaStream', FakeMediaStream);

const { RoomConnection } = await import('../../src/services/roomConnection');
const { policyFor } = await import('../../src/audio/sourcePolicy');

const grant = {
  token: 't',
  url: 'ws://sfu',
  identity: 'host',
  room: 'mc-X',
  role: 'host' as const,
  expires_at: 0,
};

describe('RoomConnection', () => {
  beforeEach(() => {
    rooms.length = 0;
  });

  it('never opens two connections for concurrent connect calls', async () => {
    const conn = new RoomConnection('host');
    await Promise.all([conn.connect(grant), conn.connect(grant), conn.connect(grant)]);
    await conn.connect(grant);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.connect).toHaveBeenCalledTimes(1);
    expect(conn.store.get().state).toBe('connected');
  });

  it('removes every room listener on disconnect and cannot reconnect after', async () => {
    const conn = new RoomConnection('host');
    await conn.connect(grant);
    const room = rooms[0]!;
    expect(room.listenerCount).toBeGreaterThan(0);
    await conn.disconnect();
    expect(room.listenerCount).toBe(0);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    await expect(conn.connect(grant)).rejects.toThrow();
    expect(rooms).toHaveLength(1);
  });

  it('tracks reconnects and recovery time', async () => {
    const conn = new RoomConnection('listener');
    await conn.connect({ ...grant, role: 'listener' });
    const room = rooms[0]!;
    room.emit('reconnecting');
    expect(conn.store.get().state).toBe('reconnecting');
    room.emit('signalReconnecting');
    room.emit('reconnected');
    expect(conn.store.get()).toMatchObject({ state: 'connected', reconnects: 1 });
    expect(conn.store.get().lastRecoveryMs).not.toBeNull();
  });

  it('reports a clear reason when replaced by another host tab', async () => {
    const conn = new RoomConnection('host');
    await conn.connect(grant);
    rooms[0]!.emit('disconnected', 2);
    expect(conn.store.get().state).toBe('disconnected');
    expect(conn.store.get().error).toMatch(/another tab/);
  });

  it('only plays host audio and ignores duplicate subscriptions', async () => {
    const conn = new RoomConnection('listener');
    const onAudio = vi.fn();
    conn.events.on('remoteAudio', onAudio);
    await conn.connect({ ...grant, role: 'listener' });
    const room = rooms[0]!;
    const track = {
      sid: 'TR_1',
      kind: 'audio',
      mediaStreamTrack: {},
      receiver: {},
      setPlayoutDelay: vi.fn(),
    };
    room.emit('trackSubscribed', track, {}, { identity: 'intruder' });
    room.emit('trackSubscribed', track, {}, { identity: 'host' });
    room.emit('trackSubscribed', track, {}, { identity: 'host' });
    expect(onAudio).toHaveBeenCalledTimes(1);
    room.emit('trackUnsubscribed', track);
    expect(onAudio).toHaveBeenLastCalledWith({ stream: null, track: null });
  });

  it('forwards only sync and PCM topic data from participants', async () => {
    const conn = new RoomConnection('listener');
    const onData = vi.fn();
    conn.events.on('data', onData);
    await conn.connect({ ...grant, role: 'listener' });
    const room = rooms[0]!;
    room.emit('dataReceived', new Uint8Array([1]), { identity: 'host' }, 0, 'other');
    room.emit('dataReceived', new Uint8Array([1]), undefined, 0, 'mc.sync.v1');
    room.emit('dataReceived', new Uint8Array([2]), { identity: 'host' }, 0, 'mc.sync.v1');
    room.emit('dataReceived', new Uint8Array([3]), { identity: 'host' }, 0, 'mc.pcm.v1');
    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenCalledWith({
      payload: new Uint8Array([2]),
      from: 'host',
      topic: 'mc.sync.v1',
    });
    expect(onData).toHaveBeenCalledWith({
      payload: new Uint8Array([3]),
      from: 'host',
      topic: 'mc.pcm.v1',
    });
  });

  it('replaces the track in place when the policy is unchanged', async () => {
    const conn = new RoomConnection('host');
    await conn.connect(grant);
    const room = rooms[0]!;
    const policy = policyFor('file', 'high');
    const a = { id: 'a' } as unknown as MediaStreamTrack;
    const b = { id: 'b' } as unknown as MediaStreamTrack;
    await conn.publishAudio(a, policy, 'file');
    await conn.publishAudio(b, policyFor('capture', 'high'), 'capture');
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    const pub = await room.localParticipant.publishTrack.mock.results[0]!.value;
    expect(pub.audioTrack.replaceTrack).toHaveBeenCalledWith(b, true);
    // A different policy (speech microphone) republishes.
    await conn.publishAudio(b, policyFor('microphone', 'high'), 'microphone');
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.publishTrack.mock.calls[1]![1]).toMatchObject({
      dtx: true,
      red: true,
    });
  });

  it('batches participant churn into one store update', async () => {
    vi.useFakeTimers();
    const conn = new RoomConnection('host');
    await conn.connect(grant);
    const room = rooms[0]!;
    const listener = vi.fn();
    vi.advanceTimersByTime(200);
    conn.store.subscribe(listener);
    for (let i = 0; i < 50; i++) {
      room.remoteParticipants.set(`l${i}`, {
        identity: `l${i}`,
        name: `L${i}`,
        connectionQuality: 'good',
      });
      room.emit('participantConnected', { identity: `l${i}` });
    }
    vi.advanceTimersByTime(200);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(conn.store.get().participants).toHaveLength(50);
    vi.useRealTimers();
  });
});
