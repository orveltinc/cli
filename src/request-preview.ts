import { RPCLink } from '@orpc/client/fetch';
import { normalizeServer } from './auth/network';

export type RequestPreview = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

const safePathSegment = /^[A-Za-z][A-Za-z0-9]*$/;

function validatePath(path: string[]) {
  if (path.length === 0 || path.some((segment) => !safePathSegment.test(segment))) {
    throw new Error('Invalid RPC path. Path segments must be non-empty identifiers.');
  }
}

function headersRecord(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

async function describeBody(request: Request): Promise<unknown> {
  if (!request.body) return null;
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const files: Array<{ field: string; name: string; mimeType: string; size: number }> = [];
    let data: unknown;
    for (const [field, value] of form.entries()) {
      if (field === 'data' && typeof value === 'string') {
        data = JSON.parse(value);
      } else if (typeof value !== 'string') {
        const file = value as File;
        files.push({
          field,
          name: file.name,
          mimeType: file.type,
          size: file.size,
        });
      }
    }
    return { data, files };
  }
  return JSON.parse(await request.text());
}

/** Serialize an RPC call without credentials, network access, or a live API. */
export async function previewRequest(
  path: string[],
  input: Record<string, unknown>,
  server: string,
  signal?: AbortSignal,
): Promise<RequestPreview> {
  validatePath(path);
  const normalized = normalizeServer(server);
  const rpcUrl = new URL('/rpc/v2/business', normalized);
  let captured: Request | undefined;
  const link = new RPCLink({
    origin: rpcUrl.origin,
    url: '/rpc/v2/business',
    headers: { Authorization: 'Bearer [redacted]' },
    fetch: async (request: string | URL | Request, init?: RequestInit) => {
      const candidate = new Request(request, init);
      const target = new URL(candidate.url);
      if (target.origin !== rpcUrl.origin || !target.pathname.startsWith(`${rpcUrl.pathname}/`)) {
        throw new Error('Refusing an RPC request outside the Business API.');
      }
      if (candidate.signal.aborted || init?.signal?.aborted) {
        throw new DOMException('The request was aborted.', 'AbortError');
      }
      captured = candidate.clone();
      // RPCLink only needs a successful RPC envelope to finish serialization.
      return new Response(JSON.stringify({ json: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await link.call(path, input, { context: {}, ...(signal ? { signal } : {}) });
  if (!captured) throw new Error('RPC request was not captured.');
  return {
    method: captured.method,
    url: captured.url,
    headers: headersRecord(captured.headers),
    body: await describeBody(captured),
  };
}
