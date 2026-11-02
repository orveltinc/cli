import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AuthError, checkAbort } from './errors';

const callbackPath = '/oauth/callback';
const response = (text: string, status: number) =>
  new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  });
export function createCallback(signal: AbortSignal) {
  checkAbort(signal);
  const state = randomBytes(32).toString('base64url');
  let used = false;
  let resolve!: (params: URLSearchParams) => void;
  let reject!: (error: AuthError) => void;
  const result = new Promise<URLSearchParams>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Aborts may arrive while discovery / registration is still pending.
  void result.catch(() => {});
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== origin || url.pathname !== callbackPath)
        return response('Not found.', 404);
      if (request.method !== 'GET') return response('Method not allowed.', 405);
      if (used) return response('This callback has already been used.', 410);
      const params = url.searchParams;
      if (
        ['state', 'code', 'error', 'iss', 'error_description', 'error_uri'].some(
          (key) => params.getAll(key).length > 1,
        )
      )
        return response('Invalid callback.', 400);
      const received = Buffer.from(params.get('state') ?? '');
      const expected = Buffer.from(state);
      if (received.length !== expected.length || !timingSafeEqual(received, expected))
        return response('Invalid callback state.', 400);
      const code = params.get('code');
      const error = params.get('error');
      if ((!code && !error) || (code && error) || (code?.length ?? 0) > 8192)
        return response('Invalid callback.', 400);
      // Consume synchronously, before token exchange. No retries/replays of authorization codes.
      used = true;
      resolve(params);
      return response(
        error
          ? 'Authorization was not completed. You may close this window.'
          : 'Authorization received. You may close this window and return to the CLI.',
        200,
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const abort = () => {
    used = true;
    reject(new AuthError('Login cancelled or timed out.', 'cancelled'));
    void server.stop(true);
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return {
    state,
    redirectUri: `${origin}${callbackPath}`,
    result,
    async close() {
      signal.removeEventListener('abort', abort);
      used = true;
      reject(new AuthError('Login callback closed.', 'cancelled'));
      // Drain the callback response, but never let a held-open socket defeat the deadline.
      const forceClose = setTimeout(() => {
        void server.stop(true);
      }, 100);
      try {
        await server.stop(false);
      } finally {
        clearTimeout(forceClose);
      }
    },
  };
}

/** argv only: never interpolate an authorization URL into a shell command. */
export async function openBrowser(url: URL, signal: AbortSignal): Promise<boolean> {
  checkAbort(signal);
  const command: [string, ...string[]] =
    process.platform === 'darwin'
      ? ['open', url.href]
      : process.platform === 'win32'
        ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url.href]
        : ['xdg-open', url.href];
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { shell: false, stdio: 'ignore', signal });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}
