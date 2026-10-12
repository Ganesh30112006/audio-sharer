import { CheckCircle2, MinusCircle } from 'lucide-react';
import type { Capabilities } from '../audio/capabilities';

const ITEMS: Array<[keyof Capabilities, string, string]> = [
  ['secureContext', 'Secure context (HTTPS)', 'Required for capture and device access'],
  ['webrtc', 'WebRTC', 'Required to stream or listen'],
  ['webAudio', 'Web Audio API', 'Broadcasting files; per-output delay'],
  ['setSinkId', 'Output selection (setSinkId)', 'Choose specific output devices'],
  [
    'selectAudioOutput',
    'Output picker (selectAudioOutput)',
    'Browser dialog to grant an output device',
  ],
  [
    'audioContextSetSinkId',
    'Web Audio output selection',
    'Route the broadcast monitor to a device',
  ],
  ['enumerateDevices', 'Device enumeration', 'List outputs'],
  ['getUserMedia', 'Microphone capture', 'Live microphone source'],
  ['getDisplayMedia', 'Screen/tab capture', 'Share tab or system audio'],
  ['displayAudioLikely', 'Tab/system audio in captures', 'Desktop Chromium browsers'],
  ['jitterBufferTarget', 'Receive buffer control', 'Stable playback mode'],
];

export function CapabilityList({ caps }: { caps: Capabilities }) {
  return (
    <ul
      className="caps"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}
    >
      {ITEMS.map(([key, label, hint]) => {
        const ok = !!caps[key];
        return (
          <li key={key} className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            {ok ? (
              <CheckCircle2
                size={18}
                aria-hidden
                style={{ color: 'var(--success)', flex: 'none' }}
              />
            ) : (
              <MinusCircle
                size={18}
                aria-hidden
                style={{ color: 'var(--text-muted)', flex: 'none' }}
              />
            )}
            <span>
              <strong>{label}</strong>
              <span className="visually-hidden">{ok ? ': available' : ': unavailable'}</span>
              <br />
              <span className="small muted">{hint}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
