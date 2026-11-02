import { describe, expect, test } from 'bun:test';
import { InputError } from '../../src/input';
import { validateOperationInput } from '../../src/validation';

describe('operation input validation', () => {
  test('validates current catalog features without mutating defaults or input', () => {
    const input = {
      slug: 'my-project',
      name: 'Project',
      description: null,
      metadata: { owner: 'team' },
      nested: [{ enabled: false }],
    };
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
        name: { type: 'string' },
        description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        metadata: { type: 'object', additionalProperties: {} },
        nested: {
          type: 'array',
          items: { type: 'object', properties: { enabled: { type: 'boolean' } } },
        },
        status: { type: 'string', default: 'draft' },
      },
      required: ['slug', 'name'],
    };

    expect(validateOperationInput(input, schema)).toBe(input);
    expect(input).not.toHaveProperty('status');
  });

  test('validates local refs, unions, and file envelopes', () => {
    const schema = {
      $defs: {
        file: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            mimeType: { type: 'string' },
            base64: { type: 'string' },
          },
          required: ['name', 'mimeType', 'base64'],
          additionalProperties: false,
        },
      },
      type: 'object',
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
        file: { $ref: '#/$defs/file' },
      },
    };

    expect(
      validateOperationInput(
        { value: 3, file: { name: 'x.txt', mimeType: 'text/plain', base64: 'eA==' } },
        schema,
      ),
    ).toEqual({ value: 3, file: { name: 'x.txt', mimeType: 'text/plain', base64: 'eA==' } });
    expect(validateOperationInput({ value: null }, schema)).toEqual({ value: null });
  });

  test('keeps arbitrary keys when additionalProperties is absent or true', () => {
    expect(
      validateOperationInput(
        { known: 'ok', actual: 1 },
        { type: 'object', properties: { known: { type: 'string' } } },
      ),
    ).toEqual({ known: 'ok', actual: 1 });
    expect(
      validateOperationInput({ actual: 1 }, { type: 'object', additionalProperties: true }),
    ).toEqual({ actual: 1 });
  });

  test.each([
    [
      {},
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      'name:type:string',
    ],
    [{ name: 3 }, { type: 'object', properties: { name: { type: 'string' } } }, 'name:type:string'],
    [
      { status: 'other' },
      { type: 'object', properties: { status: { enum: ['draft', 'published'] } } },
      'status:invalid_value',
    ],
    [
      { extra: true },
      { type: 'object', properties: {}, additionalProperties: false },
      'extra:unrecognized_keys',
    ],
    [
      { file: { name: 'x' } },
      {
        type: 'object',
        properties: {
          file: {
            type: 'object',
            properties: { name: { type: 'string' }, base64: { type: 'string' } },
            required: ['name', 'base64'],
          },
        },
      },
      'file.base64:type:string',
    ],
  ])('rejects invalid input with path and constraint only', (input, schema, expected) => {
    try {
      validateOperationInput(input, schema);
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(InputError);
      expect((error as Error).message).toContain(expected);
      expect((error as Error).message).not.toContain('other');
    }
  });

  test('rejects remote refs and unsupported schema compilation explicitly', () => {
    expect(() => validateOperationInput({}, { $ref: 'https://example.com/schema.json' })).toThrow(
      'only local JSON Pointer references',
    );
    expect(() =>
      validateOperationInput(
        {},
        { type: 'object', properties: { x: { type: 'unknown-keyword' } } },
      ),
    ).toThrow('unsupported JSON Schema feature');
  });

  test('bounds schema depth and pattern size', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let index = 0; index < 65; index += 1) deep = { allOf: [deep] };
    expect(() => validateOperationInput({}, deep)).toThrow('schema nesting is too deep');
    expect(() => validateOperationInput({}, { type: 'string', pattern: 'x'.repeat(4097) })).toThrow(
      'regular-expression constraints are too large',
    );
  });
});
