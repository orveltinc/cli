import { CommanderError } from 'commander';
import { COMMON_ERROR_STATUS_MAP, ORPCError } from '@orpc/client';
import { AuthError } from './auth/errors';
import { InputError } from './input';
import { OperationError } from './operations';

export type ClassifiedError = {
  type: string;
  code: string;
  hints: string[];
  status?: number;
};

type ApiFailure = { code: string; status?: number };
const standardStatuses: Readonly<Partial<Record<string, number>>> = COMMON_ERROR_STATUS_MAP;

const parserHints: Record<string, string[]> = {
  'commander.unknownCommand': [
    'Run orvelt --help to list commands, or --usage for the command surface.',
  ],
  'commander.unknownOption': [
    'Run the command with --help to check its options, or --usage for the command surface.',
  ],
  'commander.missingArgument': ['Run the command with --help to see required arguments.'],
  'commander.missingMandatoryOption': ['Run the command with --help to see required options.'],
  'commander.invalidArgument': ['Run the command with --help to check the expected value.'],
  'commander.excessArguments': ['Run the command with --help to check its arguments.'],
};

function apiType(status: number | undefined, code: string): ClassifiedError['type'] {
  // RPC errors carry codes, not HTTP transport statuses. Use the library's
  // canonical code taxonomy for classification without inventing a status field.
  status ??= standardStatuses[code];
  if (status === 401 || /^(?:UNAUTHORIZED|UNAUTHENTICATED)$/.test(code))
    return 'authentication_error';
  if (status === 403 || code === 'FORBIDDEN') return 'authorization_error';
  if (status === 404 || code === 'NOT_FOUND') return 'not_found';
  if (status === 429 || /^(?:TOO_MANY_REQUESTS|RATE_LIMITED)$/.test(code))
    return 'rate_limit_error';
  if (status !== undefined && status >= 500) return 'server_error';
  if (status === 400 || status === 422 || /^(?:BAD_REQUEST|VALIDATION_ERROR)$/.test(code))
    return 'validation_error';
  if (status !== undefined && status >= 400) return 'api_error';
  return 'api_error';
}

function apiHints(type: ClassifiedError['type']): string[] {
  switch (type) {
    case 'authentication_error':
      return ['Run orvelt auth login and verify the configured server.'];
    case 'authorization_error':
      return ['Check organization membership and OAuth resource permissions.'];
    case 'not_found':
      return ['Verify the resource identifier and organization or project scope.'];
    case 'rate_limit_error':
      return ['Wait before retrying; honor any server-provided retry interval.'];
    case 'validation_error':
      return ['Check the request against the command input schema or run with --help.'];
    case 'server_error':
      return ['Retry after a short delay; do not replay a mutation until its outcome is checked.'];
    default:
      return [];
  }
}

function apiFailure(value: unknown): ApiFailure | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { code?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.code !== 'string' || candidate.code.length === 0) return undefined;
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  return { code: candidate.code, status };
}

function local(type: string, code: string, hints: string[], status?: number): ClassifiedError {
  return status === undefined ? { type, code, hints } : { type, code, hints, status };
}

/** Classify only typed errors; arbitrary messages are deliberately never parsed. */
export function classifyError(
  error: unknown,
  options: { exitCode: number; command: string; cancelled?: boolean },
): ClassifiedError {
  if (options.cancelled) {
    return local('cancelled', 'CLI_CANCELLED', [
      'The command was interrupted. Inspect current state before retrying a mutation.',
    ]);
  }

  if (error instanceof AuthError) {
    if (error.kind === 'forbidden')
      return local('authorization_error', 'FORBIDDEN', apiHints('authorization_error'));
    if (error.kind === 'cancelled') {
      return local('timeout_error', 'CLI_TIMEOUT', [
        'The operation timed out. Inspect current state before retrying a mutation.',
      ]);
    }
    if (error.kind === 'network') {
      return local('connection_error', 'CLI_CONNECTION', [
        'Check network connectivity and the configured server URL.',
      ]);
    }
    if (error.kind === 'storage') {
      return local('runtime_error', 'CLI_STORAGE', [
        'Check local credential storage permissions and configuration.',
      ]);
    }
    if (error.kind === 'security') {
      return local('protocol_error', 'CLI_SECURITY', [
        'Check the CLI configuration and server security requirements.',
      ]);
    }
    return local('authentication_error', 'CLI_AUTHENTICATION', [
      'Run orvelt auth login and verify the configured server.',
    ]);
  }

  if (error instanceof InputError) {
    return local('validation_error', 'CLI_VALIDATION', [
      'Check the JSON input and command schema.',
    ]);
  }

  if (error instanceof CommanderError) {
    const hints = parserHints[error.code] ?? [
      'Run the command with --help, or --usage for the command surface.',
    ];
    return local('validation_error', 'CLI_VALIDATION', hints);
  }

  let failure: ApiFailure | undefined;
  if (error instanceof ORPCError) {
    const candidate = error as unknown as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    failure = apiFailure(candidate);
    if (!failure && typeof candidate.code === 'string') failure = { code: candidate.code };
  } else if (error instanceof OperationError) {
    failure = apiFailure(error.result);
  }
  if (failure) {
    const type = apiType(failure.status, failure.code);
    return local(type, failure.code, apiHints(type), failure.status);
  }

  if (options.exitCode === 130) {
    return local('runtime_error', 'CLI_RUNTIME', [
      'The command ended unexpectedly. Inspect current state before retrying.',
    ]);
  }
  return local('runtime_error', 'CLI_RUNTIME', [
    `Review the failure from ${options.command} and retry only after checking its outcome.`,
  ]);
}
