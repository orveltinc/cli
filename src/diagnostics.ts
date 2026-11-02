import { stripVTControlCharacters } from 'node:util';

const MAX_DEPTH = 32;
const MAX_NODES = 2_000;
const MAX_ENTRIES = 256;
const MAX_STRING = 4_096;
// Leave room for JSON punctuation when callers render the returned value.
const MAX_RENDERED = 60 * 1024;
const TRUNCATED = '[truncated]';
const REDACTED = '[redacted]';

/** Strip terminal control sequences and replace remaining control characters. */
export function terminalText(value: string): string {
  return Array.from(stripVTControlCharacters(value), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('');
}

// Delimiters are intentionally omitted from this spelling so that api-key,
// api_key, APIKey, and api key have one security policy.
function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const sensitiveKeys = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'token',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'password',
  'privatekey',
  'proxyauth',
  'proxyauthorization',
  'authorization',
  'cookie',
  'setcookie',
  'xauthtoken',
  'oauthsecret',
  'oauthtoken',
  'codeverifier',
  'state',
  'nonce',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return sensitiveKeys.has(normalized);
}

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return false;
  // Buffer.from is permissive; round-tripping prevents ordinary text from being
  // mislabeled as binary data.
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function bytePlaceholder(value: string): string {
  return `<bytes:${Buffer.byteLength(value, 'base64')}>`;
}

function truncateString(value: string): string {
  const clean = redactText(value, false);
  return clean.length > MAX_STRING
    ? `${clean.slice(0, MAX_STRING - TRUNCATED.length)}${TRUNCATED}`
    : clean;
}

/** Redact credentials in free-form diagnostic text, including URLs and assignments. */
export function diagnosticText(message: string): string {
  return redactText(message, true);
}

function redactText(message: string, limit: boolean): string {
  let result = terminalText(message).replace(
    /Bearer\s+(?:\[redacted\]|[^\s,;}\]]+)/gi,
    `Bearer ${REDACTED}`,
  );

  // Query values are handled separately because they are not assignments in the
  // usual diagnostic syntax and may contain URL-encoded punctuation.
  result = result.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (all, prefix, key) => {
    let decoded = key as string;
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the raw key; malformed input must still be safe to print.
    }
    return isSensitiveKey(decoded) || normalizedKey(decoded) === 'code'
      ? `${prefix}${key}=${REDACTED}`
      : all;
  });

  // Covers JSON-ish and log-style `access_token=value` / `"api-key": "value"`.
  result = result.replace(
    /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|api[_-]?key|x[_-]?api[_-]?key|password|private[_-]?key|proxy[_-]?authorization|authorization|cookie|set[_-]?cookie|x[_-]?auth[_-]?token|code[_-]?verifier|state|nonce))["']?(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\[redacted\]|[^\s"'&,}\]]+)/gi,
    (_all, key, separator) => `${key}${separator}${REDACTED}`,
  );
  return limit && result.length > MAX_STRING
    ? `${result.slice(0, MAX_STRING - TRUNCATED.length)}${TRUNCATED}`
    : result;
}

type Context = {
  depth: number;
  nodes: number;
  remaining: number;
  seen: WeakSet<object>;
};

function charge(context: Context, value: string): boolean {
  const cost = Buffer.byteLength(value) + 2;
  if (cost > context.remaining) return false;
  context.remaining -= cost;
  return true;
}

function fileEnvelope(value: Record<string, unknown>): Record<string, string> | undefined {
  if (
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string' ||
    typeof value.base64 !== 'string' ||
    !isBase64(value.base64)
  )
    return undefined;
  return {
    name: terminalText(value.name).slice(0, MAX_STRING),
    mimeType: terminalText(value.mimeType).slice(0, MAX_STRING),
    base64: bytePlaceholder(value.base64),
  };
}

function walk(value: unknown, context: Context): unknown {
  if (++context.nodes > MAX_NODES || context.depth > MAX_DEPTH) return TRUNCATED;
  if (value === undefined) return '[undefined]';
  if (typeof value === 'bigint') return `[bigint:${value.toString().slice(0, 64)}]`;
  if (typeof value === 'symbol' || typeof value === 'function') return '[unserializable]';
  if (typeof value === 'string') {
    const result = truncateString(value);
    return charge(context, result) ? result : TRUNCATED;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return '[unserializable]';
  if (context.seen.has(value)) return '[circular]';
  context.seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const limit = Math.min(value.length, MAX_ENTRIES);
    for (let index = 0; index < limit; index++) {
      context.depth++;
      result.push(walk(value[index], context));
      context.depth--;
    }
    if (value.length > limit || context.nodes >= MAX_NODES) result.push(TRUNCATED);
    return result;
  }

  const record = value as Record<string, unknown>;
  const file = fileEnvelope(record);
  if (file) return walk(file, context);

  const result: Record<string, unknown> = Object.create(null);
  const entries = Object.entries(record);
  const limit = Math.min(entries.length, MAX_ENTRIES);
  for (let index = 0; index < limit; index++) {
    const entry = entries[index];
    if (!entry) break;
    const [key, item] = entry;
    const safeKey = terminalText(key).slice(0, MAX_STRING);
    if (!charge(context, safeKey)) {
      result[TRUNCATED] = TRUNCATED;
      break;
    }
    if (isSensitiveKey(key)) {
      result[safeKey] = REDACTED;
      charge(context, REDACTED);
    } else if (
      typeof item === 'string' &&
      ['base64', 'binary', 'blob'].includes(normalizedKey(key)) &&
      item.length >= 8 &&
      isBase64(item)
    ) {
      result[safeKey] = bytePlaceholder(item);
      charge(context, String(result[safeKey]));
    } else {
      context.depth++;
      result[safeKey] = walk(item, context);
      context.depth--;
    }
  }
  if (entries.length > limit || context.nodes >= MAX_NODES) result[TRUNCATED] = TRUNCATED;
  return result;
}

/** Return a bounded, JSON-serializable diagnostic copy without exposing secrets. */
export function diagnosticResult(value: unknown): unknown {
  const result = walk(value, { depth: 0, nodes: 0, remaining: MAX_RENDERED, seen: new WeakSet() });
  return Buffer.byteLength(JSON.stringify(result, null, 2)) <= 64 * 1024 ? result : TRUNCATED;
}
