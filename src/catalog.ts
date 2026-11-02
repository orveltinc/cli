import { z } from 'zod';
import { InputError, readJsonInput } from './input';
import { operationSchema, type Operation } from './operations';

/** Explicit snapshots are documentation/preview data, never authorization for execution. */
export async function readCatalog(source: string, signal?: AbortSignal): Promise<Operation[]> {
  if (!source.startsWith('@') || source === '@-' || source.length === 1)
    throw new InputError('--catalog requires @file.json from tools list --json.');
  const value = await readJsonInput(source, { signal });
  const parsed = z.array(operationSchema).max(1000).safeParse(value);
  if (
    !parsed.success ||
    new Set(parsed.data.map((operation) => operation.name)).size !== parsed.data.length
  )
    throw new InputError('The catalog must contain an operation array with unique names.');
  return parsed.data;
}

export function catalogOperation(operations: Operation[], name: string) {
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) throw new InputError('The operation is absent from this catalog snapshot.');
  return operation;
}
