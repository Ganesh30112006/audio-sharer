import type { SourcePolicy } from '../audio/sourcePolicy';

/**
 * A capture owned by this module. Only tracks obtained here are stopped by
 * `stop()`; tracks owned by other features are never touched.
 */
export interface OwnedCapture {
  track: MediaStreamTrack;
  label: string;
  stop(): void;
  /** Fires once if the user ends the capture from browser UI or the device disappears. */
  onEnded(handler: () => void): () => void;
}

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code: 'denied' | 'no-audio' | 'unsupported' | 'not-found' | 'busy' | 'unknown',
  ) {
    super(message);
    this.name = 'CaptureError';
  }
}

function toCaptureError(err: unknown, what: string): CaptureError {
  if (err instanceof CaptureError) return err;
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CaptureError(`Permission to capture ${what} was denied.`, 'denied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CaptureError(`No ${what} device was found.`, 'not-found');
    case 'NotReadableError':
    case 'AbortError':
      return new CaptureError(`The ${what} is in use by another application.`, 'busy');
    case 'NotSupportedError':
    case 'TypeError':
      return new CaptureError(`This browser cannot capture ${what}.`, 'unsupported');
    default:
      return new CaptureError(`Could not capture ${what}.`, 'unknown');
  }
}

function own(track: MediaStreamTrack, extra: MediaStreamTrack[] = []): OwnedCapture {
  let stopped = false;
  const endedHandlers = new Set<() => void>();
  const handleEnded = () => {
    endedHandlers.forEach((h) => h());
    endedHandlers.clear();
  };
  track.addEventListener('ended', handleEnded, { once: true });
  return {
    track,
    label: track.label,
    stop() {
      if (stopped) return;
      stopped = true;
      track.removeEventListener('ended', handleEnded);
      endedHandlers.clear();
      track.stop();
      extra.forEach((t) => t.stop());
    },
    onEnded(handler) {
      endedHandlers.add(handler);
      return () => endedHandlers.delete(handler);
    },
  };
}

/**
 * Tab/system audio via getDisplayMedia. Browsers require a video track in the
 * request; we stop it immediately so no video is encoded or held.
 */
export async function captureDisplayAudio(policy: SourcePolicy): Promise<OwnedCapture> {
  const md = navigator.mediaDevices;
  if (!md?.getDisplayMedia)
    throw new CaptureError('This browser cannot capture tab or system audio.', 'unsupported');
  let stream: MediaStream;
  try {
    stream = await md.getDisplayMedia({
      video: true,
      audio: { ...policy.constraints, suppressLocalAudioPlayback: false } as MediaTrackConstraints,
      // Chromium hints; ignored elsewhere.
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    } as DisplayMediaStreamOptions);
  } catch (err) {
    throw toCaptureError(err, 'tab or system audio');
  }
  stream.getVideoTracks().forEach((t) => t.stop());
  const [audio] = stream.getAudioTracks();
  if (!audio) {
    throw new CaptureError(
      'No audio was shared. Choose a tab and enable "Share tab audio" (system audio is only available on some platforms).',
      'no-audio',
    );
  }
  audio.contentHint = 'music';
  return own(audio);
}

export async function captureMicrophone(
  policy: SourcePolicy,
  deviceId?: string,
): Promise<OwnedCapture> {
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia)
    throw new CaptureError('This browser cannot access a microphone.', 'unsupported');
  let stream: MediaStream;
  try {
    stream = await md.getUserMedia({
      audio: { ...policy.constraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      video: false,
    });
  } catch (err) {
    throw toCaptureError(err, 'microphone');
  }
  const [audio, ...rest] = stream.getAudioTracks();
  if (!audio) throw new CaptureError('No microphone track was returned.', 'not-found');
  rest.forEach((t) => t.stop());
  audio.contentHint = policy.publish.dtx ? 'speech' : 'music';
  return own(audio);
}
