/**
 * AudioContext factory. Contexts are only created when a feature needs Web
 * Audio (publishing a file, per-output delay), never per render.
 *
 * 48 kHz matches Opus and most output hardware, avoiding a resampling step.
 * 'playback' (default) uses larger render blocks: fewer underruns, lower CPU,
 * fine for local delay chains. The broadcast tap uses 'interactive' because
 * its block size adds directly to end-to-end latency.
 */
export function createPlaybackContext(
  latencyHint: AudioContextLatencyCategory = 'playback',
): AudioContext {
  try {
    return new AudioContext({ latencyHint, sampleRate: 48_000 });
  } catch {
    // Some engines reject an explicit sampleRate; fall back to the device rate.
    return new AudioContext({ latencyHint });
  }
}

type SinkableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export async function setContextSink(ctx: AudioContext, deviceId: string): Promise<boolean> {
  const c = ctx as SinkableContext;
  if (!c.setSinkId) return false;
  await c.setSinkId(deviceId);
  return true;
}
