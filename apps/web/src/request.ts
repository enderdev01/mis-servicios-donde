export const requestTimeoutMs = 10_000;

/** Every API call gets a deadline: on a degraded connection a hung fetch would hold the UI forever. */
export function fetchWithDeadline(input: string, init: RequestInit = {}, timeoutMs = requestTimeoutMs): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** `AbortSignal.timeout` rejects with `TimeoutError`; `AbortError` covers an abort from elsewhere. */
export function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * One submission id per attempt that may still be in flight. The server replays
 * an id it has already seen, so a retry after a lost response must send the same
 * one. The id is bound to the content it was made for: a changed report is a
 * different submission and gets a new id.
 */
export function createSubmissionIds(fresh: () => string = () => crypto.randomUUID()) {
  let current: { signature: string; id: string } | undefined;
  return {
    idFor(signature: string): string {
      if (current?.signature !== signature) current = { signature, id: fresh() };
      return current.id;
    },
    /** Call once the server has answered for real (any HTTP response), so the next report starts clean. */
    settle(): void {
      current = undefined;
    },
  };
}
