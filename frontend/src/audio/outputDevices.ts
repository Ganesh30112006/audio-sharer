import { getCapabilities } from './capabilities';

export interface OutputDevice {
  deviceId: string;
  label: string;
}

export const DEFAULT_OUTPUT: OutputDevice = { deviceId: '', label: 'System default output' };

type MediaDevicesWithSelect = MediaDevices & {
  selectAudioOutput?: (options?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
};

type SinkableElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Lists output devices the browser exposes to this page. Browsers often hide
 * outputs (or their labels) until permission is granted; the list may also
 * omit Bluetooth devices the OS can see.
 */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  const caps = getCapabilities();
  if (!caps.enumerateDevices || !caps.setSinkId) return [DEFAULT_OUTPUT];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices
      .filter((d) => d.kind === 'audiooutput' && d.deviceId && d.deviceId !== 'default')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Output ${i + 1}` }));
    return [DEFAULT_OUTPUT, ...outputs];
  } catch {
    return [DEFAULT_OUTPUT];
  }
}

/** Opens the browser's output picker where supported (grants access to that device). */
export async function requestOutputDevice(): Promise<OutputDevice | null> {
  const md = navigator.mediaDevices as MediaDevicesWithSelect | undefined;
  if (!md?.selectAudioOutput) return null;
  try {
    const info = await md.selectAudioOutput();
    return { deviceId: info.deviceId, label: info.label || 'Selected output' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') return null;
    throw err;
  }
}

export async function applySink(el: HTMLMediaElement, deviceId: string): Promise<void> {
  const sinkable = el as SinkableElement;
  if (!sinkable.setSinkId) {
    if (deviceId) throw new Error('This browser cannot route audio to a specific output');
    return;
  }
  if ((el as HTMLMediaElement & { sinkId?: string }).sinkId === deviceId) return;
  await sinkable.setSinkId(deviceId);
}

export function onDeviceChange(handler: () => void): () => void {
  const md = navigator.mediaDevices;
  if (!md?.addEventListener) return () => {};
  md.addEventListener('devicechange', handler);
  return () => md.removeEventListener('devicechange', handler);
}

/**
 * Chromium only reveals output device names (and sometimes the devices
 * themselves) after a media permission grant. This asks for microphone access
 * once, immediately stops the track, and never records anything.
 */
export async function unlockDeviceLabels(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}
