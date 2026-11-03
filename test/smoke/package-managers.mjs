/**
 * Installed-package boundary: missing runtime dependencies, Bun-only globals,
 * broken executable/worker paths, and stdin regressions must fail outside the
 * workspace. Only package installation uses the registry; CLI traffic is trapped
 * by a loopback server and credentials always live in a disposable directory.
 *
 * Run with Node: node packages/business-cli/test/smoke/package-managers.mjs
 * ORVELT_SMOKE_MANAGERS=npm,pnpm,yarn-classic,yarn-modern,yarn-modern-node-modules,bun
 *   (default: all; yarn-modern uses Yarn's default PnP linker)
 * ORVELT_SMOKE_NODE_BINARIES=/absolute/node20,/absolute/node22,/absolute/node24
 *   (default: the current Node executable; empty runs only Bun lanes)
 * ORVELT_SMOKE_BUN_BINARY=/absolute/bun (default: bun from PATH)
 * ORVELT_SMOKE_BUN_BINARIES=/absolute/bun1,/absolute/bun2 (consumer runtimes)
 * ORVELT_SMOKE_BUN_INSTALL_BINARY=/absolute/bun (Bun installer; default: build Bun)
 * ORVELT_SMOKE_TEMP_DIR=/absolute/temp (default: the OS temporary directory)
 * ORVELT_SMOKE_KEEP=1 retains the isolated installations for diagnosis.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));
assert.ok(
  !process.versions.bun,
  'Run this harness with Node; Bun is exercised as a child runtime.',
);
const versions = {
  npm: '11.19.1',
  pnpm: '10.32.0',
  'yarn-classic': '1.22.22',
  'yarn-modern': '4.9.2',
  'yarn-modern-node-modules': '4.9.2',
};
const selected = (
  process.env.ORVELT_SMOKE_MANAGERS ??
  'npm,pnpm,yarn-classic,yarn-modern,yarn-modern-node-modules,bun'
).split(',');
for (const manager of selected)
  assert.ok(manager === 'bun' || manager in versions, `Unknown manager: ${manager}`);
const root = await mkdtemp(
  join(process.env.ORVELT_SMOKE_TEMP_DIR ?? tmpdir(), 'orvelt-cli-installed-'),
);
console.log(`Isolated package test: ${root}`);

async function executable(name) {
  if (name.includes('/')) return realpath(name);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, name);
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return realpath(candidate);
  }
  throw new Error(`Required executable is unavailable: ${name}`);
}

async function command(
  binary,
  args,
  { cwd = root, env = process.env, input = '', exitCode = 0, timeout = 180_000 } = {},
) {
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  // A parser may reject the command before it reads stdin.
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const status = await new Promise((resolveStatus, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolveStatus({ code, signal }));
  }).finally(() => clearTimeout(timer));
  assert.equal(
    status.code,
    exitCode,
    `${binary} ${args.join(' ')}\nExpected exit ${exitCode}; got ${status.code} (${status.signal ?? 'no signal'})\n${stdout}\n${stderr}`,
  );
  return { stdout, stderr };
}

let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  response.writeHead(503).end('Smoke tests must not use the network.');
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  // Resolve toolchain shims while the host environment is still available;
  // isolated child PATH/HOME must not need proto (or another runtime manager).
  const bunCommand = await executable(process.env.ORVELT_SMOKE_BUN_BINARY ?? 'bun');
  const bun = (await command(bunCommand, ['-p', 'process.execPath'])).stdout.trim();
  const bunInstaller = process.env.ORVELT_SMOKE_BUN_INSTALL_BINARY
    ? await executable(process.env.ORVELT_SMOKE_BUN_INSTALL_BINARY)
    : bun;
  const bunRuntimes = await Promise.all(
    (process.env.ORVELT_SMOKE_BUN_BINARIES ?? bun).split(',').map(executable),
  );
  const nodes = await Promise.all(
    (process.env.ORVELT_SMOKE_NODE_BINARIES ?? process.execPath)
      .split(',')
      .filter(Boolean)
      .map(executable),
  );
  const hostNode = process.execPath;
  const npm = await executable('npm');
  const tooling = join(root, 'tooling');
  await mkdir(tooling);
  await writeFile(join(tooling, 'package.json'), JSON.stringify({ private: true }));
  const tools = [];
  if (selected.includes('npm')) tools.push(`npm@${versions.npm}`);
  if (selected.includes('pnpm')) tools.push(`pnpm@${versions.pnpm}`);
  if (selected.includes('yarn-classic')) tools.push(`yarn@${versions['yarn-classic']}`);
  if (selected.some((manager) => manager.startsWith('yarn-modern')))
    tools.push(`@yarnpkg/cli-dist@${versions['yarn-modern']}`);
  if (tools.length)
    await command(hostNode, [
      npm,
      'install',
      '--prefix',
      tooling,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...tools,
    ]);
  const toolPaths = {
    npm: join(tooling, 'node_modules/npm/bin/npm-cli.js'),
    pnpm: join(tooling, 'node_modules/pnpm/bin/pnpm.cjs'),
    'yarn-classic': join(tooling, 'node_modules/yarn/bin/yarn.js'),
    'yarn-modern': join(tooling, 'node_modules/@yarnpkg/cli-dist/bin/yarn.js'),
    'yarn-modern-node-modules': join(tooling, 'node_modules/@yarnpkg/cli-dist/bin/yarn.js'),
  };

  // Exactly one build and tarball are shared by every clean consumer install.
  await command(bun, ['run', 'build'], { cwd: packageDirectory });
  const packed = await command(
    hostNode,
    [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root],
    { cwd: packageDirectory },
  );
  const tarball = join(root, JSON.parse(packed.stdout)[0].filename);
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
  const catalog = join(root, 'catalog.json');
  await writeFile(
    catalog,
    JSON.stringify([
      {
        name: 'projects_create',
        path: ['projects', 'create'],
        access: 'write',
        inputSchema: {
          type: 'object',
          properties: { slug: { type: 'string' }, count: { type: 'integer' } },
          required: ['slug', 'count'],
          additionalProperties: false,
        },
      },
    ]),
  );

  const runtimes = [];
  for (const node of nodes)
    runtimes.push({
      name: `Node ${(await command(node, ['--version'])).stdout.trim()}`,
      binary: node,
      bun: false,
    });
  for (const binary of bunRuntimes)
    runtimes.push({
      name: `Bun ${(await command(binary, ['--version'])).stdout.trim()}`,
      binary,
      bun: true,
    });
  let lanes = 0;
  for (const manager of selected) {
    const consumer = join(root, manager);
    await mkdir(consumer);
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ private: true, dependencies: { '@orvelt/cli': `file:${tarball}` } }),
    );
    const pnp = manager === 'yarn-modern';
    // Test Yarn's default linker, as well as the explicit node-modules option.
    if (manager.startsWith('yarn-modern'))
      await writeFile(
        join(consumer, '.yarnrc.yml'),
        `${pnp ? '' : 'nodeLinker: node-modules\n'}enableGlobalCache: false\n`,
      );
    const managerVersion =
      manager === 'bun'
        ? (await command(bunInstaller, ['--version'])).stdout.trim()
        : (await command(hostNode, [toolPaths[manager], '--version'])).stdout.trim();
    console.log(`Install ${manager} ${managerVersion}`);
    const installArgs = {
      npm: ['install', '--no-audit', '--no-fund'],
      pnpm: ['install', '--ignore-workspace', '--reporter=append-only'],
      'yarn-classic': ['install', '--non-interactive', '--no-progress'],
      'yarn-modern': ['install'],
      'yarn-modern-node-modules': ['install'],
      bun: ['install'],
    };
    await command(
      manager === 'bun' ? bunInstaller : hostNode,
      manager === 'bun' ? installArgs[manager] : [toolPaths[manager], ...installArgs[manager]],
      {
        cwd: consumer,
        env: {
          ...process.env,
          COREPACK_ENABLE_PROJECT_SPEC: '0',
          YARN_ENABLE_IMMUTABLE_INSTALLS: 'false',
        },
      },
    );
    const installedBin = join(consumer, 'node_modules/.bin/orvelt');
    const installedEntry = pnp
      ? (
          await command(hostNode, [toolPaths[manager], 'bin', 'orvelt'], { cwd: consumer })
        ).stdout.trim()
      : join(consumer, 'node_modules/@orvelt/cli/dist/index.js');
    assert.ok(
      !(pnp ? installedEntry : await realpath(installedEntry)).startsWith(packageDirectory),
      'Consumer must not resolve into the monorepo',
    );

    for (const [index, runtime] of runtimes.entries()) {
      // PnP is a Node loader protocol. Bun consumers are covered with Bun's own
      // installation and every node-modules manager; do not mislabel a Node
      // subprocess launched by `yarn exec` as a Bun runtime test.
      if (pnp && runtime.bun) continue;
      const lane = join(consumer, `runtime-${index}`);
      const bin = join(lane, 'bin');
      const credentials = join(lane, 'credentials');
      await mkdir(bin, { recursive: true });
      await mkdir(credentials, { mode: 0o700 });
      await symlink(runtime.binary, join(bin, runtime.bun ? 'bun' : 'node'));
      // Exclude user directories and runtime-manager shims; each lane gets
      // exactly one runtime, including Bun-only lanes without Node.
      const env = {
        PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
        HOME: lane,
        XDG_CONFIG_HOME: lane,
        ORVELT_API_URL: `${origin}/v1`,
        ORVELT_AGENT_MODE: 'false',
        ORVELT_CREDENTIAL_STORE: 'invalid',
        ORVELT_CONFIG_DIR: credentials,
        NO_COLOR: '1',
      };
      // Fail rather than silently exercising the other host runtime through a
      // shebang or worker subprocess. Both runtimes exist on the developer PATH.
      await command('/usr/bin/env', [runtime.bun ? 'node' : 'bun', '--version'], {
        cwd: consumer,
        env,
        exitCode: 127,
      });
      const invoke = (args, options = {}) =>
        command(
          pnp ? runtime.binary : runtime.bun ? runtime.binary : installedBin,
          pnp
            ? [toolPaths[manager], 'exec', 'orvelt', ...args]
            : runtime.bun
              ? [installedEntry, ...args]
              : args,
          {
            cwd: consumer,
            env,
            timeout: 30_000,
            ...options,
          },
        );
      assert.equal((await invoke(['--version'])).stdout.trim(), manifest.version);
      // pnpm creates a shell shim, not a JavaScript executable. Bun's named
      // runner handles that shim; keep the behavioral tests on the installed
      // JS entry so Bun cannot mask a dependency on Node with its runner shim.
      if (runtime.bun)
        assert.equal(
          (
            await command(runtime.binary, ['run', '--bun', 'orvelt', '--version'], {
              cwd: consumer,
              env,
            })
          ).stdout.trim(),
          manifest.version,
        );
      const usage = JSON.parse((await invoke(['call', '--usage'])).stdout);
      assert.equal(usage.command, 'orvelt call');
      const args = [
        'call',
        'projects_create',
        '--catalog',
        `@${catalog}`,
        '--input',
        '-',
        '--set',
        'count=7',
        '--dry-run',
      ];
      const input = '{"slug":"installed-consumer","count":2}';
      const preview = JSON.parse((await invoke(args, { input })).stdout);
      assert.equal(preview.executed, false);
      assert.equal(preview.catalogSource, 'file');
      assert.equal(preview.authorization, 'not_checked');
      assert.deepEqual(preview.input, { slug: 'installed-consumer', count: 7 });
      assert.equal(preview.request.method, 'POST');
      assert.equal(preview.request.url, `${origin}/rpc/v2/business/projects/create`);
      assert.deepEqual(preview.request.body, { json: { slug: 'installed-consumer', count: 7 } });
      const filtered = await invoke(
        [...args, '--jq', '[.input.slug, (.input.count | tostring)] | join(":")', '--raw-output'],
        { input },
      );
      assert.equal(
        filtered.stdout,
        'installed-consumer:7\n',
        'The installed sibling jq worker must compile and execute real jq',
      );
      for (const invalid of [
        ['tools', 'list', '--unknown', '--json'],
        ['--timeout', 'bad', '--json', 'tools', 'list'],
        [...args, '--jq', '.items | [', '--json'],
      ]) {
        const failure = await invoke(invalid, { input, exitCode: 2 });
        assert.equal(failure.stdout, '');
        const error = JSON.parse(failure.stderr).error;
        assert.equal(error.exitCode, 2);
        assert.equal(error.code, 'CLI_VALIDATION');
      }
      const malformed = await invoke([...args, '--json'], { input: '{', exitCode: 2 });
      assert.equal(malformed.stdout, '');
      assert.equal(JSON.parse(malformed.stderr).error.code, 'CLI_VALIDATION');
      const denied = await invoke(
        ['call', 'projects_create', '--catalog', `@${catalog}`, '--json'],
        { exitCode: 2 },
      );
      assert.match(JSON.parse(denied.stderr).error.message, /preview-only/);
      assert.deepEqual(
        await readdir(credentials),
        [],
        'Offline paths must not touch credential storage',
      );
      // The empty file-backed status also exercises portable credential loading
      // without opening the real OS keychain or attempting OAuth discovery.
      const status = await invoke(['auth', 'status', '--json'], {
        env: { ...env, ORVELT_CREDENTIAL_STORE: 'file' },
      });
      assert.deepEqual(JSON.parse(status.stdout), {
        server: `${origin}/v1`,
        stored: false,
        validity: 'not_checked',
      });
      assert.equal(requests, 0, 'Offline commands must never contact even the loopback API');
      lanes += 1;
      console.log(`PASS ${manager} ${managerVersion} / ${runtime.name}`);
    }
  }
  if (selected.includes('yarn-modern'))
    console.log(
      'Yarn default PnP uses Node via yarn exec; Bun runtime is covered by node-modules installs.',
    );
  console.log(`PASS ${lanes} installed-package lanes; one tarball; zero API requests.`);
} finally {
  await new Promise((closed) => server.close(closed));
  if (process.env.ORVELT_SMOKE_KEEP !== '1') await rm(root, { recursive: true, force: true });
}
