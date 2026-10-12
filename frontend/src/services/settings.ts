import type { QualityPreset } from '../audio/sourcePolicy';
import { readJson, writeJson } from '../utils/storage';
import { createStore } from '../utils/store';

export type BufferMode = 'auto' | 'stable';

export interface Settings {
  displayName: string;
  /** auto: browser-adaptive jitter buffer (lowest latency). stable: +extra buffer. */
  bufferMode: BufferMode;
  quality: QualityPreset;
  /** Echo cancellation / noise suppression / AGC for microphone sources. */
  voiceProcessing: boolean;
  /** Opus RED redundancy: fewer dropouts under packet loss, ~2x bandwidth. */
  lossProtection: boolean;
  showDiagnostics: boolean;
}

const KEY = 'mc.settings.v1';
export const STABLE_BUFFER_SECONDS = 0.25;

const defaults: Settings = {
  displayName: '',
  bufferMode: 'auto',
  quality: 'high',
  voiceProcessing: true,
  lossProtection: true,
  showDiagnostics: false,
};

function load(): Settings {
  const saved = readJson<Partial<Settings>>('local', KEY) ?? {};
  const s: Settings = { ...defaults };
  if (typeof saved.displayName === 'string') s.displayName = saved.displayName.slice(0, 40);
  if (saved.bufferMode === 'auto' || saved.bufferMode === 'stable') s.bufferMode = saved.bufferMode;
  if (saved.quality === 'standard' || saved.quality === 'high') s.quality = saved.quality;
  if (typeof saved.voiceProcessing === 'boolean') s.voiceProcessing = saved.voiceProcessing;
  if (typeof saved.lossProtection === 'boolean') s.lossProtection = saved.lossProtection;
  if (typeof saved.showDiagnostics === 'boolean') s.showDiagnostics = saved.showDiagnostics;
  return s;
}

export const settingsStore = createStore<Settings>(load());
settingsStore.subscribe(() => writeJson('local', KEY, settingsStore.get()));

export function updateSettings(patch: Partial<Settings>): void {
  settingsStore.set(patch);
}

const hostKeyName = (code: string) => `mc.host.${code}`;

/** Host keys live only in this tab's sessionStorage, never in the URL. */
export function saveHostKey(code: string, key: string): void {
  writeJson('session', hostKeyName(code), key);
}
export function loadHostKey(code: string): string | undefined {
  return readJson<string>('session', hostKeyName(code));
}
export function forgetHostKey(code: string): void {
  writeJson('session', hostKeyName(code), undefined);
}
