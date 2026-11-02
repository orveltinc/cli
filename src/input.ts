import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';

export const MAX_INPUT_BYTES = 1024 * 1024;
const inputSchema = z.record(z.string(), z.unknown());

export class InputError extends Error {
  readonly exitCode = 2;
}

/** Top-level JSON assignments keep native booleans, numbers, arrays, objects, and null. */
export function mergeInput(input: Record<string, unknown>, assignments: string[] = []) {
  if (
    assignments.reduce((size, assignment) => size + Buffer.byteLength(assignment), 0) >
    MAX_INPUT_BYTES
  )
    throw new InputError('Input must not exceed 1 MiB.');
  const overrides = assignments.map((assignment) => {
    const separator = assignment.indexOf('=');
    if (separator < 1) throw new InputError('Use --set field=JSON. Quote string values as JSON.');
    const field = assignment.slice(0, separator);
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field) || field === 'constructor' || field === 'prototype')
      throw new InputError('--set accepts a top-level field name, not a property path.');
    const parsed = z.json().safeParse(
      // Do not include assignment values in diagnostics: they can contain private data.
      (() => {
        try {
          return JSON.parse(assignment.slice(separator + 1)) as unknown;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new InputError('Each --set value must be valid JSON. Quote string values as JSON.');
        }
      })(),
    );
    if (!parsed.success) throw new InputError('Each --set value must be valid JSON.');
    return [field, parsed.data] as const;
  });
  const result = { ...input, ...Object.fromEntries(overrides) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT_BYTES)
    throw new InputError('Input must not exceed 1 MiB.');
  return result;
}

async function readBounded(stream: Readable, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const abort = () => stream.destroy(new InputError('Input reading was cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_INPUT_BYTES) throw new InputError('Input must not exceed 1 MiB.');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** Read bounded JSON; @- and - explicitly read stdin. */
export async function readJsonInput(
  source: string | undefined,
  options: { stdin?: Readable; signal?: AbortSignal } = {},
): Promise<unknown> {
  if (source === undefined) return {};
  let text: string;
  if (source === '-' || source === '@-') {
    const stdin = options.stdin ?? process.stdin;
    if ('isTTY' in stdin && stdin.isTTY) {
      throw new InputError('Pipe JSON into stdin when using --input -.');
    }
    text = await readBounded(stdin, options.signal);
  } else if (source.startsWith('@')) {
    if (source.length === 1) throw new InputError('Specify a file after @.');
    // Open nonblocking so a FIFO cannot hold the CLI indefinitely before fstat.
    const { constants } = await import('node:fs');
    const file = await open(source.slice(1), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new InputError('Input must be a regular file.');
      if (stat.size > MAX_INPUT_BYTES) throw new InputError('Input must not exceed 1 MiB.');
      text = await readBounded(file.createReadStream({ autoClose: false }), options.signal);
    } finally {
      await file.close();
    }
  } else {
    text = source;
  }
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES) {
    throw new InputError('Input must not exceed 1 MiB.');
  }
  // Do not echo payloads in validation errors: arguments may contain private data.
  const value = await Promise.resolve()
    .then(() => JSON.parse(text) as unknown)
    .catch(() => {
      throw new InputError('Input must be valid JSON. Use --input @file.json or --input -.');
    });
  return value;
}

/** Accept one JSON object, inline, from @file, or explicitly from stdin. */
export async function readInput(
  source: string | undefined,
  options: { stdin?: Readable; signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  const parsed = inputSchema.safeParse(await readJsonInput(source, options));
  if (!parsed.success) throw new InputError('Input must be a JSON object.');
  return parsed.data;
}
