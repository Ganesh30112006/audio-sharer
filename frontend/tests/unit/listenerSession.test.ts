import { describe, expect, it, vi } from 'vitest';
import { ListenerSession } from '../../src/services/listenerSession';
import { settingsStore } from '../../src/services/settings';

describe('ListenerSession buffer mode', () => {
  it('re-targets the playback buffer only when the buffer mode itself changes', async () => {
    settingsStore.set({ bufferMode: 'auto' });
    const session = new ListenerSession('ABCDEF');
    const setTarget = vi.spyOn(session.lossless, 'setTargetMs');
    // Unrelated settings must not reset the adaptive lossless buffer.
    settingsStore.set({ showDiagnostics: !settingsStore.get().showDiagnostics });
    settingsStore.set({ displayName: 'Someone else' });
    expect(setTarget).not.toHaveBeenCalled();
    settingsStore.set({ bufferMode: 'stable' });
    expect(setTarget).toHaveBeenCalledTimes(1);
    expect(setTarget).toHaveBeenLastCalledWith(300, false);
    settingsStore.set({ bufferMode: 'auto' });
    expect(setTarget).toHaveBeenCalledTimes(2);
    await session.dispose();
  });
});
