import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function environment() {
  const directory = await mkdtemp(join(tmpdir(), 'orvelt-cli-process-'));
  directories.push(directory);
  return {
    ...process.env,
    ORVELT_CREDENTIAL_STORE: 'file',
    ORVELT_CONFIG_DIR: directory,
    ORVELT_API_URL: 'http://127.0.0.1:1/v1',
  };
}

function spawn(args: string[], env: Record<string, string | undefined>) {
  return Bun.spawn([process.execPath, executable, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function output(child: ReturnType<typeof spawn>) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe('executable process boundary', () => {
  test('machine failures stay JSON even when parsing fails before a rendering flag', async () => {
    const env = await environment();
    for (const args of [
      ['tools', 'list', '--unknown', '--json'],
      ['--timeout', 'bad', '--json', 'tools', 'list'],
    ]) {
      const result = await output(spawn(args, env));
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { exitCode: 2, type: 'validation_error', code: 'CLI_VALIDATION' },
      });
      expect(await readdir(env.ORVELT_CONFIG_DIR)).toEqual([]);
    }
  });

  test('scoped usage preserves required argument documentation without accepting unknown flags', async () => {
    const env = await environment();
    const scoped = await output(spawn(['call', '--usage'], env));
    expect(scoped.exitCode).toBe(0);
    expect(JSON.parse(scoped.stdout)).toMatchObject({
      command: 'orvelt call',
      arguments: [{ name: 'name', required: true }],
    });
    const invalid = await output(spawn(['call', '--usage', '--unknown', '--json'], env));
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe('');
  });

  test('an explicit catalog produces an exact offline RPC preview, never execution authority', async () => {
    const env = { ...(await environment()), ORVELT_CREDENTIAL_STORE: 'invalid' };
    const catalog = join(env.ORVELT_CONFIG_DIR, 'catalog.json');
    await Bun.write(
      catalog,
      JSON.stringify([
        {
          name: 'projects_create',
          path: ['projects', 'create'],
          access: 'write',
          inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string' } },
            required: ['slug'],
            additionalProperties: false,
          },
        },
      ]),
    );
    const preview = await output(
      spawn(
        [
          'call',
          'projects_create',
          '--catalog',
          `@${catalog}`,
          '--set',
          'slug="demo"',
          '--dry-run',
        ],
        env,
      ),
    );
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      executed: false,
      authorization: 'not_checked',
      catalogSource: 'file',
      validation: 'catalog_schema',
      request: {
        method: 'POST',
        url: 'http://127.0.0.1:1/rpc/v2/business/projects/create',
        body: { json: { slug: 'demo' } },
      },
    });
    const invalid = await output(
      spawn(
        [
          'call',
          'projects_create',
          '--catalog',
          `@${catalog}`,
          '--set',
          'slug=3',
          '--dry-run',
          '--json',
        ],
        env,
      ),
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe('');
    const execute = await output(
      spawn(
        ['call', 'projects_create', '--catalog', `@${catalog}`, '--set', 'slug="demo"', '--json'],
        env,
      ),
    );
    expect(execute.exitCode).toBe(2);
    expect(JSON.parse(execute.stderr).error.message).toContain('preview-only');
  });

  test('file previews summarize bytes instead of leaking base64 contents', async () => {
    const env = { ...(await environment()), ORVELT_CREDENTIAL_STORE: 'invalid' };
    const catalog = join(env.ORVELT_CONFIG_DIR, 'catalog.json');
    await Bun.write(
      catalog,
      JSON.stringify([
        {
          name: 'project_upload',
          path: ['project', 'upload'],
          access: 'write',
          inputSchema: {
            type: 'object',
            properties: {
              file: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  mimeType: { type: 'string' },
                  base64: { type: 'string' },
                },
              },
            },
          },
        },
      ]),
    );
    const result = await output(
      spawn(
        [
          'call',
          'project_upload',
          '--catalog',
          `@${catalog}`,
          '--dry-run',
          '--input',
          '{"file":{"name":"private.txt","mimeType":"text/plain","base64":"c2Vuc2l0aXZlLWZpbGU="}}',
        ],
        env,
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('c2Vuc2l0aXZlLWZpbGU=');
    expect(result.stdout).not.toContain('sensitive-file');
    expect(JSON.parse(result.stdout)).toMatchObject({
      input: { file: { base64: '<bytes:14>' } },
      request: { body: { files: [expect.objectContaining({ name: 'private.txt', size: 14 })] } },
    });
  });

  test('help works even when credential-store configuration is invalid', async () => {
    const env = await environment();
    const result = await output(spawn(['--help'], { ...env, ORVELT_CREDENTIAL_STORE: 'invalid' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('orvelt auth login');
    expect(result.stderr).toBe('');
    expect(await readdir(env.ORVELT_CONFIG_DIR)).toEqual([]);
  });

  test('machine-readable usage stays offline even with invalid storage settings', async () => {
    const env = await environment();
    const result = await output(
      spawn(['--usage'], {
        ...env,
        ORVELT_CREDENTIAL_STORE: 'invalid',
        ORVELT_API_URL: 'https://PRIVATE_ENV_VALUE.example.test/v1',
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, command: 'orvelt' });
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('PRIVATE_ENV_VALUE');
    expect(await readdir(env.ORVELT_CONFIG_DIR)).toEqual([]);
  });

  test('dry-run does not bypass authentication', async () => {
    const env = await environment();
    const result = await output(spawn(['call', 'projects_list', '--dry-run', '--json'], env));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.message).toContain('orvelt auth login');
  });

  test('missing credentials fail noninteractively with a valid login command', async () => {
    const env = await environment();
    const result = await output(spawn(['call', 'projects_list', '--json'], env));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.message).toContain('orvelt auth login');
    expect(await readdir(env.ORVELT_CONFIG_DIR)).toEqual([]);
  });

  test('invalid JSON input returns usage exit code before opening storage', async () => {
    const env = await environment();
    const result = await output(
      spawn(['call', 'projects_list', '--input', 'private-invalid-json', '--json'], env),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.exitCode).toBe(2);
    expect(result.stderr).not.toContain('private-invalid-json');
    expect(await readdir(env.ORVELT_CONFIG_DIR)).toEqual([]);
  });

  test('SIGINT cancels a pending login and releases the cross-process credential lock', async () => {
    const env = await environment();
    const received = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        received.resolve();
        return new Promise<Response>(() => {});
      },
    });
    const child = spawn(['auth', 'login', '--no-browser', '--json'], {
      ...env,
      ORVELT_API_URL: `http://127.0.0.1:${server.port}/v1`,
    });
    try {
      await received.promise;
      child.kill('SIGINT');
      const result = await output(child);
      expect(result.exitCode).toBe(130);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).error.message).toBe('Command cancelled.');
      expect(await readdir(env.ORVELT_CONFIG_DIR)).toEqual([]);
    } finally {
      child.kill();
      await server.stop(true);
    }
  });
});
