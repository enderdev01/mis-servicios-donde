export const ONBOARDING_STORAGE_KEY = 'mis-servicios:onboarding';
export const ONBOARDING_VERSION = 1;

export type OnboardingStatus = 'completed' | 'skipped';

/** Minimal storage surface so the behaviour stays testable outside the browser. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Reads the locally persisted first-run decision. Missing, corrupt and
 * older-version records reopen the onboarding, only a current-version
 * completion or skip keeps it closed, and a newer-version record is trusted:
 * a future flow must never replay this older one over a decision the visitor
 * already made.
 */
export function shouldShowOnboarding(raw: string | null): boolean {
  if (!raw) return true;
  try {
    const record = JSON.parse(raw) as { version?: unknown; status?: unknown };
    if (typeof record.version !== 'number' || (record.status !== 'completed' && record.status !== 'skipped')) return true;
    if (record.version > ONBOARDING_VERSION) return false;
    return record.version !== ONBOARDING_VERSION;
  } catch {
    return true;
  }
}

/** Writes a versioned record so a future flow redesign can replay cleanly. */
export function persistOnboardingStatus(storage: StorageLike, status: OnboardingStatus): void {
  storage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({ version: ONBOARDING_VERSION, status }));
}
