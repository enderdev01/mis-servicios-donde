import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSubmissionIds, fetchWithDeadline, isTimeout } from './request.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('request deadline', () => {
  it('passes an abort signal to fetch', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);
    await fetchWithDeadline('/v1/zones', { method: 'GET' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v1/zones');
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('recognises timeouts and aborts, and nothing else', () => {
    expect(isTimeout(new DOMException('slow', 'TimeoutError'))).toBe(true);
    expect(isTimeout(new DOMException('stop', 'AbortError'))).toBe(true);
    expect(isTimeout(new TypeError('Failed to fetch'))).toBe(false);
    expect(isTimeout(undefined)).toBe(false);
  });
});

describe('submission ids', () => {
  function counter() {
    let count = 0;
    return createSubmissionIds(() => `id-${String(++count)}`);
  }

  it('reuses the id for a retry of the same report', () => {
    const ids = counter();
    expect(ids.idFor('water')).toBe('id-1');
    expect(ids.idFor('water')).toBe('id-1');
  });

  it('issues a new id when the report changed', () => {
    const ids = counter();
    expect(ids.idFor('water')).toBe('id-1');
    expect(ids.idFor('water+electricity')).toBe('id-2');
  });

  it('starts clean after the server answered', () => {
    const ids = counter();
    ids.idFor('water');
    ids.settle();
    expect(ids.idFor('water')).toBe('id-2');
  });
});
