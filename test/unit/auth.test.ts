import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authStatus,
  DEFAULT_SERVER,
  login,
  logout,
  normalizeServer,
  withApiClient,
  type ConnectionOptions,
} from '../../src/auth';
import { createCallback } from '../../src/auth/callback';
import { safeFetch, isUnsupportedTokenRevocation } from '../../src/auth/network';
import { createCredentialStore } from '../../src/credentials';

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Missing required test fixture value');
  return value;
}
let directory: string;
let previousMode: string | undefined;
let previousDirectory: string | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeEach(async () => {
  previousMode = process.env.ORVELT_CREDENTIAL_STORE;
  previousDirectory = process.env.ORVELT_CONFIG_DIR;
  directory = await mkdtemp(join(tmpdir(), 'orvelt-auth-'));
  process.env.ORVELT_CREDENTIAL_STORE = 'file';
  process.env.ORVELT_CONFIG_DIR = directory;
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await rm(directory, { recursive: true, force: true });
  if (previousMode === undefined) delete process.env.ORVELT_CREDENTIAL_STORE;
  else process.env.ORVELT_CREDENTIAL_STORE = previousMode;
  if (previousDirectory === undefined) delete process.env.ORVELT_CONFIG_DIR;
  else process.env.ORVELT_CONFIG_DIR = previousDirectory;
});

function protocolServer() {
  const state = {
    resourceOverride: undefined as string | undefined,
    issuerOverride: undefined as string | undefined,
    tokenEndpointOverride: undefined as string | undefined,
    revocation: true,
    revokeStatus: 200,
    revokeAccessUnsupported: false,
    revokeRefreshUnsupported: false,
    refreshStatus: 200,
    refreshBody: undefined as string | undefined,
    apiStatus: 200,
    retryAfter: undefined as string | undefined,
    xRetryAfter: undefined as string | undefined,
    modern: true,
    redirectApi: undefined as string | undefined,
    redirectToken: undefined as string | undefined,
    grantedScope: undefined as string | undefined,
    includeRefreshToken: true,
    registrations: [] as Array<Record<string, unknown>>,
    tokenRequests: [] as URLSearchParams[],
    revocations: [] as URLSearchParams[],
    api: [] as Array<{
      method: string;
      rpc: string;
      authorization: string | null;
      protocol: string | null;
    }>,
    requests: [] as Array<{ path: string; authorization: string | null }>,
    authorization: undefined as URL | undefined,
    accessToken: 'ACCESS_SECRET_0',
    refreshToken: 'REFRESH_SECRET_0',
    refreshes: 0,
    handleMcp: undefined as ((request: Request) => Promise<Response>) | undefined,
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      state.requests.push({
        path: url.pathname,
        authorization: request.headers.get('authorization'),
      });
      if (url.pathname === '/.well-known/oauth-protected-resource/v1')
        return Response.json({
          resource: state.resourceOverride ?? resource,
          authorization_servers: [state.issuerOverride ?? origin],
          scopes_supported: ['business:read', 'business:write', 'offline_access'],
        });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: state.tokenEndpointOverride ?? `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          ...(state.revocation ? { revocation_endpoint: `${origin}/revoke` } : {}),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: ['business:read', 'business:write', 'offline_access'],
          authorization_response_iss_parameter_supported: true,
        });
      if (url.pathname === '/register') {
        const body = (await request.json()) as Record<string, unknown>;
        state.registrations.push(body);
        return Response.json(
          { ...body, client_id: `public-${state.registrations.length}` },
          { status: 201 },
        );
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams(await request.text());
        state.tokenRequests.push(body);
        if (state.redirectToken) return Response.redirect(state.redirectToken, 307);
        if (body.get('grant_type') === 'authorization_code') {
          const authorization = required(state.authorization);
          if (
            body.get('code') !== 'ONE_USE_CODE_SECRET' ||
            body.get('redirect_uri') !== authorization.searchParams.get('redirect_uri') ||
            body.get('resource') !== resource ||
            createHash('sha256')
              .update(body.get('code_verifier') ?? '')
              .digest('base64url') !== authorization.searchParams.get('code_challenge')
          )
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
        } else {
          if (state.refreshStatus !== 200)
            return state.refreshBody === undefined
              ? Response.json(
                  { error: 'invalid_grant', error_description: 'REFRESH_SECRET_0' },
                  { status: state.refreshStatus },
                )
              : new Response(state.refreshBody, { status: state.refreshStatus });
          if (body.get('refresh_token') !== state.refreshToken || body.get('resource') !== resource)
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          state.refreshes++;
          state.refreshToken = `REFRESH_SECRET_${state.refreshes}`;
          state.accessToken = `ACCESS_SECRET_${state.refreshes}`;
        }
        return Response.json({
          access_token: state.accessToken,
          ...(state.includeRefreshToken ? { refresh_token: state.refreshToken } : {}),
          token_type: 'Bearer',
          expires_in: 300,
          scope: state.grantedScope ?? required(state.authorization).searchParams.get('scope'),
        });
      }
      if (url.pathname === '/revoke') {
        const body = new URLSearchParams(await request.text());
        state.revocations.push(body);
        if (
          (body.get('token_type_hint') === 'access_token' && state.revokeAccessUnsupported) ||
          (body.get('token_type_hint') === 'refresh_token' && state.revokeRefreshUnsupported)
        ) {
          return Response.json(
            { error: 'unsupported_token_type', error_description: 'UNTRUSTED_REMOTE_SECRET' },
            { status: 400 },
          );
        }
        return new Response(state.revokeStatus === 200 ? '' : 'REFRESH_SECRET_0', {
          status: state.revokeStatus,
        });
      }
      if (url.pathname.startsWith('/rpc/v2/business/')) {
        state.api.push({
          method: request.method,
          rpc: url.pathname,
          authorization: request.headers.get('authorization'),
          protocol: null,
        });
        if (state.redirectApi) return Response.redirect(state.redirectApi, 307);
        if (state.apiStatus !== 200)
          return new Response('ACCESS_SECRET_0', {
            status: state.apiStatus,
            headers: {
              ...(state.retryAfter ? { 'Retry-After': state.retryAfter } : {}),
              ...(state.xRetryAfter ? { 'X-Retry-After': state.xRetryAfter } : {}),
            },
          });
        if (request.headers.get('authorization') !== 'Bearer ' + state.accessToken)
          return new Response(null, { status: 401 });
        return Response.json({ json: { operations: [] } });
      }
      return new Response(null, { status: 404 });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const resource = `${origin}/v1`;
  const logs: string[] = [];
  const options: ConnectionOptions = {
    server: resource,
    timeoutMs: 3000,
    log: (message) => logs.push(message),
  };
  async function authorize({
    write = false,
    denial = false,
    wrongIssuer = false,
    abort,
  }: { write?: boolean; denial?: boolean; wrongIssuer?: boolean; abort?: AbortController } = {}) {
    let callbackTask: Promise<void> | undefined;
    const result = login({
      ...options,
      write,
      browser: false,
      signal: abort?.signal,
      log(message) {
        logs.push(message);
        const url = new URL(required(message.split('\n')[1]));
        state.authorization = url;
        callbackTask = (async () => {
          const callback = new URL(required(url.searchParams.get('redirect_uri')));
          callback.searchParams.set('state', required(url.searchParams.get('state')));
          callback.searchParams.set('iss', wrongIssuer ? 'https://evil.test' : origin);
          callback.searchParams.set(
            denial ? 'error' : 'code',
            denial ? 'access_denied' : 'ONE_USE_CODE_SECRET',
          );
          if (denial) callback.searchParams.set('error_description', 'ATTACKER_SECRET');
          expect((await fetch(callback)).status).toBe(200);
        })();
      },
    });
    try {
      return await result;
    } finally {
      await callbackTask;
    }
  }
  return { state, resource, origin, options, authorize, logs };
}

describe('OAuth and direct Business API', () => {
  test('URL validation: HTTPS remotely, explicit HTTP loopback only, no secrets/query/fragment', () => {
    expect(DEFAULT_SERVER).toBe('https://api.orvelt.com/v1');
    expect(normalizeServer(' HTTPS://API.ORVELT.COM:443/v1 ')).toBe(DEFAULT_SERVER);
    for (const value of [
      'http://remote.test/mcp',
      'ftp://localhost/mcp',
      'https://u:p@host/mcp',
      'https://host/mcp?q=secret',
      'https://host/mcp#fragment',
      'https://host/mcp#',
      '/mcp',
      'http://127.0.0.2/mcp',
    ])
      expect(() => normalizeServer(value)).toThrow();
    expect(normalizeServer('http://127.0.0.1:1234/mcp')).toBe('http://127.0.0.1:1234/mcp');
    expect(normalizeServer('http://[::1]:1234/mcp')).toBe('http://[::1]:1234/mcp');
  });

  test('public DCR + PKCE login defaults to read-only despite advertised write scope', async () => {
    const fake = protocolServer();
    const result = await fake.authorize();
    expect(result).toMatchObject({
      stored: true,
      authorized: true,
      serverVerified: false,
      scopes: ['business:read', 'offline_access'],
    });
    expect(fake.state.registrations[0]).toMatchObject({
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      application_type: 'native',
      scope: 'business:read offline_access',
    });
    const url = required(fake.state.authorization);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('resource')).toBe(fake.resource);
    expect(url.searchParams.get('prompt')).toBe('consent');
    const text = await readFile(join(directory, required((await readdir(directory))[0])), 'utf8');
    expect(text).not.toContain(required(url.searchParams.get('state')));
    expect(text).not.toContain(
      required(required(fake.state.tokenRequests[0]).get('code_verifier')),
    );
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(fake.logs.join('\n')).not.toContain('SECRET');
    expect(
      fake.state.requests
        .filter((request) => !request.path.startsWith('/rpc/v2/business/'))
        .every((request) => request.authorization === null),
    ).toBe(true);
  });

  test('repeat login reuses the native client but requests a fresh read-only grant', async () => {
    const fake = protocolServer();
    await fake.authorize({ write: true });
    expect(required(fake.state.authorization).searchParams.get('scope')).toBe(
      'business:read business:write offline_access',
    );
    await fake.authorize();
    expect(fake.state.registrations).toHaveLength(1);
    expect(fake.state.tokenRequests.map((body) => body.get('client_id'))).toEqual([
      'public-1',
      'public-1',
    ]);
    expect((await createCredentialStore().read(fake.resource))?.scopes).toEqual([
      'business:read',
      'offline_access',
    ]);
  });

  test('write upgrade registers sufficient capabilities once, independent of later granted scopes', async () => {
    const fake = protocolServer();
    await fake.authorize();
    await fake.authorize({ write: true });
    expect(fake.state.registrations).toHaveLength(2);
    await fake.authorize();
    expect((await createCredentialStore().read(fake.resource))?.scopes).not.toContain(
      'business:write',
    );
    await fake.authorize({ write: true });
    expect(fake.state.registrations).toHaveLength(2);
    expect(fake.state.tokenRequests.map((body) => body.get('client_id'))).toEqual([
      'public-1',
      'public-2',
      'public-2',
      'public-2',
    ]);
  });

  test('status verifies OAuth against the Business API without contacting MCP', async () => {
    const fake = protocolServer();
    await fake.authorize();
    expect(await authStatus(fake.options)).toMatchObject({ validity: 'verified' });
    expect(fake.state.api).toHaveLength(1);
    expect(fake.state.api[0]).toMatchObject({
      method: 'POST',
      rpc: '/rpc/v2/business/oauthConnections/operations',
      authorization: 'Bearer ACCESS_SECRET_0',
    });
    expect(fake.state.requests.some((request) => request.path === '/mcp')).toBe(false);
  });

  test('HTTP 401 never refreshes or replays an API call', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.apiStatus = 401;
    await expect(
      withApiClient(fake.options, (client) =>
        client.call(['project', 'update'], { title: 'once' }, fake.options),
      ),
    ).rejects.toThrow('not replayed');
    expect(fake.state.api).toHaveLength(1);
    expect(fake.state.refreshes).toBe(0);
    expect(fake.state.registrations).toHaveLength(1);
  });

  test('commands never start interactive auth; missing credentials and insufficient scope are actionable', async () => {
    const fake = protocolServer();
    await expect(withApiClient(fake.options, async () => {})).rejects.toThrow('orvelt auth login');
    expect(fake.state.registrations).toHaveLength(0);
    await fake.authorize();
    fake.state.apiStatus = 403;
    await expect(
      withApiClient(fake.options, (client) =>
        client.call(['oauthConnections', 'operations'], {}, fake.options),
      ),
    ).rejects.toThrow('permission');
    expect(fake.state.registrations).toHaveLength(1);
    expect(fake.state.refreshes).toBe(0);
  });

  test('expired credentials refresh once under competing connections, rotation persists before use', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const store = createCredentialStore();
    const credential = required(await store.read(fake.resource));
    await store.write(fake.resource, { ...credential, expiresAt: Date.now() - 1 });
    await Promise.all(
      [1, 2, 3].map(() =>
        withApiClient(fake.options, async (client) => {
          await client.call(['oauthConnections', 'operations'], {}, fake.options);
        }),
      ),
    );
    expect(fake.state.refreshes).toBe(1);
    expect((await store.read(fake.resource))?.tokens.refresh_token).toBe('REFRESH_SECRET_1');
    expect(
      fake.state.api.every((request) => request.authorization === 'Bearer ACCESS_SECRET_1'),
    ).toBe(true);
    expect(required(fake.state.tokenRequests[1]).get('scope')).toBeNull();
  });

  test('CLI process login survives restart and concurrent processes share refresh rotation safely', async () => {
    const fake = protocolServer();
    const executable = new URL('../../src/index.ts', import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        executable,
        '--server',
        fake.resource,
        'auth',
        'login',
        '--no-browser',
        '--json',
      ],
      { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
    );
    const readAuthorization = (async () => {
      let stderr = '';
      let callbackSent = false;
      for await (const chunk of child.stderr) {
        stderr += Buffer.from(chunk).toString('utf8');
        const link = stderr.match(/https?:\/\/[^\s]+/);
        if (!callbackSent && link) {
          callbackSent = true;
          const authorization = new URL(link[0]);
          fake.state.authorization = authorization;
          const callback = new URL(required(authorization.searchParams.get('redirect_uri')));
          callback.searchParams.set('state', required(authorization.searchParams.get('state')));
          callback.searchParams.set('code', 'ONE_USE_CODE_SECRET');
          callback.searchParams.set('iss', fake.origin);
          expect((await fetch(callback)).status).toBe(200);
        }
      }
      return stderr;
    })();
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        readAuthorization,
      ]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({
        stored: true,
        scopes: ['business:read', 'offline_access'],
      });
      expect(stderr).not.toContain('SECRET');
      const store = createCredentialStore();
      const credential = required(await store.read(fake.resource));
      await store.write(fake.resource, { ...credential, expiresAt: Date.now() - 1 });
      const commands = [1, 2, 3].map(() => {
        const command = Bun.spawn(
          [process.execPath, executable, '--server', fake.resource, 'tools', 'list', '--json'],
          { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
        );
        return Promise.all([
          command.exited,
          new Response(command.stdout).text(),
          new Response(command.stderr).text(),
        ]);
      });
      for (const [code, output, diagnostics] of await Promise.all(commands)) {
        expect(code).toBe(0);
        expect(JSON.parse(output)).toEqual([]);
        expect(diagnostics).toBe('');
      }
      expect(fake.state.refreshes).toBe(1);
      expect(fake.state.registrations).toHaveLength(1);
      expect((await store.read(fake.resource))?.tokens.refresh_token).toBe('REFRESH_SECRET_1');
      expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
    } finally {
      child.kill();
      await readAuthorization;
    }
  });

  test('rejected API tokens require explicit sign-in, never automatic scope escalation', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.apiStatus = 401;
    expect(await authStatus(fake.options)).toMatchObject({ validity: 'reauthentication_required' });
    expect(fake.state.refreshes).toBe(0);
    expect(fake.state.registrations).toHaveLength(1);
    fake.state.apiStatus = 403;
    await expect(
      withApiClient(fake.options, (client) => client.call(['project', 'update'], {}, fake.options)),
    ).rejects.toThrow('permission');
    expect(fake.state.registrations).toHaveLength(1);
  });

  test('a callback action error retains its identity and still closes/releases the connection', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const expected = new Error('Locally authored operation validation error');
    const caught = await withApiClient(fake.options, async () => {
      throw expected;
    }).catch((error: unknown) => error);
    expect(caught).toBe(expected);
    expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
    await withApiClient(fake.options, async () => {});
  });

  test('consent may decline write scope; unsolicited write grants are rejected', async () => {
    const fake = protocolServer();
    fake.state.grantedScope = 'business:read offline_access';
    expect(await fake.authorize({ write: true })).toMatchObject({
      scopes: ['business:read', 'offline_access'],
    });
    const before = await createCredentialStore().read(fake.resource);
    fake.state.grantedScope = 'business:read business:write offline_access';
    await expect(fake.authorize()).rejects.toThrow('unrequested scopes');
    expect(await createCredentialStore().read(fake.resource)).toEqual(before);
  });

  test('declining offline access stores a usable short-lived grant without requiring a refresh token', async () => {
    const fake = protocolServer();
    fake.state.grantedScope = 'business:read';
    fake.state.includeRefreshToken = false;
    expect(await fake.authorize()).toMatchObject({ scopes: ['business:read'], stored: true });
    expect(
      (await createCredentialStore().read(fake.resource))?.tokens.refresh_token,
    ).toBeUndefined();
    expect(await authStatus(fake.options)).toMatchObject({ validity: 'verified' });
    expect(fake.state.refreshes).toBe(0);
  });

  test('rate limiting exposes only a bounded Retry-After value and never automatically retries', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.apiStatus = 429;
    const status = await authStatus(fake.options);
    expect(status).toMatchObject({ validity: 'not_verified' });
    expect(JSON.stringify(status)).toContain('rate limit');
    expect(JSON.stringify(status)).not.toContain('SECRET');
    expect(fake.state.refreshes).toBe(0);
    expect(fake.state.api).toHaveLength(1);
  });

  test('rate limiting falls back to a valid X-Retry-After when Retry-After is invalid', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.apiStatus = 429;
    fake.state.retryAfter = 'not-a-date';
    fake.state.xRetryAfter = '7';
    const status = await authStatus(fake.options);
    expect(JSON.stringify(status)).toContain('Wait 7 seconds');
  });

  test('abort interrupts a pending API action and releases the lock', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const abort = new AbortController();
    await expect(
      withApiClient({ ...fake.options, signal: abort.signal }, async (client) => {
        abort.abort();
        await client.call(['oauthConnections', 'operations'], {}, fake.options);
      }),
    ).rejects.toThrow('cancelled');
    expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
  });

  test('near-expiry access tokens without refresh tokens remain usable until expiry', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const store = createCredentialStore();
    const credential = required(await store.read(fake.resource));
    await store.write(fake.resource, {
      ...credential,
      tokens: { ...credential.tokens, refresh_token: undefined },
      expiresAt: Date.now() + 20_000,
    });
    expect(await authStatus(fake.options)).toMatchObject({ validity: 'verified' });
    expect(fake.state.refreshes).toBe(0);
    await store.write(fake.resource, {
      ...credential,
      tokens: { ...credential.tokens, refresh_token: undefined },
      expiresAt: Date.now() - 1,
    });
    expect(await authStatus(fake.options)).toMatchObject({
      stored: true,
      validity: 'reauthentication_required',
    });
  });

  test('refresh rate limits are not reported as invalid credentials', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const store = createCredentialStore();
    const credential = required(await store.read(fake.resource));
    await store.write(fake.resource, { ...credential, expiresAt: Date.now() - 1 });
    fake.state.refreshStatus = 429;
    expect(await authStatus(fake.options)).toMatchObject({
      stored: true,
      validity: 'not_verified',
    });
    expect(fake.state.registrations).toHaveLength(1);
  });

  test('a 502 after refresh dispatch preserves the uncertain fence', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const store = createCredentialStore();
    const credential = required(await store.read(fake.resource));
    await store.write(fake.resource, { ...credential, expiresAt: Date.now() - 1 });
    fake.state.refreshStatus = 502;
    fake.state.refreshBody = '<html>gateway failure</html>';
    expect(await authStatus(fake.options)).toMatchObject({ validity: 'not_verified' });
    expect((await store.read(fake.resource))?.refreshState).toBe('uncertain');
  });

  test('a malformed non-success refresh response preserves the uncertain fence', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const store = createCredentialStore();
    const credential = required(await store.read(fake.resource));
    await store.write(fake.resource, { ...credential, expiresAt: Date.now() - 1 });
    fake.state.refreshStatus = 400;
    fake.state.refreshBody = '{not-json';
    expect(await authStatus(fake.options)).toMatchObject({ validity: 'not_verified' });
    expect((await store.read(fake.resource))?.refreshState).toBe('uncertain');
  });

  test('status does not claim invalidity on network/server failure', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.apiStatus = 503;
    expect(await authStatus(fake.options)).toMatchObject({
      stored: true,
      validity: 'not_verified',
    });
  });

  test('denial and callback issuer mismatch preserve old tokens and never redeem the code', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const before = await createCredentialStore().read(fake.resource);
    await expect(fake.authorize({ denial: true })).rejects.toThrow('denied or cancelled');
    await expect(fake.authorize({ wrongIssuer: true })).rejects.toThrow();
    expect(fake.state.tokenRequests).toHaveLength(1);
    expect(await createCredentialStore().read(fake.resource)).toEqual(before);
    expect(fake.logs.join('')).not.toContain('ATTACKER_SECRET');
  });

  test('rejects changed issuer/resource before bearer or refresh tokens can leave the process', async () => {
    const fake = protocolServer();
    const other = protocolServer();
    await fake.authorize();
    fake.state.issuerOverride = other.origin;
    await expect(withApiClient(fake.options, async () => {})).rejects.toThrow(
      'issuer or resource changed',
    );
    expect(other.state.tokenRequests).toHaveLength(0);
    expect(fake.state.api).toHaveLength(0);
    fake.state.issuerOverride = undefined;
    fake.state.resourceOverride = `${fake.origin}/other`;
    await expect(withApiClient(fake.options, async () => {})).rejects.toThrow('exact API resource');
    expect(fake.state.api).toHaveLength(0);
  });

  test('rejects insecure advertised token endpoint and resource/token redirects without forwarding secrets', async () => {
    const fake = protocolServer();
    const other = protocolServer();
    fake.state.tokenEndpointOverride = 'http://insecure.example.test/token';
    await expect(fake.authorize()).rejects.toThrow('HTTPS');
    expect(fake.state.registrations).toHaveLength(0);
    fake.state.tokenEndpointOverride = undefined;
    await fake.authorize();
    fake.state.redirectApi = other.resource;
    await expect(
      withApiClient(fake.options, (client) =>
        client.call(['oauthConnections', 'operations'], {}, fake.options),
      ),
    ).rejects.toThrow('redirects');
    expect(other.state.requests).toHaveLength(0);
    fake.state.redirectToken = `${other.origin}/token`;
    await expect(fake.authorize()).rejects.toThrow('redirects');
    expect(other.state.requests).toHaveLength(0);
  });

  test('default logout revokes refresh then access before deletion; accepted is not a universal revocation claim', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const result = await logout({ ...fake.options, local: false });
    expect(result).toMatchObject({ localDeleted: true, revocation: 'accepted', stored: false });
    expect(fake.state.revocations.map((body) => body.get('token_type_hint'))).toEqual([
      'refresh_token',
      'access_token',
    ]);
    expect(fake.state.revocations.every((body) => body.get('client_id') === 'public-1')).toBe(true);
    expect(await createCredentialStore().read(fake.resource)).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  test('unsupported/failed revocation retains credentials; explicit local logout does not contact the server', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.revocation = false;
    await expect(logout({ ...fake.options, local: false })).rejects.toThrow('logout --local');
    expect(await createCredentialStore().read(fake.resource)).toBeDefined();
    fake.state.revocation = true;
    fake.state.revokeStatus = 500;
    await expect(logout({ ...fake.options, local: false })).rejects.toThrow('retained');
    expect(await createCredentialStore().read(fake.resource)).toBeDefined();
    const requests = fake.state.requests.length;
    expect(await logout({ ...fake.options, local: true })).toMatchObject({
      localDeleted: true,
      revocation: 'not_attempted',
    });
    expect(fake.state.requests).toHaveLength(requests);
  });

  test('unsupported JWT revocation is explicit after successful refresh revocation', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.revokeAccessUnsupported = true;
    const result = await logout({ ...fake.options, local: false });
    expect(result).toMatchObject({
      localDeleted: true,
      revocation: 'accepted',
      accessTokenRevocation: 'unsupported',
    });
    expect(JSON.stringify(result)).toContain('until token expiry');
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED_REMOTE_SECRET');
    expect(await createCredentialStore().read(fake.resource)).toBeUndefined();
  });

  test('unsupported refresh revocation is never mistaken for successful logout', async () => {
    const fake = protocolServer();
    await fake.authorize();
    fake.state.revokeRefreshUnsupported = true;
    await expect(logout({ ...fake.options, local: false })).rejects.toThrow('Credentials retained');
    expect(fake.state.revocations).toHaveLength(1);
    expect(await createCredentialStore().read(fake.resource)).toBeDefined();
  });

  test('JWT-only logout reports unsupported revocation instead of claiming remote invalidation', async () => {
    const fake = protocolServer();
    await fake.authorize();
    const store = createCredentialStore();
    const credential = required(await store.read(fake.resource));
    await store.write(fake.resource, {
      ...credential,
      tokens: { ...credential.tokens, refresh_token: undefined },
    });
    fake.state.revokeAccessUnsupported = true;
    expect(await logout({ ...fake.options, local: false })).toMatchObject({
      localDeleted: true,
      revocation: 'not_supported',
      accessTokenRevocation: 'unsupported',
    });
  });

  test('logout never sends tokens to a newly advertised issuer', async () => {
    const fake = protocolServer();
    const other = protocolServer();
    await fake.authorize();
    fake.state.issuerOverride = other.origin;
    await expect(logout({ ...fake.options, local: false })).rejects.toThrow('issuer changed');
    expect(other.state.revocations).toHaveLength(0);
    expect(await createCredentialStore().read(fake.resource)).toBeDefined();
  });

  test('login timeout/abort closes callback listener and releases credential lock', async () => {
    const fake = protocolServer();
    let redirect: string | undefined;
    await expect(
      login({
        ...fake.options,
        timeoutMs: 100,
        write: false,
        browser: false,
        log(message) {
          redirect = required(
            new URL(required(message.split('\n')[1])).searchParams.get('redirect_uri'),
          );
        },
      }),
    ).rejects.toThrow('timed out');
    expect(redirect).toBeDefined();
    await expect(fetch(required(redirect))).rejects.toThrow();
    expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false);
    const abort = new AbortController();
    await expect(
      login({
        ...fake.options,
        signal: abort.signal,
        write: false,
        browser: false,
        log() {
          abort.abort();
        },
      }),
    ).rejects.toThrow('cancelled');
  });

  test('production context cannot use a loopback HTTP OAuth endpoint', async () => {
    await expect(
      safeFetch(
        DEFAULT_SERVER,
        AbortSignal.timeout(1000),
        'discovery',
      )('http://127.0.0.1:1234/metadata'),
    ).rejects.toThrow('HTTPS');
  });
});

describe('loopback callback boundary', () => {
  test('exact method/path/host/state, unique parameters, and one-use code', async () => {
    const callback = createCallback(AbortSignal.timeout(2000));
    try {
      const valid = new URL(callback.redirectUri);
      valid.searchParams.set('state', callback.state);
      valid.searchParams.set('code', 'one-use');
      expect((await fetch(valid, { method: 'POST' })).status).toBe(405);
      expect((await fetch(new URL('/wrong', valid))).status).toBe(404);
      expect((await fetch(valid, { headers: { Host: 'evil.test' } })).status).toBe(404);
      const invalid = new URL(valid);
      invalid.searchParams.set('state', 'wrong');
      expect((await fetch(invalid)).status).toBe(400);
      const duplicate = new URL(valid);
      duplicate.searchParams.append('code', 'second');
      expect((await fetch(duplicate)).status).toBe(400);
      expect((await fetch(valid)).status).toBe(200);
      expect((await callback.result).get('code')).toBe('one-use');
      expect((await fetch(valid)).status).toBe(410);
    } finally {
      await callback.close();
    }
    await expect(fetch(callback.redirectUri)).rejects.toThrow();
  });
});

describe('bounded revocation error classification', () => {
  test.each([
    { status: 400, body: '{"error":"unsupported_token_type"}', accepted: true },
    { status: 401, body: '{"error":"unsupported_token_type"}', accepted: false },
    { status: 400, body: '{"error":"invalid_client"}', accepted: false },
    { status: 400, body: '{"error_description":"unsupported_token_type"}', accepted: false },
    { status: 400, body: '{malformed', accepted: false },
    { status: 400, body: ' '.repeat(8192) + '{"error":"unsupported_token_type"}', accepted: false },
  ])('accepts only the exact bounded OAuth error: %j', async ({ status, body, accepted }) => {
    expect(await isUnsupportedTokenRevocation(new Response(body, { status }))).toBe(accepted);
  });
});
