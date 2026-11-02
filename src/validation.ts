import { z } from 'zod';
import { InputError } from './input';

const MAX_SCHEMA_BYTES = 512 * 1024;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_PATTERN_LENGTH = 4_096;

type JsonSchema = Record<string, unknown>;

function schemaError(message: string): never {
  throw new InputError(`Operation schema cannot be validated locally: ${message}`);
}

/**
 * Check the catalog document before giving it to Zod. Catalog schemas are remote data: local
 * references are useful, but resolving a URL would make validation perform an unexpected
 * network request. The bounds also keep an unusually large catalog from consuming unbounded
 * memory or compilation time.
 */
function inspectSchema(value: unknown, depth = 0, state = { nodes: 0 }): void {
  if (depth > MAX_SCHEMA_DEPTH) schemaError('schema nesting is too deep.');
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES) schemaError('schema is too large.');
  if (Array.isArray(value)) {
    for (const item of value) inspectSchema(item, depth + 1, state);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === '$ref' || key === '$dynamicRef') && typeof child === 'string') {
      if (key !== '$ref' || !child.startsWith('#/'))
        schemaError('only local JSON Pointer references are supported.');
    }
    if (key === 'pattern' && typeof child === 'string' && child.length > MAX_PATTERN_LENGTH)
      schemaError('regular-expression constraints are too large.');
    inspectSchema(child, depth + 1, state);
  }
}

/** Remove JSON Schema defaults: validation must not add fields to the caller's input. */
const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const schemaChildren = new Set([
  'items',
  'prefixItems',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'allOf',
  'anyOf',
  'oneOf',
]);

function withoutDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDefaults);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'default')
      .map(([key, child]) => [
        key,
        schemaMaps.has(key) && child && typeof child === 'object' && !Array.isArray(child)
          ? Object.fromEntries(
              Object.entries(child).map(([name, schema]) => [name, withoutDefaults(schema)]),
            )
          : schemaChildren.has(key)
            ? withoutDefaults(child)
            : child,
      ]),
  );
}

function pathText(path: PropertyKey[]): string {
  if (path.length === 0) return '<input>';
  return path
    .map((part, index) =>
      typeof part === 'number' ? `[${part}]` : index === 0 ? String(part) : `.${String(part)}`,
    )
    .join('');
}

function issueConstraint(issue: {
  code: string;
  expected?: unknown;
  format?: string;
  keys?: string[];
}): string {
  if (issue.code === 'invalid_type' && typeof issue.expected === 'string')
    return `type:${issue.expected}`;
  if (issue.code === 'invalid_format' && typeof issue.format === 'string')
    return `format:${issue.format}`;
  if (issue.code === 'unrecognized_keys' && issue.keys?.length)
    return `unrecognized_keys:${issue.keys.join('|')}`;
  return issue.code;
}

/**
 * Validate an operation input against the live catalog's JSON Schema.
 *
 * This deliberately returns the original object. Zod's JSON-Schema adapter normally applies
 * defaults and may transform object output; neither is appropriate for a CLI preview/call.
 * The API remains authoritative for transforms, MIME rules, and domain limits not present in
 * the catalog schema.
 */
export function validateOperationInput(
  input: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new InputError('Operation input must be a JSON object.');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    schemaError('the catalog schema is not an object.');

  let schemaBytes: number;
  try {
    schemaBytes = Buffer.byteLength(JSON.stringify(schema));
  } catch {
    schemaError('the catalog schema is not valid JSON.');
  }
  if (schemaBytes > MAX_SCHEMA_BYTES) schemaError('schema is too large.');
  inspectSchema(schema);

  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(withoutDefaults(schema) as JsonSchema);
  } catch {
    // Do not silently skip a keyword Zod cannot represent. The parent can choose Ajv 2020 if
    // the live catalog grows beyond Zod's supported JSON Schema subset.
    schemaError('the schema uses an unsupported JSON Schema feature.');
  }

  const result = validator.safeParse(input);
  if (!result.success) {
    const constraints = result.error.issues.map((issue) => {
      const path =
        issue.code === 'unrecognized_keys' && issue.keys?.length
          ? issue.keys.map((key) => pathText([...issue.path, key])).join('|')
          : pathText(issue.path);
      return `${path}:${issueConstraint(issue)}`;
    });
    throw new InputError(`Invalid operation input (${constraints.join(', ')}).`);
  }
  return input;
}
