import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import type { BusinessApiClient } from './operations';
import type { ConnectionOptions } from './auth';
import type * as Operations from './operations';
import { InputError, mergeInput, readInput } from './input';
import { complete, completionScript, type CompletionShell } from './completion';
import { diagnosticResult, diagnosticText, terminalText } from './diagnostics';
import { classifyError } from './errors';
import { catalogOperation, readCatalog } from './catalog';
import { previewCatalogOperation } from './operations';
import { prepareOutput, type OutputFormat } from './output';
import { installUsage } from './usage';
import { version } from './version';

export { terminalText } from './diagnostics';

const DEFAULT_SERVER = 'https://api.orvelt.com/v1';

/** Dependencies are lazy so help/version work offline without opening credential storage. */
const defaultDependencies = {
  login: async (options: ConnectionOptions & { write: boolean; browser: boolean }) =>
    (await import('./auth')).login(options),
  logout: async (options: ConnectionOptions & { local: boolean }) =>
    (await import('./auth')).logout(options),
  authStatus: async (options: ConnectionOptions) => (await import('./auth')).authStatus(options),
  normalizeServer: async (value: string) => (await import('./auth')).normalizeServer(value),
  withApiClient: async <T>(
    options: ConnectionOptions,
    action: (client: BusinessApiClient) => Promise<T>,
  ) => (await import('./auth')).withApiClient(options, action),
  listOperations: (async (...args) =>
    (await import('./operations')).listOperations(...args)) as typeof Operations.listOperations,
  describeOperation: (async (...args) =>
    (await import('./operations')).describeOperation(
      ...args,
    )) as typeof Operations.describeOperation,
  callOperation: (async (...args) =>
    (await import('./operations')).callOperation(...args)) as typeof Operations.callOperation,
  previewOperation: (async (...args) =>
    (await import('./operations')).previewOperation(...args)) as typeof Operations.previewOperation,
  readInput,
};

export type CliDependencies = typeof defaultDependencies;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
}

const defaultIO: CliIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

function timeout(value: string) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 600) {
    throw new InvalidArgumentError('Timeout must be an integer from 1 to 600 seconds.');
  }
  return Number(value);
}

function agentDefault() {
  const override = process.env.ORVELT_AGENT_MODE;
  if (override !== undefined) return override === '1' || override === 'true';
  return [
    'CLAUDECODE',
    'CURSOR_AGENT',
    'CODEX',
    'AIDER',
    'CLINE',
    'WINDSURF_AGENT',
    'GITHUB_COPILOT',
    'AMAZON_Q',
    'GEMINI_CODE_ASSIST',
    'SRC_CODY',
  ].some((name) => {
    const value = process.env[name];
    return value !== undefined && value !== '' && value !== '0' && value !== 'false';
  });
}

/** Read rendering intent even when a preceding option fails parsing. Values are not flags. */
function machineOutputRequested(argv: string[], program: Command) {
  const options = new Map<string, Option>();
  const collect = (command: Command) => {
    for (const option of command.options) {
      if (option.long) options.set(option.long, option);
      if (option.short) options.set(option.short, option);
    }
    for (const child of command.commands) collect(child);
  };
  collect(program);
  let agent = agentDefault();
  let json = false;
  let jq = false;
  let format: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined || token === '--') break;
    if (!token) continue;
    const separator = token.indexOf('=');
    const flag = separator < 0 ? token : token.slice(0, separator);
    const option = options.get(flag);
    if (!option) continue;
    const value = separator < 0 ? argv[index + 1] : token.slice(separator + 1);
    if (flag === '--json') json = true;
    if (flag === '--agent-mode') agent = true;
    if (flag === '--no-agent-mode') agent = false;
    if (flag === '--jq') jq = true;
    if (flag === '--output-format') format = value;
    if (separator < 0 && (option.required || (option.optional && value && !value.startsWith('-'))))
      index++;
  }
  return json || jq || agent || (format !== undefined && ['json', 'yaml', 'toon'].includes(format));
}

export function createProgram(
  dependencies: CliDependencies = defaultDependencies,
  io: CliIO = defaultIO,
) {
  const program = new Command()
    .name('orvelt')
    .description(
      'Work with Orvelt Business using browser OAuth and organization-scoped permissions.',
    )
    .version(version)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError('(Run orvelt --help for usage.)')
    .addOption(
      new Option('--server <url>', 'Business API resource')
        .env('ORVELT_API_URL')
        .default(DEFAULT_SERVER),
    )
    .addOption(
      new Option('--timeout <seconds>', 'request timeout (1–600 seconds)')
        .argParser(timeout)
        .default(30),
    )
    .option('--json', 'print machine-readable JSON, including failures')
    .addOption(
      new Option('--output-format <format>', 'result format').choices([
        'json',
        'pretty',
        'table',
        'yaml',
        'toon',
      ]),
    )
    .option('--jq <filter>', 'filter results with jq (overrides output format)')
    .option('--raw-output', 'write jq string results without JSON quotes')
    .option('--agent-mode', 'use machine output and never open a browser', agentDefault())
    .option('--no-agent-mode', 'disable agent mode and environment detection');

  const connectionOptions = async (command: Command): Promise<ConnectionOptions> => {
    const options = command.optsWithGlobals<{ server: string; timeout: number }>();
    return {
      server: await dependencies.normalizeServer(options.server),
      timeoutMs: options.timeout * 1000,
      signal: io.signal,
      log: (message) => io.stderr(`${terminalText(message)}\n`),
    };
  };
  const json = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  const result = (value: unknown, command: Command) => {
    if (
      command.optsWithGlobals().json ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      json(value);
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      if (field !== undefined) {
        io.stdout(
          `${key}: ${terminalText(typeof field === 'string' ? field : JSON.stringify(field))}\n`,
        );
      }
    }
  };

  const output = async <T>(
    command: Command,
    load: () => Promise<T>,
    human?: (value: T) => void,
  ) => {
    const options = command.optsWithGlobals<{
      outputFormat?: OutputFormat;
      jq?: string;
      rawOutput?: boolean;
      json?: boolean;
      agentMode?: boolean;
      timeout: number;
    }>();
    // Compile the filter before loading input, credentials, or sending a mutation.
    const renderer = await prepareOutput(
      {
        format: options.outputFormat,
        jq: options.jq,
        rawOutput: options.rawOutput,
        signal: io.signal,
        timeoutMs: options.timeout * 1000,
      },
      io.stdout,
    );
    try {
      const value = await load();
      if (human && !options.outputFormat && !options.jq && !options.json && !options.agentMode)
        human(value);
      else await renderer.write(value);
    } finally {
      renderer.close();
    }
  };

  const auth = program.command('auth').description('Sign in, inspect credentials, or disconnect.');
  auth
    .command('login')
    .description('Open the organization picker and permissions window in your browser.')
    .option('--write', 'request write permission as well as read access')
    .option('--no-browser', 'print the authorization URL without opening a browser')
    .addOption(
      new Option('--login-timeout <seconds>', 'time to finish browser authorization')
        .argParser(timeout)
        .default(300),
    )
    .action(
      async (
        options: { write?: boolean; browser: boolean; loginTimeout: number },
        command: Command,
      ) => {
        await output(
          command,
          async () => {
            const connection = await connectionOptions(command);
            return dependencies.login({
              ...connection,
              timeoutMs: options.loginTimeout * 1000,
              write: options.write === true,
              browser: command.optsWithGlobals().agentMode ? false : options.browser,
            });
          },
          (value) => result(value, command),
        );
      },
    );
  auth
    .command('status')
    .description('Check stored authorization against the server without displaying tokens.')
    .action(async (_options, command: Command) => {
      await output(
        command,
        async () => dependencies.authStatus(await connectionOptions(command)),
        (value) => result(value, command),
      );
    });
  auth
    .command('logout')
    .description('Revoke the OAuth credentials and remove them from this computer.')
    .option('--local', 'only remove local credentials; server authorization remains active')
    .action(async (options: { local?: boolean }, command: Command) => {
      await output(
        command,
        async () =>
          dependencies.logout({
            ...(await connectionOptions(command)),
            local: options.local === true,
          }),
        (value) => result(value, command),
      );
    });

  const tools = program
    .command('tools')
    .description('Discover operations available to your OAuth connection.');
  tools
    .command('list')
    .description('List all permitted operations, from the Business API.')
    .option('--search <text>', 'filter operation names and descriptions')
    .action(async (options: { search?: string }, command: Command) => {
      await output(
        command,
        async () => {
          const connection = await connectionOptions(command);
          const operations = await dependencies.withApiClient(connection, (client) =>
            dependencies.listOperations(client, connection),
          );
          const search = options.search?.toLowerCase();
          const filtered =
            search === undefined
              ? operations
              : operations.filter((tool) =>
                  `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(search),
                );
          return filtered;
        },
        (filtered) => {
          if (filtered.length === 0) return io.stdout('No matching operations.\n');
          for (const tool of filtered) {
            io.stdout(
              `${terminalText(tool.name)}\t${terminalText(tool.title ?? tool.description ?? '')}\n`,
            );
          }
        },
      );
    });
  tools
    .command('describe')
    .description('Print the input schema and details for an operation as JSON.')
    .argument('<name>', 'exact operation name from tools list')
    .action(async (name: string, _options, command: Command) => {
      await output(command, async () => {
        const connection = await connectionOptions(command);
        return dependencies.withApiClient(connection, (client) =>
          dependencies.describeOperation(client, name, connection),
        );
      });
    });

  program
    .command('call')
    .description('Call an operation once and print its result as JSON.')
    .argument('<name>', 'exact operation name from tools list')
    .option('--input <json|@file|->', 'JSON object, @file.json, or - to read stdin', '{}')
    .addOption(
      new Option('--set <field=json...>', 'override top-level input fields with JSON values'),
    )
    .option(
      '--dry-run',
      'preview an RPC request without executing it (live discovery unless --catalog)',
    )
    .option('--catalog <@file>', 'use an exported catalog offline; only with --schema or --dry-run')
    .addOption(
      new Option('--schema', 'print the current input JSON schema without executing').conflicts([
        'input',
        'set',
        'dryRun',
      ]),
    )
    .action(
      async (
        name: string,
        options: {
          input: string;
          set?: string[];
          dryRun?: boolean;
          schema?: boolean;
          catalog?: string;
        },
        command: Command,
      ) => {
        if (options.catalog && !options.schema && !options.dryRun)
          throw new InputError(
            '--catalog is preview-only. Live authorization is required to execute.',
          );
        if (options.schema) {
          if (command.optsWithGlobals().jq || command.optsWithGlobals().rawOutput)
            throw new InputError(
              '--schema returns exact JSON. Filter tools describe output instead.',
            );
          const connection = await connectionOptions(command);
          const operation = options.catalog
            ? catalogOperation(await readCatalog(options.catalog, io.signal), name)
            : await dependencies.withApiClient(connection, (client) =>
                dependencies.describeOperation(client, name, connection),
              );
          json(operation.inputSchema);
          return;
        }
        await output(command, async () => {
          // Validate input before contacting the server or reading credentials.
          const input = mergeInput(
            await dependencies.readInput(options.input, { signal: io.signal }),
            options.set,
          );
          const connection = await connectionOptions(command);
          if (options.dryRun) {
            const preview = options.catalog
              ? await previewCatalogOperation(
                  catalogOperation(await readCatalog(options.catalog, io.signal), name),
                  input,
                  connection,
                )
              : await dependencies.withApiClient(connection, (client) =>
                  dependencies.previewOperation(client, name, input, connection),
                );
            return {
              ...(diagnosticResult(preview) as object),
              server: connection.server,
              catalogSource: options.catalog ? 'file' : 'live',
              authorization: options.catalog ? 'not_checked' : 'catalog_checked',
            };
          }
          return dependencies.withApiClient(connection, (client) =>
            dependencies.callOperation(client, name, input, connection),
          );
        });
      },
    );

  program
    .command('completion')
    .description('Print an offline shell completion script.')
    .addArgument(
      new Argument('<shell>', 'shell to configure').choices(['bash', 'zsh', 'fish', 'powershell']),
    )
    .action((shell: CompletionShell) => io.stdout(completionScript(program, shell)));
  program
    .command('__complete', { hidden: true })
    .description('Offline shell completion endpoint.')
    .argument('[words...]')
    .action((words: string[]) => {
      for (const item of complete(program, words))
        io.stdout(`${item.value}\t${terminalText(item.description)}\n`);
    });

  program.addHelpText(
    'after',
    `
Examples:
  orvelt auth login
  orvelt tools list --search projects
  orvelt tools describe projects_list
  orvelt call projects_list --schema
  orvelt call projects_list --dry-run
  orvelt call projects_list --input '{}'
  orvelt call <operation> --input @request.json

Login requests read access by default. Use auth login --write to request changes.
Calls never open a browser. Run auth login explicitly when authorization expires.
`,
  );
  installUsage(program, io.stdout);
  return program;
}

/** One error boundary; stdout contains only results/help, diagnostics go to stderr. */
export async function runCli(
  argv: string[],
  options: { dependencies?: CliDependencies; io?: CliIO } = {},
): Promise<number> {
  const io = options.io ?? defaultIO;
  const program = createProgram(options.dependencies, io);
  const parserErrors: string[] = [];
  const captureErrors = (command: Command) => {
    command.configureOutput({ writeErr: (text) => parserErrors.push(text) });
    for (const child of command.commands) captureErrors(child);
  };
  captureErrors(program);
  const machineIntent = machineOutputRequested(argv, program);
  return program.parseAsync(argv.length ? argv : ['--help'], { from: 'user' }).then(
    () => 0,
    (error: unknown) => {
      if (error instanceof CommanderError && error.exitCode === 0) return 0;
      const exitCode = io.signal?.aborted
        ? 130
        : error instanceof CommanderError
          ? 2
          : error instanceof Error && 'exitCode' in error && typeof error.exitCode === 'number'
            ? error.exitCode
            : 1;
      const message = io.signal?.aborted
        ? 'Command cancelled.'
        : diagnosticText(error instanceof Error ? error.message : 'Command failed.');
      const result =
        error instanceof Error && 'result' in error ? diagnosticResult(error.result) : undefined;
      const globals = program.opts();
      const machine =
        globals.json ||
        globals.agentMode ||
        globals.jq ||
        ['json', 'yaml', 'toon'].includes(globals.outputFormat) ||
        machineIntent;
      if (machine) {
        const classification = classifyError(error, {
          exitCode,
          command: 'orvelt',
          cancelled: io.signal?.aborted,
        });
        io.stderr(
          `${JSON.stringify({ error: { message, exitCode, result, ...classification } })}\n`,
        );
      } else if (error instanceof CommanderError) {
        for (const text of parserErrors) io.stderr(text);
      } else {
        io.stderr(`Error: ${message}\n`);
        if (result !== undefined) io.stderr(`${JSON.stringify(result, null, 2)}\n`);
      }
      return exitCode;
    },
  );
}
