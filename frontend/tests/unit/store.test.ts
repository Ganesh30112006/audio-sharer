import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../../src/utils/store';
import { Disposer } from '../../src/utils/disposer';

describe('createStore', () => {
  it('notifies only on real changes', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    store.set({ a: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual({ a: 2, b: 'x' });
  });

  it('supports functional updates and unsubscribe', () => {
    const store = createStore({ n: 0 });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.set((s) => ({ n: s.n + 1 }));
    off();
    store.set((s) => ({ n: s.n + 1 }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get().n).toBe(2);
  });
});

describe('Disposer', () => {
  it('runs cleanups once in reverse order and immediately after disposal', () => {
    const order: number[] = [];
    const d = new Disposer();
    d.add(() => order.push(1));
    d.add(() => order.push(2));
    d.dispose();
    d.dispose();
    expect(order).toEqual([2, 1]);
    d.add(() => order.push(3));
    expect(order).toEqual([2, 1, 3]);
  });

  it('removes event listeners', () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const d = new Disposer();
    d.listen(target, 'ping', handler);
    target.dispatchEvent(new Event('ping'));
    d.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
