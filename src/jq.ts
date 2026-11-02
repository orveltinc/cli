import { InputError } from './input';
import type { JqInput } from 'jq-wasm/inline';

export class OutputError extends Error {
  readonly exitCode = 1;
}

type WorkerResult = null | { values: unknown[] } | { rawValues: unknown[] };
type WorkerReply =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: string };
type CompileMessage = { kind: 'compile'; filter: string };
type RunMessage = { kind: 'run'; filter: string; value: unknown; raw: boolean };

type Pending = {
  resolve: (value: WorkerResult) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

function workerURL() {
  // The source runner and the bundled executable have different sibling
  // extensions. The parent build emits jq-worker.js as a separate entry.
  return new URL(
    import.meta.url.endsWith('.ts') ? './jq-worker.ts' : './jq-worker.js',
    import.meta.url,
  );
}

function abortError() {
  return new OutputError('Output processing was cancelled.');
}

class JqWorker {
  private readonly worker: Worker;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly signal?: AbortSignal;
  private readonly timeoutMs: number;
  private readonly abortListener?: () => void;
  private terminalError?: Error;

  constructor(signal?: AbortSignal, timeoutMs = 30_000) {
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.worker = new Worker(workerURL(), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new OutputError(message.error));
    });
    this.worker.addEventListener('error', () => this.fail(new OutputError('jq worker failed.')));
    this.worker.addEventListener('messageerror', () =>
      this.fail(new OutputError('jq worker returned an invalid result.')),
    );
    if (signal) {
      this.abortListener = () => this.fail(abortError());
      signal.addEventListener('abort', this.abortListener, { once: true });
    }
  }

  request(message: Omit<CompileMessage, 'id'> | Omit<RunMessage, 'id'>): Promise<WorkerResult> {
    if (this.signal?.aborted) return Promise.reject(abortError());
    if (this.closed)
      return Promise.reject(this.terminalError ?? new OutputError('Output worker is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new OutputError('jq output processing timed out.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // A Worker, not Window.postMessage: there is no targetOrigin argument.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      this.worker.postMessage({ ...message, id });
    });
  }

  close(error: Error = new OutputError('Output worker closed.')) {
    if (this.closed) return;
    this.terminalError = error;
    this.closed = true;
    if (this.signal && this.abortListener)
      this.signal.removeEventListener('abort', this.abortListener);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: Error) {
    this.close(error);
  }
}

export async function compileJq(
  filter: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  if (!filter.trim()) throw new InputError('The jq filter must not be empty.');
  const worker = new JqWorker(options.signal, options.timeoutMs);
  try {
    await worker.request({ kind: 'compile', filter });
  } catch (error) {
    worker.close();
    if (error instanceof OutputError && error.message === 'Invalid jq filter.')
      throw new InputError('Invalid jq filter.');
    throw error;
  }
  return worker;
}

export async function runJq(worker: JqWorker, filter: string, value: JqInput, raw: boolean) {
  return worker.request({ kind: 'run', filter, value, raw });
}

export type { JqWorker };
