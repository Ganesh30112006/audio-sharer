export type Role = 'host' | 'listener';

export type ConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed';

export type Quality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';

export interface ParticipantSummary {
  identity: string;
  name: string;
  role: Role;
  quality: Quality;
}

export interface RoomInfo {
  code: string;
  name: string;
  created_at: number;
  expires_at: number;
  max_listeners: number;
  sfu_url: string;
}

export interface CreatedRoom {
  code: string;
  name: string;
  host_key: string;
  expires_at: number;
}

export interface TokenGrant {
  token: string;
  url: string;
  identity: string;
  room: string;
  role: Role;
  expires_at: number;
}
