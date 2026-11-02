import { describe, expect, test } from 'bun:test';
import type { BusinessApiClient, Operation } from '../../src/operations';
import { runCli, terminalText, type CliDependencies } from '../../src/cli';

const tool: Operation = {
  path: ['projects', 'list'],
  access: 'read',
  name: 'projects_list',
  description: 'List projects',
  inputSchema: { type: 'object', properties: {} },
};

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ method: string; options: unknown }> = [];
  const dependencies: CliDependencies = {
    normalizeServer: async (server) => server,
    login: async (options) => {
      calls.push({ method: 'login', options });
      return { authenticated: true };
    },
    logout: async (options) => {
      calls.push({ method: 'logout', options });
      return { loggedOut: true };
    },
    authStatus: async (options) => {
      calls.push({ method: 'status', options });
      return { authenticated: false };
    },
    withApiClient: async (options, action) => {
      calls.push({ method: 'connect', options });
      return action({} as BusinessApiClient);
    },
    listOperations: async () => [tool],
    describeOperation: async () => tool,
    callOperation: async (_client, name, input) => {
      calls.push({ method: 'call', options: { name, input } });
      return { items: [] };
    },
    previewOperation: async (_client, name, input) => {
      calls.push({ method: 'preview', options: { name, input } });
      return {
        dryRun: true,
        executed: false,
        operation: { name, path: tool.path, access: tool.access },
        input,
        validation: 'catalog_schema',
      };
    },
    readInput: async () => ({}),
    ...overrides,
  };
  return {
    stdout,
    stderr,
    calls,
    run: (argv: string[], signal?: AbortSignal) =>
      runCli(argv, {
        dependencies,
        io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text), signal },
      }),
  };
}

describe('CLI command contract', () => {
  test.each([[], ['--help'], ['auth', 'login', '--help'], ['--version']].map((argv) => ({ argv })))(
    'help/version stay offline: %j',
    async ({ argv }) => {
      const h = harness();
      expect(await h.run(argv)).toBe(0);
      expect(h.stdout.join('')).not.toBe('');
      expect(h.stderr).toEqual([]);
      expect(h.calls).toEqual([]);
    },
  );

  test('login defaults read-only and passes browser choice, endpoint, and login timeout', async () => {
    const h = harness();
    expect(
      await h.run([
        'auth',
        'login',
        '--no-browser',
        '--login-timeout',
        '80',
        '--server',
        'http://127.0.0.1:8080/mcp',
        '--json',
      ]),
    ).toBe(0);
    expect(h.calls[0]).toMatchObject({
      method: 'login',
      options: {
        write: false,
        browser: false,
        timeoutMs: 80_000,
        server: 'http://127.0.0.1:8080/mcp',
      },
    });
    expect(JSON.parse(h.stdout.join(''))).toEqual({ authenticated: true });
  });

  test('write authorization requires the explicit login flag', async () => {
    const h = harness();
    expect(await h.run(['auth', 'login', '--write'])).toBe(0);
    expect(h.calls[0]).toMatchObject({ options: { write: true } });
  });

  test.each(['0', '-1', '1.5', 'Infinity', '601', '2oops'])(
    'rejects invalid timeout %s before connecting',
    async (value) => {
      const h = harness();
      expect(await h.run(['tools', 'list', '--timeout', value])).toBe(2);
      expect(h.calls).toEqual([]);
      expect(h.stdout).toEqual([]);
    },
  );

  test.each(
    [['wat'], ['call'], ['tools', 'list', '--unknown'], ['auth', 'status', 'extra']].map(
      (args) => ({ args }),
    ),
  )('strict arguments: %j', async ({ args }) => {
    const h = harness();
    expect(await h.run(args)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.stderr.join('')).toContain('error:');
  });

  test('filters discovery and keeps JSON output machine-readable', async () => {
    const h = harness();
    expect(await h.run(['tools', 'list', '--search', 'PROJECTS', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout.join(''))).toEqual([tool]);
    expect(h.stderr).toEqual([]);
  });

  test('empty filtered JSON results are an array', async () => {
    const h = harness();
    expect(await h.run(['tools', 'list', '--search', 'no-such-operation', '--json'])).toBe(0);
    expect(JSON.parse(h.stdout.join(''))).toEqual([]);
  });

  test('calls once with exact operation name and parsed input', async () => {
    const input = { projectId: 'project-1', count: 3 };
    const h = harness({ readInput: async () => input });
    expect(
      await h.run([
        'call',
        'project_questions_list',
        '--input',
        '@request.json',
        '--timeout',
        '55',
      ]),
    ).toBe(0);
    expect(h.calls).toEqual([
      { method: 'connect', options: expect.objectContaining({ timeoutMs: 55_000 }) },
      { method: 'call', options: { name: 'project_questions_list', input } },
    ]);
    expect(JSON.parse(h.stdout.join(''))).toEqual({ items: [] });
  });

  test.each(
    [[], ['auth'], ['auth', 'login'], ['tools'], ['tools', 'describe'], ['call']].map((path) => ({
      path,
    })),
  )('--usage stays offline and skips required arguments: %j', async ({ path }) => {
    const h = harness({
      readInput: async () => {
        throw new Error('Must not read input');
      },
    });
    expect(await h.run([...path, '--usage'])).toBe(0);
    const usage = JSON.parse(h.stdout.join(''));
    expect(usage.schemaVersion).toBe(1);
    expect(usage.command).toBe(['orvelt', ...path].join(' '));
    expect(usage.options).toContainEqual(expect.objectContaining({ flags: '--server <url>' }));
    expect(usage.options).toContainEqual(expect.objectContaining({ flags: '--usage' }));
    expect(usage.exitCodes).toEqual({ success: 0, failure: 1, usage: 2, cancelled: 130 });
    expect(h.calls).toEqual([]);
    expect(h.stderr).toEqual([]);
  });

  test('usage follows the real command tree and includes inherited options and defaults', async () => {
    const h = harness();
    expect(await h.run(['--usage'])).toBe(0);
    const usage = JSON.parse(h.stdout.join(''));
    const call = usage.commands.find(
      (command: { command: string }) => command.command === 'orvelt call',
    );
    expect(call.arguments).toEqual([expect.objectContaining({ name: 'name', required: true })]);
    expect(call.options).toContainEqual(expect.objectContaining({ flags: '--dry-run' }));
    expect(call.options).toContainEqual(
      expect.objectContaining({ flags: '--timeout <seconds>', default: 30 }),
    );
  });

  test('schema prints only the live schema and never reads input or executes', async () => {
    const h = harness({
      readInput: async () => {
        throw new Error('Must not read input');
      },
    });
    expect(await h.run(['call', tool.name, '--schema'])).toBe(0);
    expect(JSON.parse(h.stdout.join(''))).toEqual(tool.inputSchema);
    expect(h.calls.map((call) => call.method)).toEqual(['connect']);
  });

  test.each([['--input', '{}'], ['--set', 'limit=5'], ['--dry-run']].map((flags) => ({ flags })))(
    'schema rejects conflicting request options: %j',
    async ({ flags }) => {
      const h = harness();
      expect(await h.run(['call', tool.name, '--schema', ...flags])).toBe(2);
      expect(h.calls).toEqual([]);
    },
  );

  test('dry-run previews but never calls an operation; redacts secrets in the preview', async () => {
    const h = harness({
      readInput: async () => ({
        name: 'Preview',
        password: 'PRIVATE',
        nested: { refresh_token: 'PRIVATE', apiKey: 'PRIVATE', 'x-api-key': 'PRIVATE' },
      }),
    });
    expect(await h.run(['call', tool.name, '--dry-run'])).toBe(0);
    expect(JSON.parse(h.stdout.join(''))).toMatchObject({
      dryRun: true,
      executed: false,
      operation: { name: tool.name },
      input: { name: 'Preview', password: '[redacted]' },
    });
    expect(h.stdout.join('')).not.toContain('PRIVATE');
    expect(h.calls.map((call) => call.method)).toEqual(['connect', 'preview']);
  });

  test('JSON overrides merge on top of explicit input, with repeated --set supported', async () => {
    const h = harness({ readInput: async () => ({ limit: 1, cursor: 'keep' }) });
    expect(
      await h.run([
        'call',
        tool.name,
        '--set',
        'limit=5',
        'enabled=true',
        '--set',
        'tags=["a"]',
        'name="A=B"',
      ]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      method: 'call',
      options: { input: { limit: 5, cursor: 'keep', enabled: true, tags: ['a'], name: 'A=B' } },
    });
  });

  test('invalid overrides fail before reading credentials or contacting the server', async () => {
    const h = harness();
    expect(await h.run(['call', tool.name, '--set', 'name=PRIVATE_INVALID', '--json'])).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.stdout).toEqual([]);
    expect(h.stderr.join('')).not.toContain('PRIVATE_INVALID');
  });

  test('invalid input fails before credentials or network access', async () => {
    const h = harness({
      readInput: async () => {
        throw new Error('Invalid input');
      },
    });
    expect(await h.run(['call', 'projects_list', '--input', 'bad'])).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.stdout).toEqual([]);
  });

  test('operation failures produce no success payload and redact credentials', async () => {
    const h = harness({
      callOperation: async () => {
        throw new Error(
          'Failed: access_token=private-token&state=private-state Bearer private-bearer',
        );
      },
    });
    expect(await h.run(['call', 'projects_list', '--json'])).toBe(1);
    expect(h.stdout).toEqual([]);
    const output = h.stderr.join('');
    expect(output).not.toContain('private-');
    expect(JSON.parse(output)).toMatchObject({ error: { exitCode: 1 } });
  });

  test('logout forwards explicit local-only behavior', async () => {
    const h = harness();
    expect(await h.run(['auth', 'logout', '--local'])).toBe(0);
    expect(h.calls[0]).toMatchObject({ method: 'logout', options: { local: true } });
  });

  test('tool failure details remain available on stderr for automation', async () => {
    const result = { code: 'FORBIDDEN', message: 'Project access is required.' };
    const h = harness({
      callOperation: async () => {
        throw Object.assign(new Error('Operation failed.'), { exitCode: 1, result });
      },
    });
    expect(await h.run(['call', 'projects_list', '--json'])).toBe(1);
    expect(h.stdout).toEqual([]);
    expect(JSON.parse(h.stderr.join(''))).toMatchObject({ error: { result } });
  });

  test.each([true, false])(
    'nested tool-error diagnostics redact credentials and controls (json=%s)',
    async (json) => {
      const h = harness({
        callOperation: async () => {
          throw Object.assign(new Error('Operation failed.'), {
            result: {
              code: 'FORBIDDEN',
              content: [
                {
                  text: '\x1b]0;hijacked\x07\x1b[31mBearer PRIVATE_BEARER\x1b[0m access_token=PRIVATE_ACCESS',
                },
              ],
              nested: {
                refresh_token: 'PRIVATE_REFRESH',
                authorization: 'Bearer PRIVATE_AUTH',
                client_secret: 'PRIVATE_CLIENT',
              },
            },
          });
        },
      });
      expect(await h.run(['call', 'projects_list', ...(json ? ['--json'] : [])])).toBe(1);
      const stderr = h.stderr.join('');
      expect(h.stdout).toEqual([]);
      expect(stderr).toContain('FORBIDDEN');
      expect(stderr).toContain('[redacted]');
      expect(stderr).not.toContain('PRIVATE_');
      expect(stderr).not.toContain('hijacked');
      expect(stderr).not.toContain('\\u001b');
      expect(stderr).not.toContain('\x1b');
    },
  );

  test('cancellation produces exit code 130', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({
      authStatus: async () => {
        controller.signal.throwIfAborted();
      },
    });
    expect(await h.run(['auth', 'status'], controller.signal)).toBe(130);
    expect(h.stderr.join('')).toContain('cancelled');
  });

  test('human output strips remote terminal control codes', async () => {
    const h = harness({
      listOperations: async () => [{ ...tool, title: '\x1b[31mRed\x1b[0m\n\x1b]0;hijacked\x07' }],
    });
    expect(await h.run(['tools', 'list'])).toBe(0);
    expect(h.stdout.join('')).not.toContain('\x1b');
    expect(h.stdout.join('')).not.toContain('hijacked');
    expect(terminalText('a\r\nb')).toBe('a  b');
  });
});
