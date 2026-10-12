import { handle, type CodecReply, type CodecRequest } from './codecWorker';

/**
 * Runs codec requests in a dedicated Web Worker so encoding/decoding never
 * competes with UI work on the main thread. Falls back to running inline where
 * workers are unavailable (tests, very old browsers).
 */
export class CodecClient {
  private worker: Worker | null = null;
  private onReply: (reply: CodecReply) => void;

  constructor(onReply: (reply: CodecReply) => void) {
    this.onReply = onReply;
    if (typeof Worker !== 'undefined') {
      try {
        this.worker = new Worker(new URL('./codecWorker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e: MessageEvent<CodecReply>) => this.onReply(e.data);
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
      this.worker.postMessage(req, transfer);
      return;
    }
    const { reply } = handle(req);
    // Keep the async contract identical to the worker path.
    queueMicrotask(() => this.onReply(reply));
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.onReply = () => undefined;
  }
}
