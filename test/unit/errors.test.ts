import { describe, expect, test } from 'bun:test';
import { CommanderError } from 'commander';
import { ORPCError } from '@orpc/client';
import { AuthError } from '../../src/auth/errors';
import { InputError } from '../../src/input';
import { OperationError } from '../../src/operations';
import { classifyError } from '../../src/errors';

const options = { exitCode: 1, command: 'orvelt call projects_list' };

function orpc(code: string, status?: number) {
  const error = Object.create(ORPCError.prototype) as {
    code: string;
    status?: number;
  };
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

describe('classifyError', () => {
  test.each([
    [400, 'BAD_REQUEST', 'validation_error'],
    [401, 'UNAUTHORIZED', 'authentication_error'],
    [403, 'FORBIDDEN', 'authorization_error'],
    [404, 'NOT_FOUND', 'not_found'],
    [429, 'TOO_MANY_REQUESTS', 'rate_limit_error'],
    [500, 'INTERNAL_SERVER_ERROR', 'server_error'],
  ])('classifies API status %d', (status, code, type) => {
    expect(classifyError(orpc(code, status), options)).toMatchObject({ type, code, status });
  });

  test('classifies a nested typed OperationError result without exposing fields', () => {
    const result = classifyError(
      new OperationError('remote failure', {
        code: 'FORBIDDEN',
        status: 403,
        secret: 'never-returned',
      }),
      options,
    );
    expect(result).toMatchObject({ type: 'authorization_error', code: 'FORBIDDEN', status: 403 });
    expect(result).not.toHaveProperty('secret');
  });

  test.each([
    ['commander.unknownCommand', 'Run orvelt --help'],
    ['commander.unknownOption', 'Run the command with --help'],
    ['commander.missingArgument', 'required arguments'],
  ])('uses parser code %s rather than message text', (code, hint) => {
    const error = new CommanderError(2, code, 'arbitrary private message');
    expect(classifyError(error, { ...options, exitCode: 2 })).toMatchObject({
      type: 'validation_error',
      code: 'CLI_VALIDATION',
    });
    expect(classifyError(error, { ...options, exitCode: 2 }).hints.join(' ')).toContain(hint);
  });

  test('classifies input validation', () => {
    expect(
      classifyError(new InputError('private payload'), { ...options, exitCode: 2 }),
    ).toMatchObject({
      type: 'validation_error',
      code: 'CLI_VALIDATION',
    });
  });

  test.each([
    ['auth', 'authentication_error', 'CLI_AUTHENTICATION'],
    ['security', 'protocol_error', 'CLI_SECURITY'],
    ['storage', 'runtime_error', 'CLI_STORAGE'],
    ['network', 'connection_error', 'CLI_CONNECTION'],
  ] as const)('does not collapse AuthError kind %s into auth', (kind, type, code) => {
    expect(classifyError(new AuthError('private', kind), options)).toMatchObject({ type, code });
  });

  test('distinguishes external cancellation from a deadline', () => {
    expect(
      classifyError(new Error('anything'), { ...options, exitCode: 130, cancelled: true }),
    ).toMatchObject({
      type: 'cancelled',
      code: 'CLI_CANCELLED',
    });
    expect(classifyError(new AuthError('deadline', 'cancelled'), options)).toMatchObject({
      type: 'timeout_error',
      code: 'CLI_TIMEOUT',
    });
    expect(classifyError(new Error('anything'), { ...options, exitCode: 130 })).toMatchObject({
      type: 'runtime_error',
      code: 'CLI_RUNTIME',
    });
  });

  test('does not infer usage from an unknown error message', () => {
    expect(
      classifyError(new Error('unknown flag --secret'), { ...options, exitCode: 1 }),
    ).toMatchObject({
      type: 'runtime_error',
      code: 'CLI_RUNTIME',
    });
  });
});
