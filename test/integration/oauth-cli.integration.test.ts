import { afterEach, describe, expect, test } from 'bun:test';
import { createOAuthAuthority } from '../support/oauth-authority';
import { createCredentialStore } from '../../src/credentials';

const fixtures: Array<Awaited<ReturnType<typeof createOAuthAuthority>>> = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((authority) => authority.close()));
});

async function fixture() {
  const authority = await createOAuthAuthority();
  fixtures.push(authority);
  const executable =
    process.env.ORVELT_CLI_TEST_EXECUTABLE ??
    new URL('../../dist/index.js', import.meta.url).pathname;
  const runtime = process.env.ORVELT_CLI_TEST_RUNTIME ?? process.execPath;
  async function command(args: string[]) {
    const child = Bun.spawn(
      [runtime, executable, '--server', authority.resource, '--json', ...args],
      {
        env: {
          ...Bun.env,
          ORVELT_CREDENTIAL_STORE: 'file',
          ORVELT_CONFIG_DIR: authority.directory,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const tasks: Promise<{ error?: unknown }>[] = [];
    const diagnostics = (async () => {
      let text = '';
      let opened = false;
      for await (const chunk of child.stderr) {
        text += Buffer.from(chunk).toString('utf8');
        const link = text.match(/https?:\/\/[^\s]+/);
        if (!opened && link && args.includes('login')) {
          opened = true;
          tasks.push(
            authority.consent(new URL(link[0])).then(
              () => ({}),
              (error: unknown) => {
                child.kill();
                return { error };
              },
            ),
          );
        }
      }
      return text;
    })();
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        diagnostics,
      ]);
      for (const task of await Promise.all(tasks)) if (task.error) throw task.error;
      return {
        exitCode,
        stdout,
        stderr,
        value: stdout ? (JSON.parse(stdout) as unknown) : undefined,
      };
    } finally {
      child.kill();
    }
  }
  return { ...authority, command };
}

describe('built CLI with official Better Auth OAuth provider', () => {
  test('bundled jq filters real RPC results and rejects invalid filters before a mutation', async () => {
    const f = await fixture();
    f.state.write = true;
    expect(
      (await f.command(['auth', 'login', '--write', '--no-browser', '--login-timeout', '10']))
        .exitCode,
    ).toBe(0);
    const selected = await f.command([
      'call',
      'projects_list',
      '--jq',
      '.projects[] | .organizationId',
    ]);
    expect(selected.exitCode).toBe(0);
    expect(selected.value).toBe(f.orgA);
    const invalid = await f.command([
      'call',
      'project_update',
      '--input',
      JSON.stringify({ organizationId: f.orgA }),
      '--jq',
      '.items | [',
    ]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe('');
    expect(f.state.writes).toEqual([]);
    const malformedInput = await f.command([
      'call',
      'project_update',
      '--set',
      'organizationId=42',
    ]);
    expect(malformedInput.exitCode).toBe(2);
    expect(malformedInput.stdout).toBe('');
    expect(f.state.writes).toEqual([]);
  });

  test('schema and dry-run honor the live grant; typed overrides submit only on an explicit call', async () => {
    const f = await fixture();
    expect(
      (await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10'])).exitCode,
    ).toBe(0);
    expect((await f.command(['call', 'projects_list', '--schema'])).value).toEqual({
      type: 'object',
    });
    expect((await f.command(['call', 'project_update', '--dry-run'])).exitCode).toBe(1);
    expect(f.state.writes).toEqual([]);

    f.state.write = true;
    expect(
      (await f.command(['auth', 'login', '--write', '--no-browser', '--login-timeout', '10']))
        .exitCode,
    ).toBe(0);
    const assignment = `organizationId=${JSON.stringify(f.orgA)}`;
    const preview = await f.command(['call', 'project_update', '--set', assignment, '--dry-run']);
    expect(preview.exitCode).toBe(0);
    expect(preview.value).toMatchObject({
      dryRun: true,
      executed: false,
      server: f.resource,
      operation: { name: 'project_update', access: 'write' },
      input: { organizationId: f.orgA },
    });
    expect(f.state.writes).toEqual([]);
    expect((await f.command(['call', 'project_update', '--set', assignment])).value).toMatchObject({
      updated: true,
    });
    expect(f.state.writes).toEqual([f.orgA]);

    await f.disconnect();
    expect(
      (await f.command(['call', 'project_update', '--set', assignment, '--dry-run'])).exitCode,
    ).toBe(1);
    expect((await f.command(['call', 'project_update', '--schema'])).exitCode).toBe(1);
    expect(f.state.writes).toEqual([f.orgA]);
  });

  test('read-only login uses the signed organization picker/consent and cannot call a write', async () => {
    const f = await fixture();
    const login = await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10']);
    expect(login.exitCode).toBe(0);
    expect(login.value).toMatchObject({ scopes: ['business:read', 'offline_access'] });
    expect(f.state.selected).toEqual([f.orgA]);
    const listed = await f.command(['tools', 'list']);
    expect(listed.exitCode).toBe(0);
    expect(listed.value).toEqual([expect.objectContaining({ name: 'projects_list' })]);
    const details = await f.command(['tools', 'describe', 'projects_list']);
    expect(details.value).toMatchObject({
      name: 'projects_list',
      inputSchema: { type: 'object' },
    });
    const read = await f.command(['call', 'projects_list']);
    expect(read.value).toMatchObject({ projects: [{ organizationId: f.orgA }] });
    const write = await f.command([
      'call',
      'project_update',
      '--input',
      JSON.stringify({ organizationId: f.orgA }),
    ]);
    expect(write.exitCode).toBe(1);
    expect(write.stdout).toBe('');
    expect(f.state.writes).toEqual([]);
  });

  test('explicit write grant stays organization-bound; selecting another organization replaces the local grant', async () => {
    const f = await fixture();
    f.state.write = true;
    expect(
      (await f.command(['auth', 'login', '--write', '--no-browser', '--login-timeout', '10']))
        .exitCode,
    ).toBe(0);
    expect(
      (
        await f.command([
          'call',
          'project_update',
          '--input',
          JSON.stringify({ organizationId: f.orgB }),
        ])
      ).exitCode,
    ).toBe(1);
    expect(f.state.writes).toEqual([]);
    expect(
      (
        await f.command([
          'call',
          'project_update',
          '--input',
          JSON.stringify({ organizationId: f.orgA }),
        ])
      ).value,
    ).toMatchObject({ updated: true });
    f.state.organizationId = f.orgB;
    f.state.write = false;
    expect(
      (await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10'])).exitCode,
    ).toBe(0);
    expect((await f.command(['call', 'projects_list'])).value).toMatchObject({
      projects: [{ organizationId: f.orgB }],
    });
    expect(
      (
        await f.command([
          'call',
          'project_update',
          '--input',
          JSON.stringify({ organizationId: f.orgA }),
        ])
      ).exitCode,
    ).toBe(1);
    expect(f.state.writes).toEqual([f.orgA]);
  });

  test('denied consent preserves existing credentials; declined offline access remains usable; disconnect is enforced live', async () => {
    const f = await fixture();
    f.state.offline = false;
    expect(
      (await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10'])).value,
    ).toMatchObject({ scopes: ['business:read'] });
    f.state.accept = false;
    expect(
      (await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10'])).exitCode,
    ).toBe(1);
    expect((await f.command(['auth', 'status'])).value).toMatchObject({ validity: 'verified' });
    await f.disconnect();
    expect((await f.command(['call', 'projects_list'])).exitCode).toBe(1);
    expect((await f.command(['auth', 'status'])).value).toMatchObject({
      stored: true,
      validity: 'reauthentication_required',
    });
  });

  test('failed remote logout retains credentials; successful revocation removes local credentials', async () => {
    const f = await fixture();
    expect(
      (await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10'])).exitCode,
    ).toBe(0);
    f.state.failRevocation = true;
    expect((await f.command(['auth', 'logout'])).exitCode).toBe(1);
    expect((await f.command(['auth', 'status'])).value).toMatchObject({
      stored: true,
      validity: 'verified',
    });
    f.state.failRevocation = false;
    const logout = await f.command(['auth', 'logout']);
    expect(logout.exitCode, JSON.stringify(f.state.revocations) + logout.stderr).toBe(0);
    expect(logout.value).toMatchObject({
      stored: false,
      localDeleted: true,
      revocation: 'accepted',
    });
    expect(logout.value).toMatchObject({ accessTokenRevocation: 'unsupported' });
    expect((await f.command(['auth', 'status'])).value).toMatchObject({ stored: false });
    expect((await f.command(['call', 'projects_list'])).exitCode).toBe(1);
  });

  test('real refresh tokens rotate once across concurrent executable processes', async () => {
    const f = await fixture();
    expect(
      (await f.command(['auth', 'login', '--no-browser', '--login-timeout', '10'])).exitCode,
    ).toBe(0);
    const store = createCredentialStore({
      env: { ORVELT_CREDENTIAL_STORE: 'file', ORVELT_CONFIG_DIR: f.directory },
    });
    const saved = await store.read(f.resource);
    if (!saved?.tokens.refresh_token) throw new Error('Expected a fixture refresh token.');
    await store.write(f.resource, { ...saved, expiresAt: Date.now() - 1 });
    const tokenRequests = f.state.tokenRequests;
    const results = await Promise.all([1, 2, 3].map(() => f.command(['call', 'projects_list'])));
    for (const result of results) {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.value).toMatchObject({ projects: [{ organizationId: f.orgA }] });
    }
    expect(f.state.tokenRequests - tokenRequests).toBe(1);
    expect((await store.read(f.resource))?.tokens.refresh_token).not.toBe(
      saved.tokens.refresh_token,
    );
  });

  test('declining requested write scope wins over --write; an expired no-offline grant cannot refresh', async () => {
    const f = await fixture();
    f.state.offline = false;
    // The CLI asks for write but the person approves only read on the signed consent page.
    const login = await f.command([
      'auth',
      'login',
      '--write',
      '--no-browser',
      '--login-timeout',
      '10',
    ]);
    expect(login.value).toMatchObject({ scopes: ['business:read'] });
    const listed = await f.command(['tools', 'list']);
    expect(listed.value).toEqual([expect.objectContaining({ name: 'projects_list' })]);
    const store = createCredentialStore({
      env: { ORVELT_CREDENTIAL_STORE: 'file', ORVELT_CONFIG_DIR: f.directory },
    });
    const saved = await store.read(f.resource);
    if (!saved) throw new Error('Expected fixture credentials.');
    expect(saved.tokens.refresh_token).toBeUndefined();
    await store.write(f.resource, { ...saved, expiresAt: Date.now() - 1 });
    const before = f.state.tokenRequests;
    expect((await f.command(['call', 'projects_list'])).exitCode).toBe(1);
    expect((await f.command(['auth', 'status'])).value).toMatchObject({
      validity: 'reauthentication_required',
    });
    expect(f.state.tokenRequests).toBe(before);
    expect(f.state.writes).toEqual([]);
  });
});
