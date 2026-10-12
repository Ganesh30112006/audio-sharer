import { useMemo, useRef, useState } from 'react';
import { Headphones, Plus, Search, Trash2, Unlock } from 'lucide-react';
import { getCapabilities } from '../audio/capabilities';
import {
  MAX_OUTPUTS,
  type MultiOutputPlayer,
  type OutputSlotState,
} from '../audio/MultiOutputPlayer';
import { requestOutputDevice, unlockDeviceLabels, type OutputDevice } from '../audio/outputDevices';
import { useOutputDevices } from '../hooks/useOutputDevices';
import { useStore } from '../hooks/useStore';
import { useThrottledFrame } from '../hooks/useThrottledFrame';
import { Notice } from './Notice';
import './OutputSelector.css';

interface OutputSelectorProps {
  player: MultiOutputPlayer;
  /** Show measured drift per output (local file playback only). */
  showDrift?: boolean;
}

const selSlots = (s: { slots: OutputSlotState[] }) => s.slots;

export function OutputSelector({ player, showDrift = false }: OutputSelectorProps) {
  const caps = getCapabilities();
  const slots = useStore(player.store, selSlots);
  const { devices, refresh } = useOutputDevices();
  const [extra, setExtra] = useState<OutputDevice[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);

  const available = useMemo(() => {
    const used = new Set(slots.map((s) => s.deviceId));
    const all = [
      ...devices,
      ...extra.filter((e) => !devices.some((d) => d.deviceId === e.deviceId)),
    ];
    return all.filter((d) => !used.has(d.deviceId));
  }, [devices, extra, slots]);

  const hiddenLabels =
    devices.length > 1 && devices.slice(1).every((d) => /^Output \d+$/.test(d.label));

  const add = async (device: OutputDevice | undefined) => {
    if (!device) return;
    setError(null);
    try {
      await player.addOutput(device);
      setPick('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const browse = async () => {
    setError(null);
    try {
      const d = await requestOutputDevice();
      if (d) {
        setExtra((prev) => [...prev.filter((p) => p.deviceId !== d.deviceId), d]);
        await add(d);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const atLimit = slots.length >= MAX_OUTPUTS;
  const selected = available.find((d) => d.deviceId === pick) ?? available[0];

  return (
    <section className="card" aria-labelledby="outputs-heading">
      <div className="card-header">
        <h2 id="outputs-heading">
          <Headphones size={18} aria-hidden /> Output devices
        </h2>
        <span className="pill">
          {slots.length}/{MAX_OUTPUTS}
        </span>
      </div>

      {!caps.setSinkId && (
        <Notice tone="warning">
          This browser can't route audio to specific devices, so it plays through the system default
          output.
          {caps.isIOS && ' On iPhone and iPad, choose the output from Control Center.'}
        </Notice>
      )}

      {slots.length === 0 ? (
        <p className="empty">No outputs selected.</p>
      ) : (
        <ul className="outputs">
          {slots.map((slot) => (
            <OutputRow
              key={slot.slotId}
              slot={slot}
              player={player}
              showDrift={showDrift && slot !== slots[0]}
            />
          ))}
        </ul>
      )}

      {caps.setSinkId && (
        <div className="output-add">
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="output-pick">Add output</label>
            <select
              id="output-pick"
              value={selected?.deviceId ?? ''}
              onChange={(e) => setPick(e.currentTarget.value)}
              disabled={atLimit || available.length === 0}
            >
              {available.length === 0 && <option value="">No other devices available</option>}
              {available.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void add(selected)}
            disabled={atLimit || !selected}
          >
            <Plus size={16} aria-hidden /> Add
          </button>
          {caps.selectAudioOutput && (
            <button type="button" className="btn" onClick={() => void browse()} disabled={atLimit}>
              <Search size={16} aria-hidden /> Find device
            </button>
          )}
          {hiddenLabels && caps.getUserMedia && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                if (await unlockDeviceLabels()) await refresh();
              }}
              title="Asks for microphone permission once so the browser reveals device names. Nothing is recorded."
            >
              <Unlock size={16} aria-hidden /> Show device names
            </button>
          )}
        </div>
      )}
      {error && (
        <Notice tone="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <p className="small muted">
        Only devices the browser exposes can be selected; some Bluetooth devices visible to your OS
        may not appear. Bluetooth adds its own delay — use the delay slider on faster outputs to
        line them up by ear.
      </p>
    </section>
  );
}

function OutputRow({
  slot,
  player,
  showDrift,
}: {
  slot: OutputSlotState;
  player: MultiOutputPlayer;
  showDrift: boolean;
}) {
  const driftRef = useRef<HTMLSpanElement>(null);
  useThrottledFrame(
    () => {
      const d = player.driftMs(slot.slotId);
      if (driftRef.current)
        driftRef.current.textContent =
          d === undefined ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)} ms`;
    },
    showDrift,
    500,
  );
  const id = `out-${slot.slotId}`;
  return (
    <li className={`output-row status-${slot.status}`}>
      <div className="output-head">
        <span className="output-label">{slot.label}</span>
        {slot.status !== 'ok' && (
          <span className="pill pill-danger">{slot.error ?? slot.status}</span>
        )}
        {showDrift && (
          <span className="pill" title="Measured offset from the first output">
            drift{' '}
            <span ref={driftRef} className="mono">
              —
            </span>
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={() => player.removeOutput(slot.slotId)}
          aria-label={`Remove ${slot.label}`}
        >
          <Trash2 size={16} aria-hidden />
        </button>
      </div>
      <div className="output-controls">
        <div className="field">
          <label htmlFor={`${id}-delay`}>Delay {slot.delayMs} ms</label>
          <input
            id={`${id}-delay`}
            type="range"
            min={0}
            max={500}
            step={5}
            value={slot.delayMs}
            onChange={(e) => player.setDelay(slot.slotId, Number(e.currentTarget.value))}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-vol`}>Volume {Math.round(slot.volume * 100)}%</label>
          <input
            id={`${id}-vol`}
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={slot.volume}
            onChange={(e) => player.setVolume(slot.slotId, Number(e.currentTarget.value))}
          />
        </div>
      </div>
    </li>
  );
}
