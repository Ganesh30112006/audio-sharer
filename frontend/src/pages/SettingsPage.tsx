import { getCapabilities } from '../audio/capabilities';
import { CapabilityList } from '../components/CapabilityList';
import { useStoreState } from '../hooks/useStore';
import { settingsStore, updateSettings, type BufferMode } from '../services/settings';
import type { QualityPreset } from '../audio/sourcePolicy';

export default function SettingsPage() {
  const s = useStoreState(settingsStore);
  const caps = getCapabilities();
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <h1>Settings</h1>
      <section className="card" aria-labelledby="pref-heading">
        <h2 id="pref-heading">Preferences</h2>
        <div className="field">
          <label htmlFor="pref-name">Display name</label>
          <input
            id="pref-name"
            type="text"
            maxLength={40}
            value={s.displayName}
            onChange={(e) => updateSettings({ displayName: e.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="pref-buffer">Listening buffer</label>
          <select
            id="pref-buffer"
            value={s.bufferMode}
            onChange={(e) => updateSettings({ bufferMode: e.currentTarget.value as BufferMode })}
          >
            <option value="auto">Low latency (browser adaptive)</option>
            <option value="stable">Stable (+250 ms buffer, fewer dropouts)</option>
          </select>
          {!caps.jitterBufferTarget && (
            <span className="small muted">This browser may ignore the buffer setting.</span>
          )}
        </div>
        <div className="field">
          <label htmlFor="pref-quality">Default broadcast quality</label>
          <select
            id="pref-quality"
            value={s.quality}
            onChange={(e) => updateSettings({ quality: e.currentTarget.value as QualityPreset })}
          >
            <option value="high">High — 128 kbps stereo</option>
            <option value="standard">Standard — 64 kbps stereo</option>
          </select>
        </div>
        <label className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            type="checkbox"
            checked={s.voiceProcessing}
            onChange={(e) => updateSettings({ voiceProcessing: e.currentTarget.checked })}
          />
          <span>
            Voice processing for microphone (echo cancellation, noise suppression, auto gain).
            <br />
            <span className="small muted">
              Turn off when the microphone captures music or instruments.
            </span>
          </span>
        </label>
        <label className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            type="checkbox"
            checked={s.showDiagnostics}
            onChange={(e) => updateSettings({ showDiagnostics: e.currentTarget.checked })}
          />
          <span>Show connection diagnostics in rooms</span>
        </label>
      </section>
      <section className="card" aria-labelledby="caps-heading">
        <h2 id="caps-heading">This browser</h2>
        <p className="small muted">
          Detected API support. Support means the API exists — individual devices (especially
          Bluetooth) may still refuse to be routed.
        </p>
        <CapabilityList caps={caps} />
      </section>
    </div>
  );
}
