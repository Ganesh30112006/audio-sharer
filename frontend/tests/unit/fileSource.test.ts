import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAudioFile, FileLibrary, MAX_FILE_BYTES } from '../../src/media/fileSource';

const canPlay = () => 'maybe';
const cannotPlay = () => '';

describe('checkAudioFile', () => {
  it('accepts supported formats by MIME or extension', () => {
    expect(checkAudioFile({ name: 'a.mp3', size: 10, type: 'audio/mpeg' }, canPlay)).toEqual({
      ok: true,
      mime: 'audio/mpeg',
    });
    expect(checkAudioFile({ name: 'b.FLAC', size: 10, type: '' }, canPlay).mime).toBe('audio/flac');
  });

  it('rejects unsupported, empty, oversized and unplayable files', () => {
    expect(
      checkAudioFile({ name: 'x.exe', size: 10, type: 'application/x-msdownload' }, canPlay).ok,
    ).toBe(false);
    expect(checkAudioFile({ name: 'x.mp3', size: 0, type: 'audio/mpeg' }, canPlay).ok).toBe(false);
    expect(
      checkAudioFile({ name: 'x.mp3', size: MAX_FILE_BYTES + 1, type: 'audio/mpeg' }, canPlay).ok,
    ).toBe(false);
    const r = checkAudioFile({ name: 'x.flac', size: 10, type: 'audio/flac' }, cannotPlay);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/cannot play/);
  });
});

describe('FileLibrary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates object URLs lazily and revokes them', () => {
    const create = vi.fn(() => 'blob:1');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const lib = new FileLibrary();
    const item = lib.add(new File(['x'], 'Song.mp3'), 'audio/mpeg');
    expect(item.title).toBe('Song');
    expect(create).not.toHaveBeenCalled();
    expect(lib.urlFor(item.id)).toBe('blob:1');
    expect(lib.urlFor(item.id)).toBe('blob:1');
    expect(create).toHaveBeenCalledTimes(1);
    lib.release(item.id);
    expect(revoke).toHaveBeenCalledWith('blob:1');
    lib.urlFor(item.id);
    lib.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(lib.urlFor(item.id)).toBeNull();
  });
});
