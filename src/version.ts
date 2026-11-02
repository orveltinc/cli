import { z } from 'zod';

// src/ and dist/ sit beside the manifest, including in the packed npm artifact.
const manifest: unknown = await Bun.file(new URL('../package.json', import.meta.url)).json();
export const version = z.object({ version: z.string().min(1) }).parse(manifest).version;
