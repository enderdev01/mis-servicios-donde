export const pollIntervalMs = 30_000;

/** The slice of `document` the poller needs, so it can be tested outside the browser. */
export interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Runs `task` every `intervalMs` while the tab is visible. A hidden tab stops
 * polling (battery, data); coming back refreshes at once and restarts the clock.
 * A tick is skipped while the previous run is still in flight.
 */
export function startPolling(task: () => Promise<void>, source: VisibilitySource = document, intervalMs = pollIntervalMs): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  const run = (): void => {
    if (running) return;
    running = true;
    void task().finally(() => { running = false; });
  };
  const start = (): void => {
    stop();
    timer = setInterval(run, intervalMs);
  };
  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  source.addEventListener('visibilitychange', () => {
    if (source.visibilityState === 'hidden') { stop(); return; }
    run();
    start();
  });
  if (source.visibilityState !== 'hidden') start();
}
