import { afterEach, describe, expect, test } from 'bun:test';
import { previewRequest } from '../../src/request-preview';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('previewRequest', () => {
  test('captures the exact JSON RPC request without calling global fetch', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('network must not be used');
    }) as unknown as typeof fetch;

    await expect(
      previewRequest(['projects', 'create'], { name: 'Demo' }, 'http://127.0.0.1:8787/v1'),
    ).resolves.toEqual({
      method: 'POST',
      url: 'http://127.0.0.1:8787/rpc/v2/business/projects/create',
      headers: {
        authorization: 'Bearer [redacted]',
        'content-type': 'application/json',
      },
      body: { json: { name: 'Demo' } },
    });
    expect(calls).toBe(0);
  });

  test('summarizes RPC multipart files without exposing bytes', async () => {
    const file = new File(['hello'], 'demo.txt', { type: 'text/plain' });
    const result = await previewRequest(
      ['project', 'upload'],
      { projectId: 'project-id', file },
      'https://api.example.test/v1',
    );

    expect(result.method).toBe('POST');
    expect(result.url).toBe('https://api.example.test/rpc/v2/business/project/upload');
    expect(result.body).toMatchObject({
      data: { json: { projectId: 'project-id', file: {} }, maps: [['file']] },
      files: [{ field: '0', name: 'demo.txt', mimeType: 'text/plain;charset=utf-8', size: 5 }],
    });
    expect(JSON.stringify(result.body)).not.toContain('hello');
  });

  test('rejects unsafe paths and credential-bearing servers before capture', async () => {
    await expect(
      previewRequest(['projects', '..', 'admin'], {}, 'https://api.example.test/v1'),
    ).rejects.toThrow();
    await expect(
      previewRequest(['projects', 'list'], {}, 'https://user:pass@api.example.test/v1'),
    ).rejects.toThrow();
  });

  test('propagates abort without using the network', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      previewRequest(['projects', 'list'], {}, 'http://localhost:8787/v1', controller.signal),
    ).rejects.toThrow();
  });
});
