import { useCallback, useSyncExternalStore } from 'react';
import type { Store } from '../utils/store';

/**
 * Subscribe to a slice of a service store. Components re-render only when the
 * selected value changes (Object.is), not on every store update.
 */
export function useStore<T extends object, S>(store: Store<T>, selector: (state: T) => S): S {
  const get = useCallback(() => selector(store.get()), [store, selector]);
  return useSyncExternalStore(store.subscribe, get, get);
}

export function useStoreState<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
