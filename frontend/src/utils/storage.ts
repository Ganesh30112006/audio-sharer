/** Storage access that never throws (private mode, blocked storage, quotas). */
export function readJson<T>(storage: 'local' | 'session', key: string): T | undefined {
  try {
    const raw = (storage === 'local' ? localStorage : sessionStorage).getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeJson(storage: 'local' | 'session', key: string, value: unknown): void {
  try {
    const s = storage === 'local' ? localStorage : sessionStorage;
    if (value === undefined) s.removeItem(key);
    else s.setItem(key, JSON.stringify(value));
  } catch {
    // Non-critical: preferences simply won't persist.
  }
}
