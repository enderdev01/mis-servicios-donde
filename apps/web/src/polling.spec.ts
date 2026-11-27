import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startPolling, type VisibilitySource } from './polling.js';

function fakeDocument(state: DocumentVisibilityState = 'visible') {
  let listener: (() => void) | undefined;
  const source = {
    visibilityState: state,
    addEventListener: (_type: 'visibilitychange', handler: () => void) => { listener = handler; },
  };
  return { source: source as VisibilitySource, set: (next: DocumentVisibilityState) => { (source as { visibilityState: DocumentVisibilityState }).visibilityState = next; listener?.(); } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('polling', () => {
  it('runs the task on every interval while visible', async () => {
    const task = vi.fn(() => Promise.resolve());
    startPolling(task, fakeDocument().source, 30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(3);
  });

  it('pauses while hidden and refreshes at once on return', async () => {
    const task = vi.fn(() => Promise.resolve());
    const page = fakeDocument();
    startPolling(task, page.source, 30_000);
    page.set('hidden');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(task).not.toHaveBeenCalled();
    page.set('visible');
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not start when the tab is born hidden', async () => {
    const task = vi.fn(() => Promise.resolve());
    startPolling(task, fakeDocument('hidden').source, 30_000);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(task).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous run is still in flight', async () => {
    let finish: () => void = () => undefined;
    const task = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    startPolling(task, fakeDocument().source, 30_000);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(task).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledTimes(2);
  });
});
