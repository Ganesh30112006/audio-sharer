import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Headphones, LogOut, Play, Radio } from 'lucide-react';
import { getCapabilities } from '../audio/capabilities';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { LosslessStats } from '../components/LosslessStats';
import { Notice } from '../components/Notice';
import { OutputSelector } from '../components/OutputSelector';
import { ProgressBar } from '../components/ProgressBar';
import { StatusPill } from '../components/StatusPill';
import { useSession } from '../hooks/useSession';
import { useStore, useStoreState } from '../hooks/useStore';
import { ListenerSession } from '../services/listenerSession';
import { settingsStore, updateSettings } from '../services/settings';
import { formatPcmLabel, ROOM_CODE_RE } from '../utils/format';

const selShowDiag = (s: { showDiagnostics: boolean }) => s.showDiagnostics;

export default function ListenerPage() {
  const { code = '' } = useParams();
  const valid = ROOM_CODE_RE.test(code);
  const session = useSession(() => (valid ? new ListenerSession(code) : null), [code, valid]);
  if (!valid) {
    return (
      <div className="page">
        <Notice tone="error">
          That room code isn't valid. <Link to="/">Go back</Link>
        </Notice>
      </div>
    );
  }
  if (!session) return <div className="page muted">Preparing…</div>;
  return <ListenerRoom session={session} />;
}

function ListenerRoom({ session }: { session: ListenerSession }) {
  const navigate = useNavigate();
  const state = useStoreState(session.store);
  const conn = useStoreState(session.conn.store);
  const playback = useStore(session.sync.store, (s) => s.playback);
  const needsGesture = useStore(session.outputs.store, (s) => s.needsGesture);
  const showDiag = useStore(settingsStore, selShowDiag);
  // Primitive selectors: the stats store updates ~2×/s, but these rarely change.
  const losslessLabel = useStore(session.lossless.stats, (s) =>
    s.active ? formatPcmLabel(s) : null,
  );
  const [name, setName] = useState(settingsStore.get().displayName);

  useEffect(() => {
    void session.loadRoom();
  }, [session]);

  const join = (e: FormEvent) => {
    e.preventDefault();
    updateSettings({ displayName: name.trim() });
    void session.join(name.trim());
  };

  const leave = async () => {
    await session.leave();
    navigate('/');
  };

  const joinFailed =
    state.phase === 'error' && conn.state !== 'connected' && conn.state !== 'reconnecting';
  if (state.phase === 'idle' || joinFailed) {
    return (
      <div className="page" style={{ maxWidth: 520 }}>
        {!state.room && state.error ? (
          <Notice tone="error">
            {state.error} <Link to="/">Back to start</Link>
          </Notice>
        ) : (
          <form className="card" onSubmit={join} aria-labelledby="join-room-heading">
            <h1 id="join-room-heading" style={{ fontSize: '1.3rem' }}>
              {state.room ? state.room.name : 'Join room'}
            </h1>
            <p className="muted small">
              Room <span className="mono">{session.code}</span>
            </p>
            {state.error && <Notice tone="error">{state.error}</Notice>}
            {!getCapabilities().webrtc && (
              <Notice tone="error">
                This browser doesn't support WebRTC, so it can't receive the stream.
              </Notice>
            )}
            <div className="field">
              <label htmlFor="listener-name">Your name (shown to the host)</label>
              <input
                id="listener-name"
                type="text"
                maxLength={40}
                autoComplete="nickname"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="Listener"
              />
            </div>
            <button type="submit" className="btn btn-primary btn-lg" disabled={!state.room}>
              <Headphones size={18} aria-hidden /> Join and listen
            </button>
          </form>
        )}
      </div>
    );
  }

  const hostHere = conn.participants.some((p) => p.role === 'host');
  const live = playback?.status === 'playing' && state.hasAudio;

  return (
    <div className="page">
      <div className="page-header">
        <div className="stack" style={{ gap: 4 }}>
          <h1>{state.room?.name ?? 'Room'}</h1>
          <div className="row">
            <StatusPill state={conn.state} quality={conn.quality} />
            <span className="small muted mono">{session.code}</span>
          </div>
        </div>
        <button type="button" className="btn" onClick={() => void leave()}>
          <LogOut size={16} aria-hidden /> Leave
        </button>
      </div>

      {state.error && <Notice tone="error">{state.error}</Notice>}
      {conn.error && <Notice tone="error">{conn.error}</Notice>}
      {needsGesture && (
        <Notice tone="info">
          <span>Your browser paused audio until you interact with the page.</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void session.resumeAudio()}
          >
            <Play size={16} aria-hidden /> Start audio
          </button>
        </Notice>
      )}

      <div className="grid-2">
        <div className="stack">
          <section className="card" aria-labelledby="listen-now">
            <div className="card-header">
              <h2 id="listen-now">
                <Radio size={18} aria-hidden /> Now playing
              </h2>
              {live ? (
                <span className="row" style={{ gap: 6 }}>
                  {losslessLabel && (
                    <span className="pill pill-success" data-testid="lossless-badge">
                      Lossless · {losslessLabel}
                    </span>
                  )}
                  <span className="pill pill-danger">Live</span>
                </span>
              ) : (
                <span className="pill">{hostHere ? 'Waiting for host' : 'Host offline'}</span>
              )}
            </div>
            <strong data-testid="now-playing-title">
              {playback?.title ?? (conn.state === 'connected' ? 'Nothing playing yet' : '—')}
            </strong>
            <ProgressBar
              getTime={() => session.sync.position() ?? 0}
              duration={playback?.duration ?? null}
              active={playback?.status === 'playing'}
              label="Host playback position"
            />
            <p className="small muted">
              {state.hasAudio ? 'Receiving audio from the host.' : 'No audio stream yet.'}
            </p>
          </section>
          <LosslessStats receiver={session.lossless.stats} />
          {showDiag && conn.state !== 'idle' && (
            <DiagnosticsPanel
              conn={session.conn}
              direction="inbound"
              connectionOnly={losslessLabel !== null}
              clockUncertaintyMs={session.clock.current?.uncertainty}
            />
          )}
        </div>
        <div className="stack">
          <OutputSelector player={session.outputs} />
        </div>
      </div>
    </div>
  );
}
