import { RPCLink } from '@orpc/client/fetch';
import { ORPCError } from '@orpc/client';
import * as oauth from 'oauth4webapi';
import type { BusinessApiClient } from './operations';
import { createCredentialStore, type Credential, type CredentialStore } from './credentials';
import { createCallback, openBrowser } from './auth/callback';
import { AuthError, checkAbort, deadline, loginRequired } from './auth/errors';
import {
  discover,
  normalizeServer,
  revocationEndpoint,
  safeFetch,
  oauthFetch,
  isUnsupportedTokenRevocation,
} from './auth/network';
import { CliOAuthProvider } from './auth/provider';

export const DEFAULT_SERVER = 'https://api.orvelt.com/v1';
export { normalizeServer };
export type ConnectionOptions = {
  server: string;
  timeoutMs: number;
  signal?: AbortSignal;
  log: (message: string) => void;
};

type Context = { server: string; signal: AbortSignal; store: CredentialStore; timeoutMs: number };
function safeError(error: unknown, signal: AbortSignal): AuthError {
  // Library adapters can wrap transport failures. Only unwrap our own safe messages,
  // never stringify nested SDK data or remote response bodies.
  let nested: unknown = error;
  for (let depth = 0; depth < 8 && nested instanceof Error; depth++) {
    if (nested instanceof AuthError) return nested;
    nested = nested.cause;
  }
  if (signal.aborted)
    return new AuthError(
      'Operation cancelled or timed out. If an API operation was in progress, its outcome may be unknown; inspect current state before a manual retry.',
      'cancelled',
    );
  if (error instanceof ORPCError && error.code === 'UNAUTHORIZED') return loginRequired();
  if (error instanceof ORPCError && error.code === 'FORBIDDEN')
    return new AuthError(
      'The app lacks permission for this operation. Check the OAuth grant and your current organization permissions.',
      'forbidden',
    );
  // SDK errors can include response bodies, callback parameters and token endpoint URLs.
  return new AuthError(
    'OAuth/API request failed. The API operation outcome may be unknown; inspect current state before a manual retry. Check the server and connection, or run orvelt auth login to reconnect.',
    'network',
  );
}
async function run<T>(
  options: ConnectionOptions,
  action: (context: Context) => Promise<T>,
): Promise<T> {
  const server = normalizeServer(options.server);
  const timer = deadline(options.timeoutMs, options.signal);
  try {
    checkAbort(timer.signal);
    const store = createCredentialStore();
    return await store
      .withLock(server, timer.signal, async () => {
        const result = await action({
          server,
          signal: timer.signal,
          store,
          timeoutMs: options.timeoutMs,
        });
        // Started credential mutations must settle under the lock even when the
        // deadline expires. Do not report command success after cancellation.
        checkAbort(timer.signal);
        return result;
      })
      .catch((error: unknown) => {
        throw safeError(error, timer.signal);
      });
  } finally {
    timer.close();
  }
}
function summary(credential: Credential) {
  return {
    server: credential.server,
    issuer: credential.issuer,
    scopes: credential.scopes,
    expiresAt:
      credential.expiresAt === undefined ? null : new Date(credential.expiresAt).toISOString(),
  };
}

export async function login(
  options: ConnectionOptions & { write: boolean; browser: boolean },
): Promise<unknown> {
  return run(options, async ({ server, signal, store }) => {
    // Check storage before opening a browser; an old grant is retained if the new login fails.
    const previous = await store.read(server, signal);
    const callback = await createCallback(signal);
    try {
      const discovery = await discover(server, signal);
      const scopes: Credential['scopes'] = options.write
        ? ['business:read', 'business:write', 'offline_access']
        : ['business:read', 'offline_access'];
      // RFC 8252 permits native loopback ports to vary. Reuse a public registration only
      // with the same issuer and callback URI (apart from port), and sufficient registered
      // scopes. Registration capabilities never substitute for a new explicit consent.
      const oldRedirect = previous ? new URL(previous.redirectUri) : undefined;
      const nextRedirect = new URL(callback.redirectUri);
      if (oldRedirect) oldRedirect.port = '';
      nextRedirect.port = '';
      const registeredScopes = previous?.client.scope?.split(/\s+/) ?? previous?.scopes ?? [];
      const registeredClient =
        previous &&
        previous.issuer === discovery.authorizationServerMetadata?.issuer &&
        oldRedirect?.href === nextRedirect.href &&
        scopes.every((scope) => registeredScopes.includes(scope))
          ? previous.client
          : undefined;
      if (!registeredClient && !discovery.authorizationServerMetadata?.registration_endpoint)
        throw new AuthError(
          'OAuth server does not support public client registration.',
          'security',
        );
      const provider = new CliOAuthProvider({
        server,
        signal,
        store,
        discovery,
        redirectUri: callback.redirectUri,
        scopes,
        registeredClient,
        interactive: {
          state: callback.state,
          async redirect(url) {
            if (options.browser && (await openBrowser(url, signal))) return;
            checkAbort(signal);
            options.log(`Open this URL to authorize Orvelt CLI:\n${url.href}`);
          },
        },
      });
      await provider.authorize();
      const params = await callback.result;
      if (
        (params.has('iss') && params.get('iss') !== provider.issuer) ||
        (discovery.authorizationServerMetadata.authorization_response_iss_parameter_supported ===
          true &&
          !params.has('iss'))
      )
        throw new AuthError('OAuth callback issuer mismatch.', 'security');
      if (params.has('error'))
        throw new AuthError(
          'Authorization was denied or cancelled. Existing credentials were retained.',
        );
      const code = params.get('code');
      if (!code) throw new AuthError('Authorization code is missing.', 'security');
      await provider.exchange(params);
      if (!provider.credential) throw loginRequired();
      return {
        ...summary(provider.credential),
        stored: true,
        authorized: true,
        serverVerified: false,
      };
    } finally {
      await callback.close();
    }
  });
}

async function connected<T>(
  context: Context,
  credential: Credential,
  action: (client: BusinessApiClient) => Promise<T>,
): Promise<T> {
  const { server, signal, store } = context;
  // Discover and verify the issuer/resource before presenting any saved credential.
  const discovery = await discover(server, signal);
  const provider = new CliOAuthProvider({
    server,
    signal,
    store,
    discovery,
    credential,
    redirectUri: credential.redirectUri,
    scopes: credential.scopes,
  });
  if (credential.refreshState === 'uncertain')
    throw new AuthError(
      'The previous refresh outcome is unknown. Credentials were not reused; run orvelt auth login explicitly.',
      'auth',
    );
  const expiresAt = credential.expiresAt;
  if (expiresAt !== undefined && expiresAt <= Date.now() && !credential.tokens.refresh_token)
    throw loginRequired();
  if (
    credential.tokens.refresh_token &&
    (expiresAt === undefined || expiresAt <= Date.now() || expiresAt <= Date.now() + 30_000)
  )
    await provider.refresh();
  const rpcUrl = new URL('/rpc/v2/business', server);
  const fetchApi = safeFetch(server, signal, 'api');
  const link = new RPCLink({
    origin: rpcUrl.origin,
    url: '/rpc/v2/business',
    headers: () => {
      const token = provider.tokens()?.access_token;
      if (!token) throw loginRequired();
      return { Authorization: 'Bearer ' + token };
    },
    fetch: (url, init) => {
      const target = new URL(url);
      if (target.origin !== rpcUrl.origin || !target.pathname.startsWith(rpcUrl.pathname + '/'))
        throw new AuthError('Refusing a request outside the Business API.', 'security');
      return fetchApi(url, init);
    },
  });
  const client: BusinessApiClient = {
    async call(path, input, options) {
      const requestSignal = AbortSignal.any([
        signal,
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(options.timeoutMs),
      ]);
      return link
        .call(path, input, { context: {}, signal: requestSignal })
        .catch((error: unknown) => {
          if (error instanceof ORPCError) throw error;
          throw safeError(error, requestSignal);
        });
    },
  };
  return action(client);
}

export async function withApiClient<T>(
  options: ConnectionOptions,
  action: (client: BusinessApiClient) => Promise<T>,
): Promise<T> {
  const outcome = await run(options, async (context) => {
    const credential = await context.store.read(context.server, context.signal);
    if (!credential) throw loginRequired();
    return connected(context, credential, (client) =>
      action(client).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          checkAbort(context.signal);
          if (error instanceof AuthError || error instanceof ORPCError) throw error;
          return { ok: false as const, error };
        },
      ),
    );
  });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export async function authStatus(options: ConnectionOptions): Promise<unknown> {
  return run(options, async (context) => {
    const credential = await context.store.read(context.server, context.signal);
    if (!credential) return { server: context.server, stored: false, validity: 'not_checked' };
    // Listing is read-only and checks the live grant/membership, unlike a local JWT decode.
    const verification = await connected(context, credential, (client) =>
      client.call(
        ['oauthConnections', 'operations'],
        {},
        { timeoutMs: context.timeoutMs, signal: context.signal },
      ),
    ).then(
      () => ({ validity: 'verified', checkedAt: new Date().toISOString() }),
      (error: unknown) => {
        const safe = safeError(error, context.signal);
        if (safe.kind === 'cancelled' || safe.kind === 'storage') throw safe;
        return {
          validity:
            safe.kind === 'auth' || safe.kind === 'forbidden'
              ? 'reauthentication_required'
              : 'not_verified',
          reason: safe.message,
        };
      },
    );
    return {
      ...summary((await context.store.read(context.server, context.signal)) ?? credential),
      stored: true,
      ...verification,
    };
  });
}

export async function logout(options: ConnectionOptions & { local: boolean }): Promise<unknown> {
  return run(options, async ({ server, signal, store }) => {
    const credential = await store.read(server, signal);
    if (!credential)
      return { server, stored: false, localDeleted: false, revocation: 'not_attempted' };
    if (options.local) {
      await store.delete(server, signal);
      return {
        server,
        stored: false,
        localDeleted: true,
        revocation: 'not_attempted',
        warning: 'Local credentials deleted only. The server grant may still be active.',
      };
    }
    const discovery = await discover(server, signal);
    if (discovery.authorizationServerMetadata?.issuer !== credential.issuer)
      throw new AuthError(
        'OAuth issuer changed; refusing to send tokens for revocation. Credentials retained. Use orvelt auth logout --local only to delete locally.',
        'security',
      );
    const endpoint = revocationEndpoint(discovery);
    if (!endpoint)
      throw new AuthError(
        'Server does not advertise token revocation. Credentials retained. Use orvelt auth logout --local only to delete locally.',
      );
    const fetchFn = oauthFetch(server, signal, discovery);
    // Revoke refresh first, then access; retain local credentials if either request fails.
    let refreshRevoked = false;
    let accessTokenRevocation: 'accepted' | 'unsupported' = 'accepted';
    for (const [hint, token] of [
      ['refresh_token', credential.tokens.refresh_token],
      ['access_token', credential.tokens.access_token],
    ] as const) {
      if (!token) continue;
      let response: Response;
      try {
        response = await oauth.revocationRequest(
          discovery.authorizationServerMetadata,
          credential.client,
          oauth.None(),
          token,
          {
            additionalParameters: { token_type_hint: hint },
            [oauth.customFetch]: fetchFn,
            [oauth.allowInsecureRequests]: new URL(server).protocol === 'http:',
          },
        );
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError(
          'Token revocation failed. Credentials retained. Use orvelt auth logout --local only to delete locally.',
          'network',
        );
      }
      if (
        response.status === 400 &&
        hint === 'access_token' &&
        (await isUnsupportedTokenRevocation(response))
      ) {
        accessTokenRevocation = 'unsupported';
        continue;
      }
      if (response.status !== 200) {
        // RFC 7009 requires 200 for a successful revocation. Still let the
        // supported response processor validate protocol error responses;
        // never expose its remote description at the CLI boundary.
        await oauth.processRevocationResponse(response).catch(() => undefined);
        throw new AuthError(
          'Token revocation did not complete. Credentials retained. Use orvelt auth logout --local only to delete locally.',
        );
      }
      const protocolError = await oauth.processRevocationResponse(response);
      if (protocolError) {
        throw new AuthError(
          'Token revocation was rejected. Credentials retained. Use orvelt auth logout --local only to delete locally.',
        );
      }
      if (hint === 'refresh_token') refreshRevoked = true;
    }
    await store.delete(server, signal);
    return {
      server,
      stored: false,
      localDeleted: true,
      revocation:
        accessTokenRevocation === 'accepted' || refreshRevoked ? 'accepted' : 'not_supported',
      accessTokenRevocation,
      warning:
        accessTokenRevocation === 'unsupported'
          ? 'The server cannot revoke self-contained access JWTs. Refresh tokens, if present, were revoked; access may remain valid until token expiry. Disconnect the connection in Business Integrations for immediate grant revocation.'
          : 'The server accepted token revocation requests. This does not prove all sessions or already-issued access tokens are invalid.',
    };
  });
}
