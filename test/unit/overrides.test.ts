import { describe, expect, test } from 'bun:test';
import { InputError, MAX_INPUT_BYTES, mergeInput } from '../../src/input';

describe('typed JSON input overrides', () => {
  test('preserves JSON types without coercion and leaves original input untouched', () => {
    const input = { unchanged: 'keep', limit: 1 };
    expect(
      mergeInput(input, [
        'limit=5',
        'enabled=false',
        'empty=null',
        'tags=["x"]',
        'filter={"key":"value"}',
        'name="A=B"',
      ]),
    ).toEqual({
      unchanged: 'keep',
      limit: 5,
      enabled: false,
      empty: null,
      tags: ['x'],
      filter: { key: 'value' },
      name: 'A=B',
    });
    expect(input).toEqual({ unchanged: 'keep', limit: 1 });
  });
  test('last assignment wins', () => {
    expect(mergeInput({}, ['limit=1', 'limit=2'])).toEqual({ limit: 2 });
  });
  test.each([
    'missing',
    '=1',
    'name=PRIVATE',
    'name=',
    'name=undefined',
    'limit=1e999',
    'nested.key=1',
    '__proto__={}',
    'constructor={}',
    'prototype={}',
    'a[0]=1',
  ])('rejects invalid assignment %s without echoing values', (assignment) => {
    expect(() => mergeInput({}, [assignment])).toThrow(InputError);
    expect(() => mergeInput({}, [assignment])).not.toThrow('PRIVATE');
  });
  test('limits raw assignment size and merged input size', () => {
    expect(() => mergeInput({}, [`name="${'x'.repeat(MAX_INPUT_BYTES)}"`])).toThrow('1 MiB');
    expect(() =>
      mergeInput({ initial: 'x'.repeat(MAX_INPUT_BYTES / 2) }, [
        `name="${'x'.repeat(MAX_INPUT_BYTES / 2)}"`,
      ]),
    ).toThrow('1 MiB');
  });
});
