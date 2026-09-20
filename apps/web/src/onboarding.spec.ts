import { describe, expect, it } from 'vitest';

import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION, persistOnboardingStatus, shouldShowOnboarding } from './onboarding.js';

describe('onboarding persistence', () => {
  it('shows the onboarding on a first visit', () => {
    expect(shouldShowOnboarding(null)).toBe(true);
    expect(shouldShowOnboarding('')).toBe(true);
  });

  it('shows the onboarding when the stored value is corrupt', () => {
    expect(shouldShowOnboarding('not json')).toBe(true);
    expect(shouldShowOnboarding('{"status":"completed"}')).toBe(true);
    expect(shouldShowOnboarding('{"version":1}')).toBe(true);
  });

  it('shows the onboarding again when the stored record is from an older version', () => {
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION - 1, status: 'completed' }))).toBe(true);
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION - 1, status: 'skipped' }))).toBe(true);
  });

  it('stays closed after completion', () => {
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION, status: 'completed' }))).toBe(false);
  });

  it('stays closed after skipping', () => {
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION, status: 'skipped' }))).toBe(false);
  });

  it('trusts a newer-version record instead of replaying this older flow', () => {
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION + 1, status: 'completed' }))).toBe(false);
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION + 1, status: 'skipped' }))).toBe(false);
    // A newer version without a readable status is still unread: replay.
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION + 1 }))).toBe(true);
  });

  it('treats an unknown status as unseen', () => {
    expect(shouldShowOnboarding(JSON.stringify({ version: ONBOARDING_VERSION, status: 'mystery' }))).toBe(true);
  });

  it('persists a versioned record a later load can read back', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };

    persistOnboardingStatus(storage, 'completed');
    expect(store.get(ONBOARDING_STORAGE_KEY)).toBe(JSON.stringify({ version: ONBOARDING_VERSION, status: 'completed' }));
    expect(shouldShowOnboarding(storage.getItem(ONBOARDING_STORAGE_KEY))).toBe(false);

    persistOnboardingStatus(storage, 'skipped');
    expect(shouldShowOnboarding(storage.getItem(ONBOARDING_STORAGE_KEY))).toBe(false);
  });
});
