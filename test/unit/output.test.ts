import { afterEach, describe, expect, test } from 'bun:test';
import { prepareOutput } from '../../src/output';

const outputs: string[] = [];
afterEach(() => outputs.splice(0));

const collect = (options: Parameters<typeof prepareOutput>[0]) =>
  prepareOutput(options, (text) => outputs.push(text));

describe('output rendering', () => {
  test('JSON preserves unknown nested fields, nulls, and empty arrays', async () => {
    const output = await collect({ format: 'json' });
    await output.write({ unknown: { nested: [{ value: null }], empty: [] } });
    expect(JSON.parse(outputs.join(''))).toEqual({
      unknown: { nested: [{ value: null }], empty: [] },
    });
    output.close();
  });

  test('YAML and TOON are loaded lazily and retain actual values', async () => {
    const value = {
      rows: [
        { id: 1, extra: null },
        { id: 2, extra: [] },
      ],
    };
    const yaml = await collect({ format: 'yaml' });
    await yaml.write(value);
    expect(outputs.join('')).toContain('extra: null');
    yaml.close();

    outputs.splice(0);
    const toon = await collect({ format: 'toon' });
    await toon.write(value);
    expect(outputs.join('')).toContain('rows[2]');
    expect(outputs.join('')).toContain('extra');
    toon.close();
  });

  test('table unions keys and renders nested values compactly', async () => {
    const output = await collect({ format: 'table' });
    await output.write({
      rows: [
        { id: 'a', nested: { ok: true } },
        { id: 'b', extra: null },
      ],
      count: 2,
      empty: [],
    });
    const text = outputs.join('');
    expect(text).toContain('count');
    expect(text).toContain('empty');
    expect(text).toContain('rows');
    output.close();
  });

  test('terminal formats remove control characters', async () => {
    const output = await collect({ format: 'pretty' });
    await output.write({ message: '\u001b[31mred\ntext' });
    expect(outputs.join('')).not.toContain('\u001b');
    expect(outputs.join('')).not.toContain('\ntext');
    output.close();
  });

  test('raw output requires jq', async () => {
    await expect(prepareOutput({ rawOutput: true }, () => undefined)).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});

describe('jq rendering', () => {
  test('runs real jq functions, ranges, and multiple outputs', async () => {
    const output = await collect({
      jq: '.items[] | select(.ok) | .name as $name | range(0; 2) | [$name, tostring]',
    });
    await output.write({
      items: [
        { name: 'a', ok: true },
        { name: 'b', ok: false },
      ],
    });
    expect(outputs.map((line) => JSON.parse(line))).toEqual([
      ['a', '0'],
      ['a', '1'],
    ]);
    expect(outputs.join('')).toContain('[\n');
    output.close();
  });

  test('zero-result filters are silent and raw strings are not JSON quoted', async () => {
    const none = await collect({ jq: 'empty' });
    await none.write({ secret: 'not emitted' });
    expect(outputs).toEqual([]);
    none.close();

    const raw = await collect({ jq: '.name', rawOutput: true });
    await raw.write({ name: 'Alpha' });
    expect(outputs.join('')).toBe('Alpha\n');
    outputs.splice(0);
    await raw.write({ name: 7 });
    expect(outputs.join('')).toBe('7\n');
    outputs.splice(0);
    await raw.write({ name: 'line\n' });
    expect(outputs.join('')).toBe('line\n\n');
    raw.close();
  });

  test('invalid jq is rejected during preparation', async () => {
    await expect(prepareOutput({ jq: '.items | [' }, () => undefined)).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  test('abort closes a jq worker request', async () => {
    const controller = new AbortController();
    const output = await collect({ jq: '.', signal: controller.signal, timeoutMs: 1000 });
    controller.abort();
    await expect(output.write({ value: 1 })).rejects.toThrow('cancelled');
    output.close();
  });

  test('timeout terminates a bounded jq request', async () => {
    const output = await collect({ jq: 'until(false; .)', timeoutMs: 1000 });
    await expect(output.write(null)).rejects.toThrow('timed out');
    output.close();
  });
});
