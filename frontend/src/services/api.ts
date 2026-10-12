import type { CreatedRoom, Role, RoomInfo, TokenGrant } from '../types/room';

const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      credentials: 'omit',
    });
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    throw new ApiError(
      aborted ? 'The server took too long to respond' : 'Cannot reach the server',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = res.statusText || 'Request failed';
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(detail, res.status);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  createRoom: (name: string) =>
    request<CreatedRoom>('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
  getRoom: (code: string) => request<RoomInfo>(`/api/rooms/${encodeURIComponent(code)}`),
  token: (code: string, role: Role, displayName: string, hostKey?: string) =>
    request<TokenGrant>(`/api/rooms/${encodeURIComponent(code)}/token`, {
      method: 'POST',
      body: JSON.stringify({ role, display_name: displayName, host_key: hostKey ?? null }),
    }),
  closeRoom: (code: string, hostKey: string) =>
    request<void>(`/api/rooms/${encodeURIComponent(code)}`, {
      method: 'DELETE',
      headers: { 'X-Host-Key': hostKey },
    }),
  serverTime: async () =>
    (await request<{ server_time_ms: number }>('/api/time', { cache: 'no-store' }, 3000))
      .server_time_ms,
};
