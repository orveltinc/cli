import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MAX_INPUT_BYTES, readInput } from '../../src/input';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('JSON command input', () => {
  test('preserves typed values and defaults to an empty object', async () => {
    expect(await readInput(undefined)).toEqual({});
    expect(await readInput('{"enabled":false,"count":3,"nested":{"items":[null,"ok"]}}')).toEqual({
      enabled: false,
      count: 3,
      nested: { items: [null, 'ok'] },
    });
  });

  test.each(['[]', 'null', 'true', '3', '"text"', '', '{private-content'])(
    'rejects invalid object input without echoing it: %s',
    async (input) => {
      await expect(readInput(input)).rejects.toMatchObject({ exitCode: 2 });
      await expect(readInput(input)).rejects.not.toThrow('private-content');
    },
  );

  test('reads JSON from stdin', async () => {
    expect(await readInput('-', { stdin: Readable.from(['{"foo":', '"bar"}']) })).toEqual({
      foo: 'bar',
    });
  });

  test('reads a regular file and rejects directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orvelt-cli-input-'));
    directories.push(directory);
    const file = join(directory, 'input.json');
    await writeFile(file, '{"foo":"bar"}');
    expect(await readInput(`@${file}`)).toEqual({ foo: 'bar' });
    await expect(readInput(`@${directory}`)).rejects.toThrow('regular file');
  });

  test('bounds inline and streaming input in bytes', async () => {
    await expect(readInput(' '.repeat(MAX_INPUT_BYTES + 1))).rejects.toThrow('1 MiB');
    await expect(
      readInput('-', { stdin: Readable.from([Buffer.alloc(MAX_INPUT_BYTES), 'x']) }),
    ).rejects.toThrow('1 MiB');
  });

  test('cancelled stdin read terminates promptly', async () => {
    const controller = new AbortController();
    const stdin = new Readable({ read() {} });
    const reading = readInput('-', { stdin, signal: controller.signal });
    controller.abort();
    await expect(reading).rejects.toThrow('cancelled');
    expect(stdin.destroyed).toBe(true);
  });
});
