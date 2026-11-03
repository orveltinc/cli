import { readFile } from 'node:fs/promises';
import { z } from 'zod';

// src/ and dist/ sit beside the manifest, including in the packed npm artifact.
const manifest: unknown = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
export const version = z.object({ version: z.string().min(1) }).parse(manifest).version;
