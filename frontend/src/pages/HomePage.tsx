import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, LogIn } from 'lucide-react';
import { Notice } from '../components/Notice';
import { useStore } from '../hooks/useStore';
import { api } from '../services/api';
import { saveHostKey, settingsStore, updateSettings } from '../services/settings';
import { normalizeRoomCode, ROOM_CODE_RE } from '../utils/format';
import './HomePage.css';

const selName = (s: { displayName: string }) => s.displayName;

export default function HomePage() {
  const navigate = useNavigate();
  const displayName = useStore(settingsStore, selName);
  const [roomName, setRoomName] = useState('');
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const room = await api.createRoom(roomName.trim() || 'Listening room');
      saveHostKey(room.code, room.host_key);
      navigate(`/host/${room.code}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    if (ROOM_CODE_RE.test(code)) navigate(`/room/${code}`);
  };

  return (
    <div className="page home">
      <div className="hero">
        <h1>Share audio, live, with everyone in the room.</h1>
        <p className="muted">
          Stream music, a browser tab or a microphone to many listeners at once, or play one file on
          several output devices.
        </p>
      </div>
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="home-grid">
        <form className="card" onSubmit={create} aria-labelledby="host-heading">
          <h2 id="host-heading">
            <Radio size={18} aria-hidden /> Host a room
          </h2>
          <div className="field">
            <label htmlFor="room-name">Room name</label>
            <input
              id="room-name"
              type="text"
              maxLength={60}
              placeholder="Listening room"
              value={roomName}
              onChange={(e) => setRoomName(e.currentTarget.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="host-name">Your name</label>
            <input
              id="host-name"
              type="text"
              maxLength={40}
              autoComplete="nickname"
              value={displayName}
              onChange={(e) => updateSettings({ displayName: e.currentTarget.value })}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-lg" disabled={creating}>
            {creating ? 'Creating…' : 'Create room'}
          </button>
        </form>

        <form className="card" onSubmit={join} aria-labelledby="join-heading">
          <h2 id="join-heading">
            <LogIn size={18} aria-hidden /> Join a room
          </h2>
          <div className="field">
            <label htmlFor="room-code">Room code</label>
            <input
              id="room-code"
              type="text"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="ABC234"
              className="mono code-input"
              value={code}
              onChange={(e) => setCode(normalizeRoomCode(e.currentTarget.value))}
            />
          </div>
          <button type="submit" className="btn btn-lg" disabled={!ROOM_CODE_RE.test(code)}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
