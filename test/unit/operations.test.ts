import { describe, expect, mock, test } from 'bun:test';
import {
  callOperation,
  describeOperation,
  listOperations,
  OperationError,
  previewOperation,
  type Operation,
  type BusinessApiClient,
} from '../../src/operations';

const options = { timeoutMs: 1234 };
const operation = (name = 'projects_create'): Operation => ({
  name,
  path: ['projects', 'create'],
  access: 'write',
  inputSchema: { type: 'object', properties: {} },
});
function fixture(operations = [operation()], result: unknown = { id: 'created' }) {
  const call = mock<BusinessApiClient['call']>(async (path) =>
    path.join('.') === 'oauthConnections.operations' ? { operations } : result,
  );
  return { client: { call }, call };
}
describe('direct API operation catalog', () => {
  test('validates and sorts exact names without using MCP discovery', async () => {
    const { client, call } = fixture([operation('z'), operation('A'), operation('a')]);
    expect((await listOperations(client, options)).map((op) => op.name)).toEqual(['A', 'a', 'z']);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(['oauthConnections', 'operations'], {}, options);
  });
  test('accepts an empty grant', async () => {
    expect(await listOperations(fixture([]).client, options)).toEqual([]);
  });
  test.each([0, -1, NaN, Infinity])(
    'rejects invalid timeout %s without network access',
    async (timeoutMs) => {
      const { client, call } = fixture();
      await expect(listOperations(client, { timeoutMs })).rejects.toThrow('positive, finite');
      expect(call).not.toHaveBeenCalled();
    },
  );
  test.each(['projects.create', 'projects-create', 'Projects_create', ' projects_create'])(
    'never invents an operation alias: %s',
    async (name) => {
      const { client, call } = fixture();
      await expect(describeOperation(client, name, options)).rejects.toThrow(
        'exact operation name',
      );
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
  test('missing write access provides explicit reauthorization guidance and never executes', async () => {
    const { client, call } = fixture([operation('projects_list')]);
    await expect(callOperation(client, 'projects_create', {}, options)).rejects.toBeInstanceOf(
      OperationError,
    );
    await expect(callOperation(client, 'projects_create', {}, options)).rejects.toThrow(
      'auth login --write',
    );
    expect(
      call.mock.calls.every(([path]) => path.join('.') === 'oauthConnections.operations'),
    ).toBe(true);
  });
  test.each([null, false, 0, '', [], {}, { id: 'created' }])(
    'preserves API result exactly: %j',
    async (result) => {
      const { client, call } = fixture(undefined, result);
      expect(await callOperation(client, 'projects_create', { name: 'demo' }, options)).toEqual(
        result,
      );
      expect(call).toHaveBeenLastCalledWith(['projects', 'create'], { name: 'demo' }, options);
      expect(call).toHaveBeenCalledTimes(2);
    },
  );
  test('a denied mutation is never retried, irrespective of catalog hints', async () => {
    const { client, call } = fixture();
    const error = new Error('Denied');
    call.mockImplementation(async (path) => {
      if (path[0] === 'oauthConnections') return { operations: [operation()] };
      throw error;
    });
    await expect(callOperation(client, 'projects_create', {}, options)).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(2);
  });
  test('a write preview only fetches the permitted catalog and never submits the mutation', async () => {
    const { client, call } = fixture();
    expect(await previewOperation(client, 'projects_create', { name: 'Preview' }, options)).toEqual(
      {
        dryRun: true,
        executed: false,
        operation: { name: 'projects_create', path: ['projects', 'create'], access: 'write' },
        input: { name: 'Preview' },
        validation: 'catalog_schema',
      },
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(['oauthConnections', 'operations'], {}, options);
  });
  test('preview still requires catalog permission and honors cancellation', async () => {
    const { client, call } = fixture([]);
    await expect(previewOperation(client, 'projects_create', {}, options)).rejects.toBeInstanceOf(
      OperationError,
    );
    expect(call).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      previewOperation(client, 'projects_create', {}, { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  test('preview checks file envelopes without uploading anything', async () => {
    const op = operation();
    op.inputSchema = {
      type: 'object',
      properties: { file: { type: 'object', properties: { name: {}, mimeType: {}, base64: {} } } },
    };
    const { client, call } = fixture([op]);
    await expect(
      previewOperation(
        client,
        op.name,
        { file: { name: 'demo.txt', mimeType: 'text/plain', base64: 'not-base64!' } },
        options,
      ),
    ).rejects.toThrow('File arguments');
    expect(call).toHaveBeenCalledTimes(1);
    const input = { file: { name: 'demo.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' } };
    expect((await previewOperation(client, op.name, input, options)).input).toEqual(input);
    expect(call).toHaveBeenCalledTimes(2);
    expect(
      call.mock.calls.every(([path]) => path.join('.') === 'oauthConnections.operations'),
    ).toBe(true);
  });
  test('validates remote paths and duplicate names before execution', async () => {
    for (const operations of [
      [{ ...operation(), path: ['..', 'admin'] }],
      [operation(), operation()],
    ]) {
      const { client, call } = fixture(operations);
      await expect(callOperation(client, 'projects_create', {}, options)).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
  test('aborting after discovery prevents execution', async () => {
    const controller = new AbortController();
    const { client, call } = fixture();
    call.mockImplementation(async () => {
      controller.abort();
      return { operations: [operation()] };
    });
    await expect(
      callOperation(client, 'projects_create', {}, { ...options, signal: controller.signal }),
    ).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
  test('file arguments become real files for the RPC multipart serializer', async () => {
    const op = operation();
    op.inputSchema = {
      type: 'object',
      properties: {
        file: {
          type: 'object',
          properties: { name: {}, mimeType: {}, base64: {} },
        },
      },
    };
    const { client, call } = fixture([op]);
    await callOperation(
      client,
      op.name,
      { file: { name: 'demo.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' } },
      options,
    );
    const input = call.mock.calls[1]?.[1] as { file: File };
    expect(input.file).toBeInstanceOf(File);
    expect(await input.file.text()).toBe('hello');
  });
});
