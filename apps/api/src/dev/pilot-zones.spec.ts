import { describe, expect, it } from 'vitest';

import { pilotZoneSeeds } from './pilot-zones.js';

describe('pilotZoneSeeds', () => {
  it('approves the ten districts in the first Lima wave with valid bounds', () => {
    expect(pilotZoneSeeds.map((zone) => zone.slug)).toEqual([
      'brena',
      'cercado-de-lima',
      'jesus-maria',
      'lince',
      'magdalena-del-mar',
      'rimac',
      'san-borja',
      'san-isidro',
      'san-juan-de-lurigancho',
      'san-martin-de-porres',
    ]);

    for (const { boundary } of pilotZoneSeeds) {
      expect(boundary.minLatitude).toBeLessThan(boundary.maxLatitude);
      expect(boundary.minLongitude).toBeLessThan(boundary.maxLongitude);
    }
  });
});
