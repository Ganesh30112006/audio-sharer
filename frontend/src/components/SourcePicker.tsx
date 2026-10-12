import { useRef, useState, type DragEvent } from 'react';
import { FileAudio, MonitorSpeaker, Mic, Upload } from 'lucide-react';
import { getCapabilities } from '../audio/capabilities';
import { ACCEPT_ATTR } from '../media/fileSource';
import type { SourceKind } from '../types/sync';
import './SourcePicker.css';

interface SourcePickerProps {
  source: SourceKind;
  busy: boolean;
  captureLabel: string | null;
  onFiles: (files: File[]) => void;
  onUseFile: () => void;
  onCapture: (kind: 'capture' | 'microphone') => void;
}

export function SourcePicker({
  source,
  busy,
  captureLabel,
  onFiles,
  onUseFile,
  onCapture,
}: SourcePickerProps) {
  const caps = getCapabilities();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    onFiles([...e.dataTransfer.files]);
  };

  const captureHint = !caps.getDisplayMedia
    ? 'Not supported in this browser'
    : caps.displayAudioLikely
      ? 'Share a tab with "Share tab audio" enabled'
      : 'This browser usually shares video only, without audio';

  return (
    <section className="card" aria-labelledby="source-heading">
      <div className="card-header">
        <h2 id="source-heading">Audio source</h2>
      </div>
      <div className="source-options" role="radiogroup" aria-label="Audio source">
        <button
          type="button"
          role="radio"
          aria-checked={source === 'file'}
          className={`source-option${source === 'file' ? ' selected' : ''}`}
          onClick={onUseFile}
          disabled={busy}
        >
          <FileAudio size={20} aria-hidden />
          <span>
            <strong>Audio files</strong>
            <small>Play from this device</small>
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={source === 'capture'}
          className={`source-option${source === 'capture' ? ' selected' : ''}`}
          onClick={() => onCapture('capture')}
          disabled={busy || !caps.getDisplayMedia}
        >
          <MonitorSpeaker size={20} aria-hidden />
          <span>
            <strong>Tab / system audio</strong>
            <small>{source === 'capture' && captureLabel ? captureLabel : captureHint}</small>
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={source === 'microphone'}
          className={`source-option${source === 'microphone' ? ' selected' : ''}`}
          onClick={() => onCapture('microphone')}
          disabled={busy || !caps.getUserMedia}
        >
          <Mic size={20} aria-hidden />
          <span>
            <strong>Microphone</strong>
            <small>{source === 'microphone' && captureLabel ? captureLabel : 'Live input'}</small>
          </span>
        </button>
      </div>

      <div
        className={`dropzone${dragOver ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <Upload size={18} aria-hidden />
        <span>Drop audio files here or</span>
        <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            onFiles([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = '';
          }}
        />
      </div>
      <p className="small muted">Files stay on this device. Nothing is uploaded or recorded.</p>
    </section>
  );
}
