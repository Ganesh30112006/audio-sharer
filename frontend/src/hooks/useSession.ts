import { useEffect, useState } from 'react';

/**
 * Creates a service instance after mount and disposes it on unmount. Creation
 * happens in an effect (not render), so StrictMode's mount/unmount/mount cycle
 * yields exactly one live instance and the discarded one is fully released.
 */
export function useSession<T extends { dispose(): unknown }>(
  factory: () => T | null,
  deps: unknown[],
): T | null {
  const [session, setSession] = useState<T | null>(null);
  useEffect(() => {
    const s = factory();
    // Publishing an externally created resource is the purpose of this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(s);
    return () => {
      void s?.dispose();
      setSession(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return session;
}
