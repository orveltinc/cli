import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialStore, type Credential } from '../../src/credentials';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing required test fixture value');
  return value;
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'orvelt-credentials-'));
  directories.push(dir);
  const env = { ORVELT_CREDENTIAL_STORE: 'file', ORVELT_CONFIG_DIR: dir };
  return { dir, env, store: createCredentialStore({ env }) };
}
const server = 'https://mcp.example.test/mcp';
const issuer = 'https://auth.example.test';
function credential(): Credential {
  return {
    version: 1,
    server,
    resource: server,
    issuer,
    redirectUri: 'http://127.0.0.1:12345/oauth/callback',
    client: { client_id: 'public-cli', issuer },
    tokens: {
      access_token: 'SECRET_ACCESS',
      refresh_token: 'SECRET_REFRESH',
      token_type: 'Bearer',
      issuer,
    },
    scopes: ['business:read', 'offline_access'],
  };
}

describe('credential storage', () => {
  test('defaults to OS keychain; failures never fall back or leak backend messages', async () => {
    const values = new Map<string, string>();
    const store = createCredentialStore({
      env: {},
      keychain: {
        async get({ name }) {
          return values.get(name) ?? null;
        },
        async set({ name, value }) {
          values.set(name, value);
        },
        async delete({ name }) {
          return values.delete(name);
        },
      },
    });
    expect(store.mode).toBe('keychain');
    expect(await store.read(server)).toBeUndefined();
    await store.write(server, credential());
    expect(await store.read(server)).toEqual(credential());
    expect(await store.read('https://other.example.test/mcp')).toBeUndefined();
    await store.delete(server);
    expect(values.size).toBe(0);
    const broken = createCredentialStore({
      env: {},
      keychain: {
        async get() {
          throw new Error('SECRET_ACCESS');
        },
        async set() {
          throw new Error('SECRET_REFRESH');
        },
        async delete() {
          throw new Error('SECRET_REFRESH');
        },
      },
    });
    for (const operation of [
      () => broken.read(server),
      () => broken.write(server, credential()),
      () => broken.delete(server),
    ]) {
      const error = await operation().catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('No plaintext fallback');
      expect(String(error)).not.toContain('SECRET');
    }
  });

  test('file mode requires both explicit opt-in and config directory', () => {
    expect(() => createCredentialStore({ env: { ORVELT_CREDENTIAL_STORE: 'file' } })).toThrow(
      'ORVELT_CONFIG_DIR',
    );
    expect(() => createCredentialStore({ env: { ORVELT_CREDENTIAL_STORE: 'plaintext' } })).toThrow(
      'keychain or file',
    );
    expect(createCredentialStore({ env: { ORVELT_CONFIG_DIR: '/unused' } }).mode).toBe('keychain');
  });

  test('atomic per-resource files are 0600 in a 0700 directory, without verifier/state', async () => {
    const { dir, store } = await fixture();
    await store.write(server, credential());
    const [name] = await readdir(dir);
    expect(name).toMatch(/^[a-f0-9]{64}\.json$/);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(dir, required(name)))).mode & 0o777).toBe(0o600);
    expect(await store.read(server)).toEqual(credential());
    await store.write(server, {
      ...credential(),
      tokens: { ...credential().tokens, access_token: 'ROTATED' },
    });
    expect((await store.read(server))?.tokens.access_token).toBe('ROTATED');
    expect(await readdir(dir)).toHaveLength(1);
    const raw = await readFile(join(dir, required(name)), 'utf8');
    expect(raw).not.toContain('verifier');
    expect(raw).not.toContain('state');
    expect(await store.read('https://mcp.example.test/another')).toBeUndefined();
    await store.delete(server);
    expect(await readdir(dir)).toHaveLength(0);
  });

  test('rejects loose permissions, symlinks, corrupt files, and mismatched issuer binding', async () => {
    const { dir, store } = await fixture();
    await store.write(server, credential());
    const file = join(dir, required((await readdir(dir))[0]));
    await chmod(file, 0o644);
    await expect(store.read(server)).rejects.toThrow('Credential storage failed');
    await chmod(file, 0o600);
    await writeFile(file, '{secret: SECRET_ACCESS}');
    await expect(store.read(server)).rejects.toThrow('Credential storage failed');
    await writeFile(file, JSON.stringify({ ...credential(), issuer: 'https://evil.test' }));
    await expect(store.read(server)).rejects.toThrow('Credential storage failed');
    await rm(file);
    const other = join(dir, 'target');
    await writeFile(other, JSON.stringify(credential()), { mode: 0o600 });
    await symlink(other, file);
    await expect(store.read(server)).rejects.toThrow('Credential storage failed');
    await expect(store.write(server, credential())).rejects.toThrow('Credential storage failed');
    await chmod(dir, 0o755);
    await expect(store.read(server)).rejects.toThrow('Credential storage failed');
    await chmod(dir, 0o700);
    const alias = join(dir, 'alias');
    await symlink(dir, alias);
    await expect(
      createCredentialStore({
        env: { ORVELT_CREDENTIAL_STORE: 'file', ORVELT_CONFIG_DIR: alias },
      }).read(server),
    ).rejects.toThrow('Credential storage failed');
  });

  test('lock serializes independent store instances and cleans up on failure/cancellation', async () => {
    const { dir, store, env } = await fixture();
    const other = createCredentialStore({ env });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = store.withLock(server, AbortSignal.timeout(2000), async () => {
      entered();
      await held;
      await store.write(server, credential());
    });
    await ready;
    await expect(other.withLock(server, AbortSignal.timeout(40), async () => {})).rejects.toThrow(
      'lock wait',
    );
    let secondEntered = false;
    const second = other.withLock(server, AbortSignal.timeout(2000), async () => {
      secondEntered = true;
      expect(await other.read(server)).toEqual(credential());
    });
    await Bun.sleep(60);
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    await expect(
      store.withLock(server, AbortSignal.timeout(1000), async () => {
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');
    expect((await readdir(dir)).filter((name) => name.endsWith('.lock'))).toHaveLength(0);
  });

  test('a separate Bun process cannot enter while the parent holds the lock', async () => {
    const { store, env, dir } = await fixture();
    const marker = join(dir, 'child-entered');
    await store.withLock(server, AbortSignal.timeout(5000), async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          '-e',
          `
        import {createCredentialStore} from ${JSON.stringify(new URL('../../src/credentials.ts', import.meta.url).pathname)};
        const store = createCredentialStore();
        await store.withLock(${JSON.stringify(server)}, AbortSignal.timeout(100), async () => { await Bun.write(${JSON.stringify(marker)}, 'entered'); });
      `,
        ],
        { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await child.exited).not.toBe(0);
      expect(await Bun.file(marker).exists()).toBe(false);
      expect(await new Response(child.stderr).text()).toContain('lock wait');
    });
    expect((await readdir(dir)).filter((name) => name.endsWith('.lock'))).toHaveLength(0);
  });
});
