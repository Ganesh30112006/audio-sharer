import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Power, Radio, MonitorSpeaker, Mic } from 'lucide-react';
import { getCapabilities } from '../audio/capabilities';
import { estimateEgressKbps, type QualityPreset } from '../audio/sourcePolicy';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { InviteCard } from '../components/InviteCard';
import { ListenerList } from '../components/ListenerList';
import { Notice } from '../components/Notice';
import { PlayerControls } from '../components/PlayerControls';
import { QueueList } from '../components/QueueList';
import { SourcePicker } from '../components/SourcePicker';
import { StatusPill } from '../components/StatusPill';
import { useOutputDevices } from '../hooks/useOutputDevices';
import { useSession } from '../hooks/useSession';
import { useStore, useStoreState } from '../hooks/useStore';
import { HostSession } from '../services/hostSession';
import { forgetHostKey, loadHostKey, settingsStore } from '../services/settings';
import { ROOM_CODE_RE } from '../utils/format';
import './HostPage.css';

const selShowDiag = (s: { showDiagnostics: boolean }) => s.showDiagnostics;

export default function HostPage() {
  const { code = '' } = useParams();
  const hostKey = ROOM_CODE_RE.test(code) ? loadHostKey(code) : undefined;
  const session = useSession(
    () => (hostKey ? new HostSession(code, hostKey) : null),
    [code, hostKey],
  );

  if (!hostKey) {
    return (
      <div className="page">
        <Notice tone="warning">
          This tab doesn't hold the host key for room <span className="mono">{code}</span>. Host
          keys are kept only in the tab that created the room. <Link to="/">Create a new room</Link>{' '}
          or <Link to={`/room/${code}`}>join as a listener</Link>.
        </Notice>
      </div>
    );
  }
  if (!session) return <div className="page muted">Preparing…</div>;
  return <HostDashboard session={session} />;
}

function HostDashboard({ session }: { session: HostSession }) {
  const navigate = useNavigate();
  const host = useStoreState(session.store);
  const conn = useStoreState(session.conn.store);
  const currentId = useStore(session.player.store, (s) => s.currentId);
  const showDiag = useStore(settingsStore, selShowDiag);

  useEffect(() => {
    void session.start(settingsStore.get().displayName);
  }, [session]);

  const end = async () => {
    if (!window.confirm('End the room for all listeners?')) return;
    forgetHostKey(session.code);
    await session.end();
    navigate('/');
  };

  const listenerCount = conn.participants.filter((p) => p.role === 'listener').length;
  const policy = session.policy(host.source);
  const egress = estimateEgressKbps(
    policy.publish.maxBitrate,
    Math.max(1, listenerCount),
    policy.publish.red,
  );
  const currentIdx = host.queue.findIndex((q) => q.id === currentId);
  const ready = host.phase === 'ready' && conn.state !== 'disconnected';

  return (
    <div className="page">
      <div className="page-header">
        <div className="stack" style={{ gap: 4 }}>
          <h1>Host dashboard</h1>
          <div className="row">
            <StatusPill state={conn.state} quality={conn.quality} />
            {host.live && conn.publishing && (
              <span className="pill pill-danger">
                <span className="pill-dot live-dot" aria-hidden /> Live
              </span>
            )}
          </div>
        </div>
        <button type="button" className="btn btn-danger" onClick={() => void end()}>
          <Power size={16} aria-hidden /> End room
        </button>
      </div>

      {host.error && <Notice tone="error">{host.error}</Notice>}
      {conn.error && <Notice tone="error">{conn.error}</Notice>}
      {host.notices.length > 0 && (
        <Notice tone="warning" onDismiss={() => session.dismissNotices()}>
          {host.notices.map((n) => (
            <span key={n}>{n}</span>
          ))}
        </Notice>
      )}
      {!getCapabilities().secureContext && (
        <Notice tone="warning">
          This page isn't served over HTTPS; capture and device selection are disabled.
        </Notice>
      )}

      <div className="grid-2">
        <div className="stack">
          <section className="card broadcast" aria-labelledby="broadcast-heading">
            <div className="card-header">
              <h2 id="broadcast-heading">
                <Radio size={18} aria-hidden /> Broadcast
              </h2>
              <div className="field" style={{ minWidth: 150 }}>
                <label htmlFor="quality" className="visually-hidden">
                  Stream quality
                </label>
                <select
                  id="quality"
                  value={host.quality}
                  onChange={(e) => void session.setQuality(e.currentTarget.value as QualityPreset)}
                  disabled={host.busy}
                >
                  <option value="high">High quality (128 kbps)</option>
                  <option value="standard">Standard (64 kbps)</option>
                </select>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button
                type="button"
                className={`btn btn-lg ${host.live ? 'btn-live' : 'btn-primary'}`}
                onClick={() => void session.setLive(!host.live)}
                disabled={!ready || host.busy || (host.source === 'file' && !currentId)}
                aria-pressed={host.live}
              >
                <Radio size={18} aria-hidden /> {host.live ? 'Stop broadcasting' : 'Go live'}
              </button>
              <span
                className="small muted"
                title="Opus payload plus packet overhead, from the SFU to all listeners"
              >
                ≈ {((policy.publish.maxBitrate * (policy.publish.red ? 2 : 1)) / 1000).toFixed(0)}{' '}
                kbps up · ≈ {(egress / 1000).toFixed(2)} Mbps SFU egress for{' '}
                {Math.max(1, listenerCount)} listener{listenerCount === 1 ? '' : 's'}
              </span>
            </div>
            <label className="row small" style={{ flexWrap: 'nowrap' }}>
              <input
                type="checkbox"
                checked={host.lossProtection}
                disabled={host.busy}
                onChange={(e) => void session.setLossProtection(e.currentTarget.checked)}
              />
              <span>
                Loss protection (redundant audio) — fewer dropouts on weak networks, about twice the
                bandwidth.
              </span>
            </label>
            {host.source === 'file' && !currentId && (
              <p className="small muted">Add an audio file to start broadcasting.</p>
            )}
          </section>

          <SourcePicker
            source={host.source}
            busy={host.busy}
            captureLabel={host.captureLabel}
            onFiles={(files) => session.addFiles(files)}
            onUseFile={() => void session.useFile()}
            onCapture={(kind) => void session.useCapture(kind)}
          />

          <section className="card" aria-labelledby="now-heading">
            <h2 id="now-heading">Now playing</h2>
            {host.source === 'file' ? (
              <PlayerControls
                player={session.player}
                onPrevious={() => session.previous()}
                onNext={() => session.next()}
                hasNext={currentIdx >= 0 && currentIdx < host.queue.length - 1}
              />
            ) : (
              <div className="row">
                {host.source === 'capture' ? (
                  <MonitorSpeaker size={20} aria-hidden />
                ) : (
                  <Mic size={20} aria-hidden />
                )}
                <strong>
                  {host.captureLabel ?? (host.source === 'capture' ? 'Shared audio' : 'Microphone')}
                </strong>
                <span className="pill pill-accent">Live input</span>
              </div>
            )}
          </section>

          <QueueList
            items={host.queue}
            currentId={currentId}
            onSelect={(id) => session.loadItem(id)}
            onRemove={(id) => session.removeItem(id)}
          />
        </div>

        <div className="stack">
          <InviteCard code={session.code} />
          <ListenerList participants={conn.participants} />
          {host.source === 'file' && <MonitorOutput session={session} />}
          {showDiag && (
            <DiagnosticsPanel
              conn={session.conn}
              direction="outbound"
              outputLatency={session.player.outputLatency()}
              clockUncertaintyMs={session.clock.current?.uncertainty}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MonitorOutput({ session }: { session: HostSession }) {
  const caps = getCapabilities();
  const { devices } = useOutputDevices();
  const [sink, setSink] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!caps.setSinkId || devices.length <= 1) return null;
  return (
    <section className="card" aria-labelledby="monitor-heading">
      <h2 id="monitor-heading">Your monitor output</h2>
      <div className="field">
        <label htmlFor="monitor-sink">Where you hear the music on this device</label>
        <select
          id="monitor-sink"
          value={sink}
          onChange={async (e) => {
            const id = e.currentTarget.value;
            setError(null);
            try {
              await session.player.setMonitorSink(id);
              setSink(id);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          {devices.map((d) => (
            <option key={d.deviceId || 'default'} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
