/**
 * AudioContext factory. Contexts are only created when a feature needs Web
 * Audio (publishing a file, per-output delay), never per render.
 *
 * 48 kHz matches Opus and most output hardware, avoiding a resampling step;
 * 'playback' latency trades a little output latency for fewer underruns and
 * lower CPU — appropriate for music.
 */
export function createPlaybackContext(): AudioContext {
  try {
    return new AudioContext({ latencyHint: 'playback', sampleRate: 48_000 });
  } catch {
    // Some engines reject an explicit sampleRate; fall back to the device rate.
    return new AudioContext({ latencyHint: 'playback' });
  }
}

type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export async function setContextSink(ctx: AudioContext, deviceId: string): Promise<boolean> {
  const c = ctx as SinkableContext;
  if (!c.setSinkId) return false;
  await c.setSinkId(deviceId);
  return true;
}
