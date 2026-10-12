import { DEFAULT_FORMAT, type SourceFormat } from './audioFormat';

/**
 * Local audio files. Files stay on the host device: they're played from an
 * object URL and streamed as encoded audio; nothing is uploaded or stored.
 */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB

const ALLOWED: Record<string, string[]> = {
  'audio/mpeg': ['mp3'],
  'audio/mp3': ['mp3'],
  'audio/mp4': ['m4a', 'mp4', 'aac'],
  'audio/x-m4a': ['m4a'],
  'audio/aac': ['aac'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/wave': ['wav'],
  'audio/ogg': ['ogg', 'oga', 'opus'],
  'audio/opus': ['opus'],
  'audio/webm': ['webm', 'weba'],
  'audio/flac': ['flac'],
  'audio/x-flac': ['flac'],
};
// First (canonical) MIME type listed for an extension wins.
const EXT_TO_MIME: Record<string, string> = {};
for (const [mime, exts] of Object.entries(ALLOWED)) for (const e of exts) EXT_TO_MIME[e] ??= mime;

export const ACCEPT_ATTR = [...new Set(Object.keys(ALLOWED))]
  .concat(Object.keys(EXT_TO_MIME).map((e) => `.${e}`))
  .join(',');

export interface FileCheck {
  ok: boolean;
  mime?: string;
  reason?: string;
}

export function checkAudioFile(
  file: Pick<File, 'name' | 'size' | 'type'>,
  canPlayType: (mime: string) => string = (m) => document.createElement('audio').canPlayType(m),
): FileCheck {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = file.type && ALLOWED[file.type] ? file.type : EXT_TO_MIME[ext];
  if (!mime) return { ok: false, reason: `${file.name}: unsupported format` };
  if (file.size === 0) return { ok: false, reason: `${file.name}: file is empty` };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: `${file.name}: larger than 1 GB` };
  if (canPlayType(mime) === '') {
    return { ok: false, reason: `${file.name}: this browser cannot play ${mime}` };
  }
  return { ok: true, mime };
}

export interface QueueItem {
  id: string;
  title: string;
  size: number;
  mime: string;
  /** Native PCM format (lossless transport runs at this rate/bit depth). */
  format: SourceFormat;
}

/** Holds File handles and their object URLs; URLs are revoked deterministically. */
export class FileLibrary {
  private files = new Map<string, { file: File; url: string | null }>();

  add(file: File, mime: string, format: SourceFormat = DEFAULT_FORMAT): QueueItem {
    const id = crypto.randomUUID().slice(0, 12);
    this.files.set(id, { file, url: null });
    return { id, title: file.name.replace(/\.[^.]+$/, ''), size: file.size, mime, format };
  }

  /** Lazily creates the object URL so only the active track holds one. */
  urlFor(id: string): string | null {
    const entry = this.files.get(id);
    if (!entry) return null;
    entry.url ??= URL.createObjectURL(entry.file);
    return entry.url;
  }

  release(id: string): void {
    const entry = this.files.get(id);
    if (entry?.url) {
      URL.revokeObjectURL(entry.url);
      entry.url = null;
    }
  }

  remove(id: string): void {
    this.release(id);
    this.files.delete(id);
  }

  clear(): void {
    for (const id of [...this.files.keys()]) this.remove(id);
  }
}
