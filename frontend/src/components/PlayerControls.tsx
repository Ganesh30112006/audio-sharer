import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { useStore } from '../hooks/useStore';
import type { LocalFilePlayer } from '../audio/LocalFilePlayer';
import { ProgressBar } from './ProgressBar';
import './PlayerControls.css';

interface PlayerControlsProps {
  player: LocalFilePlayer;
  onPrevious: () => void;
  onNext: () => void;
  hasNext: boolean;
}

const selStatus = (s: { status: string }) => s.status;
const selTitle = (s: { title: string | null }) => s.title;
const selDuration = (s: { duration: number | null }) => s.duration;
const selVolume = (s: { volume: number }) => s.volume;
const selMonitor = (s: { monitor: boolean }) => s.monitor;
const selBuffering = (s: { buffering: boolean }) => s.buffering;
const selError = (s: { error: string | null }) => s.error;

export function PlayerControls({ player, onPrevious, onNext, hasNext }: PlayerControlsProps) {
  const status = useStore(player.store, selStatus);
  const title = useStore(player.store, selTitle);
  const duration = useStore(player.store, selDuration);
  const volume = useStore(player.store, selVolume);
  const monitor = useStore(player.store, selMonitor);
  const buffering = useStore(player.store, selBuffering);
  const error = useStore(player.store, selError);
  const playing = status === 'playing';
  const loaded = status !== 'idle';

  return (
    <div className="player">
      <div className="player-title">
        <strong>{title ?? 'Nothing loaded'}</strong>
        {buffering && playing && (
          <span className="pill pill-warning">
            <Loader2 size={12} aria-hidden className="spin" /> Buffering
          </span>
        )}
      </div>
      <ProgressBar
        getTime={() => player.currentTime()}
        duration={duration}
        active={playing}
        onSeek={(t) => player.seek(t)}
      />
      <div className="player-row">
        <div className="row">
          <button
            type="button"
            className="btn btn-icon"
            onClick={onPrevious}
            disabled={!loaded}
            aria-label="Previous"
          >
            <SkipBack size={18} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn-primary btn-icon btn-lg"
            onClick={() => (playing ? player.pause() : void player.play())}
            disabled={!loaded || status === 'error'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={20} aria-hidden /> : <Play size={20} aria-hidden />}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={onNext}
            disabled={!hasNext}
            aria-label="Next"
          >
            <SkipForward size={18} aria-hidden />
          </button>
        </div>
        <div className="row volume">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => player.setMonitor(!monitor)}
            aria-pressed={!monitor}
            aria-label={monitor ? 'Mute local monitor' : 'Unmute local monitor'}
            title="Local monitor only — listeners are unaffected"
          >
            {monitor ? <Volume2 size={18} aria-hidden /> : <VolumeX size={18} aria-hidden />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => player.setVolume(Number(e.currentTarget.value))}
            aria-label="Local monitor volume"
          />
        </div>
      </div>
      {error && (
        <p className="small" role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
