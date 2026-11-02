/** Deliberately contains only locally authored messages, never OAuth bodies or credentials. */
export class AuthError extends Error {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly kind: 'auth' | 'forbidden' | 'security' | 'network' | 'storage' | 'cancelled' = 'auth',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export function loginRequired(): AuthError {
  return new AuthError(
    'No usable authorization. Run orvelt auth login (with --server for a custom server).',
  );
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted)
    throw new AuthError(
      'Operation cancelled or timed out. If an API operation was in progress, its outcome may be unknown; inspect current state before a manual retry.',
      'cancelled',
    );
}

export function deadline(timeoutMs: number, parent?: AbortSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new AuthError('Timeout must be a positive integer number of milliseconds.', 'security');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
