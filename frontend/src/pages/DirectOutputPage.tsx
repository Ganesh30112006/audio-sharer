import { useEffect, useRef, useState } from 'react';
import { FileAudio, Pause, Play } from 'lucide-react';
import { getCapabilities } from '../audio/capabilities';
import { MultiOutputPlayer } from '../audio/MultiOutputPlayer';
import { DEFAULT_OUTPUT } from '../audio/outputDevices';
import { Notice } from '../components/Notice';
import { OutputSelector } from '../components/OutputSelector';
import { ProgressBar } from '../components/ProgressBar';
import { useSession } from '../hooks/useSession';
import { useStore } from '../hooks/useStore';
import { ACCEPT_ATTR, checkAudioFile } from '../media/fileSource';

/**
 * Local multi-output playback: one file, several output devices on this
 * machine, kept aligned by drift correction. No network involved.
 */
export default function DirectOutputPage() {
  const player = useSession(() => new MultiOutputPlayer(), []);
  if (!player) return <div className="page muted">Preparing…</div>;
  return <DirectOutput player={player} />;
}

function DirectOutput({ player }: { player: MultiOutputPlayer }) {
  const caps = getCapabilities();
  const playing = useStore(player.store, (s) => s.playing);
  const slotCount = useStore(player.store, (s) => s.slots.length);
  const [file, setFile] = useState<{ name: string; url: string } | null>(null);
  const duration = useStore(player.store, (s) => s.duration);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (player.store.get().slots.length === 0)
      void player.addOutput(DEFAULT_OUTPUT).catch(() => undefined);
  }, [player]);

  // Revoke the object URL when the file changes or the page unmounts.
  useEffect(() => {
    if (!file) return;
    return () => URL.revokeObjectURL(file.url);
  }, [file]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    const check = checkAudioFile(f);
    if (!check.ok) {
      setError(check.reason ?? 'Unsupported file');
      return;
    }
    setError(null);
    player.pause();
    const url = URL.createObjectURL(f);
    setFile({ name: f.name, url });
    player.setSource({ kind: 'url', url });
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Multi-output playback</h1>
          <p className="muted">Play one file on several outputs connected to this device.</p>
        </div>
      </div>
      {!caps.setSinkId && (
        <Notice tone="warning">
          Your browser can't send audio to more than the system default output. Use a desktop
          Chromium-based browser or Firefox for multi-device output.
        </Notice>
      )}
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="grid-2">
        <div className="stack">
          <section className="card" aria-labelledby="direct-file">
            <div className="card-header">
              <h2 id="direct-file">
                <FileAudio size={18} aria-hidden /> {file ? file.name : 'No file selected'}
              </h2>
              <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
                Choose file
              </button>
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT_ATTR}
                hidden
                onChange={(e) => {
                  choose(e.currentTarget.files?.[0]);
                  e.currentTarget.value = '';
                }}
              />
            </div>
            <ProgressBar
              getTime={() => player.currentTime()}
              duration={duration}
              active={playing}
              onSeek={(t) => player.seek(t)}
            />
            <div className="row">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                disabled={!file || slotCount === 0}
                onClick={() => (playing ? player.pause() : void player.play())}
              >
                {playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
                {playing ? 'Pause' : 'Play on all outputs'}
              </button>
            </div>
            <p className="small muted">
              Each output decodes the file separately (more outputs = more CPU). Outputs are aligned
              by gently adjusting playback speed; the drift readout shows the measured offset from
              the first output.
            </p>
          </section>
        </div>
        <div className="stack">
          <OutputSelector player={player} showDrift />
        </div>
      </div>
    </div>
  );
}
