function configuredPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const quorumSize = configuredPositiveInteger('OUTAGE_QUORUM_DEVICES', 3);
export const quorumWindowMinutes = configuredPositiveInteger('OUTAGE_QUORUM_WINDOW_MINUTES', 60);
export const episodeLifetimeHours = configuredPositiveInteger('OUTAGE_EPISODE_LIFETIME_HOURS', 6);

export function isQuorumThresholdCrossing(previousVotes: number, currentVotes: number): boolean {
  return previousVotes < quorumSize && currentVotes >= quorumSize;
}

export function shouldRestoreEpisode(input: { active: boolean; restoredVotesAfterOpening: number; activeOutageSignals: number }): boolean {
  return input.active
    && input.restoredVotesAfterOpening >= quorumSize
    && input.restoredVotesAfterOpening >= input.activeOutageSignals;
}

export function orderedLockKeys(entries: [string, string][]): string[] {
  return [...new Set(entries.map(([cell, service]) => `${cell}:${service}`))].sort();
}
