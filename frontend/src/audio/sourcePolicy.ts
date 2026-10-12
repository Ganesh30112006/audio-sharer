import type { SourceKind } from '../types/sync';

export type QualityPreset = 'standard' | 'high';

/**
 * Per-source capture and transport policy. Music must not go through voice
 * processing (echo cancellation / noise suppression / AGC damage it), and DTX
 * would cut quiet passages. Speech benefits from both, plus RED redundancy
 * because its bitrate is low enough for duplication to be cheap.
 */
export interface SourcePolicy {
  constraints: MediaTrackConstraints;
  publish: {
    maxBitrate: number;
    dtx: boolean;
    red: boolean;
    forceStereo: boolean;
  };
  /** LiveKit track source this is published as (server restricts allowed sources). */
  trackSource: 'microphone' | 'screen_share_audio';
}

const MUSIC_BITRATE: Record<QualityPreset, number> = { standard: 64_000, high: 128_000 };

export function policyFor(
  kind: SourceKind,
  quality: QualityPreset,
  opts: { voiceProcessing?: boolean } = {},
): SourcePolicy {
  const noProcessing: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48_000 },
  };
  switch (kind) {
    case 'file':
    case 'capture':
      return {
        constraints: noProcessing,
        publish: { maxBitrate: MUSIC_BITRATE[quality], dtx: false, red: false, forceStereo: true },
        trackSource: 'screen_share_audio',
      };
    case 'microphone': {
      const voice = opts.voiceProcessing ?? true;
      return {
        constraints: voice
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              channelCount: 1,
            }
          : noProcessing,
        publish: voice
          ? { maxBitrate: 32_000, dtx: true, red: true, forceStereo: false }
          : { maxBitrate: MUSIC_BITRATE[quality], dtx: false, red: false, forceStereo: true },
        trackSource: 'microphone',
      };
    }
  }
}

/** Approximate media egress for capacity planning (Opus payload + RTP/UDP/IP overhead). */
export function estimateEgressKbps(bitrate: number, listeners: number, red = false): number {
  const packetsPerSecond = 50; // 20 ms Opus frames
  const overheadBits = packetsPerSecond * (12 + 8 + 20 + 16) * 8; // RTP+UDP+IPv4+SRTP/ext approx
  const perStream = (bitrate * (red ? 2 : 1) + overheadBits) / 1000;
  return perStream * listeners;
}
