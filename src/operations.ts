import { z } from 'zod';
import { ORPCError } from '@orpc/client';
import { validateOperationInput } from './validation';
import { previewRequest } from './request-preview';

export const operationSchema = z.object({
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  path: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/)).min(1),
  access: z.enum(['read', 'write']),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type Operation = z.infer<typeof operationSchema>;
export type OperationOptions = { timeoutMs: number; signal?: AbortSignal };
export type BusinessApiClient = {
  call: (path: string[], input: unknown, options: OperationOptions) => Promise<unknown>;
};
export class OperationError extends Error {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly result?: unknown,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}
function check(options: OperationOptions) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new OperationError(
      'Operation timeout must be a positive, finite number of milliseconds.',
    );
  options.signal?.throwIfAborted();
}
export async function listOperations(
  client: BusinessApiClient,
  options: OperationOptions,
): Promise<Operation[]> {
  check(options);
  const result = z
    .object({ operations: z.array(operationSchema).max(1000) })
    .safeParse(await client.call(['oauthConnections', 'operations'], {}, options));
  if (!result.success) throw new OperationError('The API returned an invalid operation catalog.');
  if (new Set(result.data.operations.map((op) => op.name)).size !== result.data.operations.length)
    throw new OperationError('The API returned duplicate operation names.');
  return result.data.operations.toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
export async function describeOperation(
  client: BusinessApiClient,
  name: string,
  options: OperationOptions,
) {
  const operation = (await listOperations(client, options)).find((item) => item.name === name);
  if (!operation)
    throw new OperationError(
      'Operation ' +
        JSON.stringify(name) +
        ' is not available. Use an exact operation name from tools list. Check your organization, project permissions, and OAuth resource access; request business:write with auth login --write only when needed.',
    );
  return operation;
}
export function decodeOperationFiles(operation: Operation, input: Record<string, unknown>) {
  const properties = operation.inputSchema.properties;
  if (!properties || typeof properties !== 'object') return input;
  const result = { ...input };
  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== 'object' || !('properties' in value)) continue;
    const shape = value.properties;
    if (!shape || typeof shape !== 'object' || !('base64' in shape) || !('mimeType' in shape))
      continue;
    if (input[key] === undefined) continue;
    const file = z
      .object({ name: z.string().min(1), mimeType: z.string().min(1), base64: z.base64() })
      .safeParse(input[key]);
    if (!file.success)
      throw new OperationError('File arguments need name, mimeType, and base64 content.');
    result[key] = new File([Buffer.from(file.data.base64, 'base64')], file.data.name, {
      type: file.data.mimeType,
    });
  }
  return result;
}

export async function previewOperation(
  client: BusinessApiClient,
  name: string,
  input: Record<string, unknown>,
  options: OperationOptions & { server?: string },
) {
  const operation = await describeOperation(client, name, options);
  return previewCatalogOperation(operation, input, options);
}

export async function previewCatalogOperation(
  operation: Operation,
  input: Record<string, unknown>,
  options: OperationOptions & { server?: string },
) {
  check(options);
  // Check file envelopes just as a real call would, without sending an operation request.
  validateOperationInput(input, operation.inputSchema);
  const decoded = decodeOperationFiles(operation, input);
  const request = options.server
    ? await previewRequest(operation.path, decoded, options.server, options.signal)
    : undefined;
  return {
    dryRun: true,
    executed: false,
    operation: { name: operation.name, path: operation.path, access: operation.access },
    input,
    validation: 'catalog_schema' as const,
    ...(request ? { request } : {}),
  };
}

export async function callOperation(
  client: BusinessApiClient,
  name: string,
  input: Record<string, unknown>,
  options: OperationOptions,
) {
  const operation = await describeOperation(client, name, options);
  check(options);
  // Discovery is guidance, not authority; the API independently checks this exact operation.
  // No retry layer: a lost response never causes a mutation to be sent twice.
  validateOperationInput(input, operation.inputSchema);
  return client
    .call(operation.path, decodeOperationFiles(operation, input), options)
    .catch((error: unknown) => {
      if (error instanceof ORPCError && !['UNAUTHORIZED', 'FORBIDDEN'].includes(error.code))
        throw new OperationError(
          'Operation ' + JSON.stringify(name) + ' failed. Check the result before retrying.',
          { code: error.code, message: error.message, data: error.data },
        );
      throw error;
    });
}
