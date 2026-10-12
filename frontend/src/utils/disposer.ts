/**
 * Collects cleanup callbacks and runs them once, in reverse order. Every
 * service uses one so listeners, timers and tracks are released deterministically.
 */
export class Disposer {
  private fns: Array<() => void> = [];
  private disposed = false;

  add(fn: () => void): void {
    if (this.disposed) {
      fn();
      return;
    }
    this.fns.push(fn);
  }

  listen<K extends string>(
    target: {
      addEventListener(k: K, h: EventListener): void;
      removeEventListener(k: K, h: EventListener): void;
    },
    type: K,
    handler: EventListener,
  ): void {
    target.addEventListener(type, handler);
    this.add(() => target.removeEventListener(type, handler));
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const fns = this.fns.reverse();
    this.fns = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        console.error('cleanup failed', err);
      }
    }
  }
}
