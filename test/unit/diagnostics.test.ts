import { describe, expect, test } from 'bun:test';
import { diagnosticResult, diagnosticText, terminalText } from '../../src/diagnostics';

describe('diagnostics', () => {
  test('removes terminal controls and redacts credential key spellings', () => {
    const result = diagnosticResult({
      access_token: 'a',
      refreshToken: 'b',
      'ID-TOKEN': 'c',
      client_secret: 'd',
      apiKey: 'e',
      password: 'f',
      private_key: 'g',
      'proxy-auth': 'h',
      Cookie: 'i',
      'X-Auth-Token': 'j',
      code: 'ordinary-code',
      status: 'published',
    });
    expect(result).toMatchObject({
      access_token: '[redacted]',
      refreshToken: '[redacted]',
      'ID-TOKEN': '[redacted]',
      client_secret: '[redacted]',
      apiKey: '[redacted]',
      password: '[redacted]',
      private_key: '[redacted]',
      'proxy-auth': '[redacted]',
      Cookie: '[redacted]',
      'X-Auth-Token': '[redacted]',
      code: 'ordinary-code',
      status: 'published',
    });
    expect(terminalText('\u001b[31mred\u001b[0m\nnext')).toBe('red next');
  });

  test('redacts URL queries and inline assignments without false-positive code/status', () => {
    const text = diagnosticText(
      'https://x.test?p_access=ok&access_token=SECRET&api-key=KEY code=keep status=ok Bearer TOKEN',
    );
    expect(text).toContain('access_token=[redacted]');
    expect(text).toContain('api-key=[redacted]');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('KEY');
    expect(text).toContain('code=keep');
    expect(text).toContain('status=ok');
    expect(text).toContain('Bearer [redacted]');
  });

  test('summarizes nested file envelopes and never emits base64 bytes', () => {
    const value = {
      items: [{ file: { name: 'x.txt', mimeType: 'text/plain', base64: 'c2VjcmV0' } }],
      base64: 'c2VjcmV0',
      ordinary: 'test',
    };
    const result = JSON.stringify(diagnosticResult(value));
    expect(result).toContain('<bytes:6>');
    expect(result).not.toContain('c2VjcmV0');
    expect(result).not.toContain('secret');
    expect(result).toContain('"ordinary":"test"');
  });

  test('bounds wide, deep, long, cyclic, undefined, and bigint values', () => {
    const cycle: Record<string, unknown> = { normal: 'ok' };
    cycle.self = cycle;
    const wide = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`k${index}`, index]),
    );
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let index = 0; index < 100; index++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const rendered = JSON.stringify(
      diagnosticResult({
        cycle,
        wide,
        deep,
        long: 'x'.repeat(20_000),
        missing: undefined,
        big: 1n,
      }),
    );
    expect(rendered.length).toBeLessThanOrEqual(64 * 1024);
    expect(rendered).toContain('[circular]');
    expect(rendered).toContain('[truncated]');
    expect(rendered).toContain('"missing":"[undefined]"');
  });
});
