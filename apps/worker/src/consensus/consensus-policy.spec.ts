import { describe, expect, it } from 'vitest';

import { isQuorumThresholdCrossing, orderedLockKeys, shouldRestoreEpisode } from './consensus-policy.js';

describe('consensus policy', () => {
  it('recognizes only the transition to three distinct votes as a quorum', () => {
    expect(isQuorumThresholdCrossing(2, 3)).toBe(true);
    expect(isQuorumThresholdCrossing(3, 4)).toBe(false);
    expect(isQuorumThresholdCrossing(1, 2)).toBe(false);
  });

  it('restores only an active episode after a qualifying restored quorum', () => {
    expect(shouldRestoreEpisode({ active: true, restoredVotesAfterOpening: 3, activeOutageSignals: 3 })).toBe(true);
    expect(shouldRestoreEpisode({ active: true, restoredVotesAfterOpening: 3, activeOutageSignals: 2 })).toBe(true);
    expect(shouldRestoreEpisode({ active: true, restoredVotesAfterOpening: 3, activeOutageSignals: 4 })).toBe(false);
    expect(shouldRestoreEpisode({ active: true, restoredVotesAfterOpening: 2, activeOutageSignals: 2 })).toBe(false);
    expect(shouldRestoreEpisode({ active: false, restoredVotesAfterOpening: 3, activeOutageSignals: 3 })).toBe(false);
  });

  it('deduplicates and orders cell-service locks deterministically', () => {
    expect(orderedLockKeys([['cell-b', 'water'], ['cell-a', 'internet'], ['cell-b', 'water']]))
      .toEqual(['cell-a:internet', 'cell-b:water']);
  });
});
