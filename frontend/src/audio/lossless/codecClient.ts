import { handle, type CodecReply, type CodecRequest } from './codecWorker';

/**
 * Runs codec requests in a dedicated Web Worker so encoding/decoding never
 * competes with UI work on the main thread. Falls back to running inline where
 * workers are unavailable (tests, very old browsers) and if the worker dies.
 *
 * Every request is answered exactly once, in order: if the worker fails, the
 * requests it never answered get explicit 'error' replies (the pipelines turn
 * those into reported interruptions) and later requests run in-thread.
 */
export class CodecClient {
  private worker: Worker | null = null;
  private onReply: (reply: CodecReply) => void;
  /** Requests posted to the worker and not yet answered (replies come back in order). */
  private outstanding: Array<{ gen: number; seq: number }> = [];

  constructor(onReply: (reply: CodecReply) => void) {
    this.onReply = onReply;
    if (typeof Worker !== 'undefined') {
      try {
        const worker = new Worker(new URL('./codecWorker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (e: MessageEvent<CodecReply>) => {
          this.outstanding.shift();
          this.onReply(e.data);
        };
        worker.onerror = () => this.fallBack('Codec worker failed');
        worker.onmessageerror = () => this.fallBack('Codec worker message could not be read');
        this.worker = worker;
      } catch {
        this.worker = null;
      }
    }
  }

  get offMainThread(): boolean {
    return this.worker !== null;
  }

  post(req: CodecRequest, transfer: Transferable[] = []): void {
    if (this.worker) {
      this.outstanding.push({ gen: req.gen, seq: req.op === 'encode' ? req.block.seq : req.seq });
      this.worker.postMessage(req, transfer);
      return;
    }
    const { reply } = handle(req);
    // Keep the async contract identical to the worker path.
    queueMicrotask(() => this.onReply(reply));
  }

  /** The worker is gone: fail what it still owed, then continue in-thread. */
  private fallBack(message: string): void {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    const owed = this.outstanding;
    this.outstanding = [];
    for (const { gen, seq } of owed) this.onReply({ op: 'error', gen, seq, message, busyMs: 0 });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.outstanding = [];
    this.onReply = () => undefined;
  }
}
