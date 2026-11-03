import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { AuthError, checkAbort } from './errors';

const callbackPath = '/oauth/callback';
const response = (body: string, status: number) => ({
  body,
  status,
  headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  },
});
export async function createCallback(signal: AbortSignal) {
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
  let origin = '';
  const server = createServer((request, responseStream) => {
    const send = (value: ReturnType<typeof response>) => {
      responseStream.writeHead(value.status, value.headers);
      responseStream.end(value.body);
    };
    let url: URL;
    try {
      url = new URL(request.url ?? '/', origin);
    } catch {
      send(response('Invalid callback.', 400));
      return;
    }
    let responseResult = response('Not found.', 404);
    if (url.origin !== origin || request.headers.host !== new URL(origin).host) {
      responseResult = response('Not found.', 404);
    } else if (url.pathname === callbackPath) {
      if (request.method !== 'GET') responseResult = response('Method not allowed.', 405);
      else if (used) responseResult = response('This callback has already been used.', 410);
      else {
        const params = url.searchParams;
        const duplicate = ['state', 'code', 'error', 'iss', 'error_description', 'error_uri'].some(
          (key) => params.getAll(key).length > 1,
        );
        const received = Buffer.from(params.get('state') ?? '');
        const expected = Buffer.from(state);
        const validState =
          received.length === expected.length && timingSafeEqual(received, expected);
        const code = params.get('code');
        const error = params.get('error');
        if (
          duplicate ||
          !validState ||
          (!code && !error) ||
          (code && error) ||
          (code?.length ?? 0) > 8192
        )
          responseResult = response(
            duplicate || (!code && !error) || (code && error) || (code?.length ?? 0) > 8192
              ? 'Invalid callback.'
              : 'Invalid callback state.',
            400,
          );
        else {
          // Consume synchronously, before token exchange. No retries/replays of authorization codes.
          used = true;
          resolve(params);
          responseResult = response(
            error
              ? 'Authorization was not completed. You may close this window.'
              : 'Authorization received. You may close this window and return to the CLI.',
            200,
          );
        }
      }
    }
    send(responseResult);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectListen(new Error('Callback server failed to start.'));
        return;
      }
      origin = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  const abort = () => {
    used = true;
    reject(new AuthError('Login cancelled or timed out.', 'cancelled'));
    server.closeAllConnections();
    server.close();
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
        server.closeAllConnections();
        server.close();
      }, 100);
      try {
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
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
