import { useCallback, useEffect, useState } from 'react';
import { listOutputDevices, onDeviceChange, type OutputDevice } from '../audio/outputDevices';

export function useOutputDevices(): { devices: OutputDevice[]; refresh: () => Promise<void> } {
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const refresh = useCallback(async () => setDevices(await listOutputDevices()), []);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listOutputDevices().then((list) => {
        if (!cancelled) setDevices(list);
      });
    void load();
    const off = onDeviceChange(() => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return { devices, refresh };
}
