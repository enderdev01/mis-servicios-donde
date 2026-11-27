/**
 * How old the data on screen is, from the client's own clock. Coarse on purpose:
 * the text sits in a live region, so it should change at most once a minute.
 * The API carries no report times by design; this is the query time only.
 */
export function formatFreshness(loadedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - loadedAt) / 60_000);
  if (minutes < 1) return 'Actualizado hace un momento';
  if (minutes < 60) return `Actualizado hace ${minutes} min`;
  return `Actualizado hace ${Math.floor(minutes / 60)} h`;
}
