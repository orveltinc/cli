import * as oauth from 'oauth4webapi';
import { z } from 'zod';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type OAuthDiscoveryState = {
  authorizationServerUrl: string;
  resourceMetadata: { resource: string; authorization_servers: string[] };
  authorizationServerMetadata: oauth.AuthorizationServer;
};
import { AuthError, checkAbort } from './errors';

const loopback = (url: URL) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
const MAX_RESPONSE_BYTES = 1024 * 1024;

function boundedResponse(response: Response): Response {
  const length = response.headers.get('Content-Length');
  if (length && /^(?:0|[1-9]\d*)$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel();
    throw new AuthError('OAuth server response exceeded the permitted size.', 'security');
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let size = 0;
  const release = () => {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already have released this reader.
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          release();
          return;
        }
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          const error = new AuthError(
            'OAuth server response exceeded the permitted size.',
            'security',
          );
          try {
            await reader.cancel();
          } catch {
            // Preserve the size error if the origin refuses cancellation.
          } finally {
            release();
          }
          controller.error(error);
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Cancellation is best effort and must not mask the caller's error.
      } finally {
        release();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d{1,5}$/.test(value)) {
    const seconds = Number(value);
    return seconds <= 86_400 ? seconds : undefined;
  }
  if (
    !/^(?:[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]+, \d{2}-[A-Z][a-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Z][a-z]{2} [A-Z][a-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4})$/.test(
      value,
    )
  )
    return undefined;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  const seconds = Math.ceil((date - Date.now()) / 1000);
  return seconds >= 0 && seconds <= 86_400 ? seconds : undefined;
}
function retryAfter(response: Response): number | undefined {
  return (
    parseRetryAfter(response.headers.get('Retry-After')) ??
    parseRetryAfter(response.headers.get('X-Retry-After'))
  );
}
export function endpoint(value: string | URL, allowHttp: boolean): URL {
  const url = URL.parse(String(value));
  if (
    !url ||
    url.username ||
    url.password ||
    String(value).includes('#') ||
    (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && loopback(url)))
  ) {
    throw new AuthError(
      'Endpoints must use HTTPS without credentials or fragments; explicit HTTP loopback servers are allowed for local development.',
      'security',
    );
  }
  return url;
}
export function normalizeServer(value: string): string {
  const url = endpoint(value.trim(), true);
  if (url.search)
    throw new AuthError('The API resource URL must not contain a query string.', 'security');
  return url.href;
}

/** No redirects, cookies, URL userinfo, or implicit downgrade, even on same-origin requests. */
export function safeFetch(
  server: string,
  signal: AbortSignal,
  purpose: 'discovery' | 'oauth' | 'revocation' | 'api',
  allowed?: Set<string>,
): FetchLike {
  const allowHttp = new URL(server).protocol === 'http:';
  return async (input, init) => {
    checkAbort(signal);
    const url = endpoint(input instanceof Request ? input.url : String(input), allowHttp);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (allowed && !allowed.has(url.href))
      throw new AuthError('Refusing a request outside the authorized endpoint.', 'security');
    if (purpose === 'discovery' && method !== 'GET')
      throw new AuthError('Invalid discovery request.', 'security');
    // API calls are never automatically replayed, even after authentication failures.
    const signals = [
      signal,
      init?.signal,
      input instanceof Request ? input.signal : undefined,
    ].filter((item): item is AbortSignal => item != null);
    const response = await fetch(input, {
      ...init,
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.any(signals),
    }).catch(() => {
      checkAbort(signal);
      throw new AuthError(
        purpose === 'api'
          ? 'Unable to contact the Business API. The operation outcome may be unknown; inspect current state before a manual retry.'
          : 'Unable to contact the OAuth/API server. Check connectivity and try again.',
        'network',
      );
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new AuthError(
        'Server redirects are not allowed. Use the canonical --server URL.',
        'security',
      );
    }
    if (purpose === 'api' && response.status === 401) {
      await response.body?.cancel();
      throw new AuthError(
        'Authorization was rejected during the operation. The request was not replayed. Inspect the current state before retrying, then run orvelt auth login if needed.',
        'auth',
      );
    }
    if (purpose === 'api' && response.status === 403) {
      await response.body?.cancel();
      throw new AuthError(
        'This app lacks permission for the operation. Check your OAuth resource access and organization permissions.',
      );
    }
    if (response.status === 429 && purpose !== 'oauth') {
      const seconds = retryAfter(response);
      await response.body?.cancel();
      throw new AuthError(
        `Server rate limit reached.${seconds === undefined ? ' Try again later.' : ` Wait ${seconds} seconds before trying again.`} No request was automatically retried.`,
        'network',
      );
    }
    const isCatalog = purpose === 'api' && url.pathname.endsWith('/oauthConnections/operations');
    return purpose === 'discovery' || purpose === 'oauth' || isCatalog
      ? boundedResponse(response)
      : response;
  };
}

/** Require RFC 9728 and validated issuer metadata; never guess token endpoints. */
export async function discover(server: string, signal: AbortSignal): Promise<OAuthDiscoveryState> {
  const fetchFn = safeFetch(server, signal, 'discovery');
  const resourceUrl = new URL(server);
  const metadataUrl = new URL(
    '/.well-known/oauth-protected-resource' + resourceUrl.pathname.replace(/\/$/, ''),
    resourceUrl,
  );
  const resourceResponse = await fetchFn(metadataUrl);
  if (!resourceResponse.ok) throw new AuthError('OAuth resource discovery failed.', 'network');
  const resource = z
    .object({
      resource: z.string().url(),
      authorization_servers: z.array(z.string().url()).min(1),
    })
    .parse(await resourceResponse.json());
  const issuer = resource.authorization_servers?.[0];
  if (resource.resource !== server || !issuer) {
    throw new AuthError('OAuth metadata does not match the exact API resource.', 'security');
  }
  const allowHttp = new URL(server).protocol === 'http:';
  if (endpoint(issuer, allowHttp).search)
    throw new AuthError('OAuth issuer identifiers must not contain a query string.', 'security');
  const issuerUrl = new URL(issuer);
  const metadata = await oauth.processDiscoveryResponse(
    issuerUrl,
    await oauth.discoveryRequest(issuerUrl, {
      algorithm: 'oauth2',
      [oauth.customFetch]: fetchFn,
      [oauth.allowInsecureRequests]: allowHttp,
    }),
  );
  if (!metadata || metadata.issuer !== issuer)
    throw new AuthError('OAuth issuer metadata is missing or mismatched.', 'security');
  for (const value of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    revocationEndpoint({ authorizationServerUrl: issuer, authorizationServerMetadata: metadata }),
  ]) {
    if (value) endpoint(value, allowHttp);
  }
  if (!metadata.token_endpoint || !metadata.authorization_endpoint)
    throw new AuthError('OAuth server does not advertise the required endpoints.', 'security');
  return {
    authorizationServerUrl: issuer,
    resourceMetadata: resource,
    authorizationServerMetadata: metadata,
  };
}

export function revocationEndpoint(
  discovery: Pick<OAuthDiscoveryState, 'authorizationServerUrl' | 'authorizationServerMetadata'>,
): string | undefined {
  const metadata = discovery.authorizationServerMetadata;
  return metadata &&
    'revocation_endpoint' in metadata &&
    typeof metadata.revocation_endpoint === 'string'
    ? metadata.revocation_endpoint
    : undefined;
}

export function oauthFetch(
  server: string,
  signal: AbortSignal,
  discovery: OAuthDiscoveryState,
): FetchLike {
  const metadata = discovery.authorizationServerMetadata;
  const urls = [
    metadata?.token_endpoint,
    metadata?.registration_endpoint,
    revocationEndpoint(discovery),
  ].filter((value): value is string => typeof value === 'string');
  return safeFetch(server, signal, 'oauth', new Set(urls.map((value) => new URL(value).href)));
}

/** Parse only the bounded RFC 7009 error code; never surface remote descriptions. */
export async function isUnsupportedTokenRevocation(response: Response): Promise<boolean> {
  if (response.status !== 400 || !response.body) return false;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) return false;
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data: unknown = await Promise.resolve()
    .then(() => JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
    .catch(() => undefined);
  return Boolean(
    data && typeof data === 'object' && 'error' in data && data.error === 'unsupported_token_type',
  );
}
