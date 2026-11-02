import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AuthError, checkAbort } from './auth/errors';

const tokensSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().nonnegative().optional(),
  scope: z.string().optional(),
  issuer: z.string().min(1),
});

export const credentialSchema = z
  .object({
    version: z.literal(1),
    server: z.string().url(),
    resource: z.string().url(),
    issuer: z.string().url(),
    redirectUri: z.string().url(),
    client: z.object({
      client_id: z.string().min(1),
      issuer: z.string().min(1),
      scope: z.string().optional(),
    }),
    tokens: tokensSchema,
    scopes: z.array(z.enum(['business:read', 'business:write', 'offline_access'])),
    expiresAt: z.number().nonnegative().max(8_640_000_000_000_000).optional(),
    // A marker is written before a refresh request. It remains set if the
    // request outcome is not knowable, so a later process cannot reuse the
    // possibly-spent refresh token.
    refreshState: z.literal('uncertain').optional(),
  })
  .refine(
    (value) =>
      value.server === value.resource &&
      value.issuer === value.client.issuer &&
      value.issuer === value.tokens.issuer,
  );
export type Credential = z.infer<typeof credentialSchema>;

type Keychain = Pick<typeof Bun.secrets, 'get' | 'set' | 'delete'>;
const service = 'com.orvelt.business-cli.oauth';
const storageError = () =>
  new AuthError(
    'Credential storage failed. Unlock the OS keychain, or explicitly opt into ORVELT_CREDENTIAL_STORE=file with ORVELT_CONFIG_DIR for headless use. No plaintext fallback was used.',
    'storage',
  );
function isCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
function parseCredential(text: string, server: string): Credential {
  // JSON and Zod errors may contain input; do not expose them at the CLI boundary.
  const parsed: unknown = JSON.parse(text);
  const result = credentialSchema.safeParse(parsed);
  if (!result.success || result.data.server !== server) throw storageError();
  return result.data;
}

const key = (server: string) => createHash('sha256').update(server).digest('hex');
const owned = (stat: Awaited<ReturnType<typeof lstat>>) =>
  process.getuid === undefined || stat.uid === process.getuid();
const guard = async <T>(action: () => Promise<T>): Promise<T> =>
  action().catch(() => {
    throw storageError();
  });

/** One entry per exact resource, including issuer stamps inside the entry. No state or PKCE on disk. */
export function createCredentialStore({
  env = process.env,
  keychain = Bun.secrets,
}: { env?: Record<string, string | undefined>; keychain?: Keychain } = {}) {
  const mode = env.ORVELT_CREDENTIAL_STORE ?? 'keychain';
  if (mode !== 'keychain' && mode !== 'file')
    throw new AuthError('ORVELT_CREDENTIAL_STORE must be keychain or file.', 'storage');
  if (mode === 'file' && !env.ORVELT_CONFIG_DIR)
    throw new AuthError('File storage requires an explicit ORVELT_CONFIG_DIR.', 'storage');
  // Keychain users always share a lock directory, even if their environment differs.
  const directory =
    mode === 'file' && env.ORVELT_CONFIG_DIR
      ? resolve(env.ORVELT_CONFIG_DIR)
      : join(homedir(), '.config', 'orvelt', 'credentials');
  const path = (server: string) => join(directory, `${key(server)}.json`);
  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077) !== 0)
      throw storageError();
  }
  async function readFile(server: string) {
    const handle = await open(
      path(server),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch((error: unknown) => {
      if (isCode(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (!handle) return undefined;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        !owned(stat) ||
        (stat.mode & 0o077) !== 0 ||
        stat.nlink !== 1 ||
        stat.size > 64 * 1024
      )
        throw storageError();
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  }
  async function syncDirectory() {
    const handle = await open(directory, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return {
    mode,
    async read(server: string): Promise<Credential | undefined> {
      return guard(async () => {
        const text =
          mode === 'file'
            ? (await ensureDirectory(), await readFile(server))
            : await keychain.get({ service, name: key(server) });
        return text == null ? undefined : parseCredential(text, server);
      });
    },
    async write(server: string, credential: Credential): Promise<void> {
      return guard(async () => {
        const text = JSON.stringify(credentialSchema.parse(credential));
        if (credential.server !== server || Buffer.byteLength(text) > 64 * 1024)
          throw storageError();
        if (mode === 'keychain') {
          await keychain.set({ service, name: key(server), value: text });
          return;
        }
        await ensureDirectory();
        // Refuse unsafe existing entries rather than following or repairing them.
        await readFile(server);
        const temporary = join(directory, `.${key(server)}.${randomUUID()}.tmp`);
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          try {
            await handle.writeFile(text, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, path(server));
          await syncDirectory();
        } finally {
          await unlink(temporary).catch((error: unknown) => {
            if (!isCode(error, 'ENOENT')) throw error;
          });
        }
      });
    },
    async delete(server: string): Promise<void> {
      return guard(async () => {
        if (mode === 'keychain') {
          await keychain.delete({ service, name: key(server) });
          return;
        }
        await ensureDirectory();
        await readFile(server);
        await unlink(path(server)).catch((error: unknown) => {
          if (!isCode(error, 'ENOENT')) throw error;
        });
        await syncDirectory();
      });
    },
    /**
     * mkdir is atomic across processes. Hold through read/refresh/save AND use so a waiting
     * process never rotates a stale refresh token. Never steal a lock by age: a suspended
     * process may still be alive. After a crash, remove the indicated empty lock directory
     * only after checking no CLI process is running. No credentials are written to locks.
     */
    async withLock<T>(server: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
      await guard(ensureDirectory);
      const lock = join(directory, `${key(server)}.lock`);
      let acquired = false;
      while (!acquired) {
        if (signal.aborted)
          throw new AuthError(
            `Credential lock wait cancelled or timed out. If a previous CLI process crashed, confirm it is no longer running before removing ${lock}.`,
            'cancelled',
          );
        acquired = await mkdir(lock, { mode: 0o700 }).then(
          () => true,
          (error: unknown) => {
            if (isCode(error, 'EEXIST')) return false;
            throw storageError();
          },
        );
        if (!acquired)
          await new Promise<void>((resolveWait) => {
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', done);
              resolveWait();
            };
            const timer = setTimeout(done, 50);
            signal.addEventListener('abort', done, { once: true });
            if (signal.aborted) done();
          });
      }
      try {
        checkAbort(signal);
        return await action();
      } finally {
        await rmdir(lock);
      }
    },
  };
}
export type CredentialStore = ReturnType<typeof createCredentialStore>;
