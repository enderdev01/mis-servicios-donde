export interface PilotZoneSeed {
  slug: string;
  name: string;
  boundary: {
    minLatitude: number;
    maxLatitude: number;
    minLongitude: number;
    maxLongitude: number;
  };
}

/**
 * First-wave Lima coverage. These are deliberately simple operational bounding
 * boxes, not administrative polygons; see the README before using them to make
 * a district-level attribution claim near a shared border.
 */
export const pilotZoneSeeds: readonly PilotZoneSeed[] = [
  { slug: 'brena', name: 'Breña', boundary: { minLatitude: -12.070, maxLatitude: -12.045, minLongitude: -77.060, maxLongitude: -77.035 } },
  { slug: 'cercado-de-lima', name: 'Cercado de Lima', boundary: { minLatitude: -12.060, maxLatitude: -12.035, minLongitude: -77.045, maxLongitude: -77.020 } },
  { slug: 'jesus-maria', name: 'Jesús María', boundary: { minLatitude: -12.095, maxLatitude: -12.070, minLongitude: -77.065, maxLongitude: -77.040 } },
  { slug: 'lince', name: 'Lince', boundary: { minLatitude: -12.095, maxLatitude: -12.070, minLongitude: -77.060, maxLongitude: -77.030 } },
  { slug: 'magdalena-del-mar', name: 'Magdalena del Mar', boundary: { minLatitude: -12.105, maxLatitude: -12.075, minLongitude: -77.090, maxLongitude: -77.055 } },
  { slug: 'rimac', name: 'Rímac', boundary: { minLatitude: -12.045, maxLatitude: -12.005, minLongitude: -77.050, maxLongitude: -77.000 } },
  { slug: 'san-borja', name: 'San Borja', boundary: { minLatitude: -12.120, maxLatitude: -12.080, minLongitude: -77.025, maxLongitude: -76.975 } },
  { slug: 'san-isidro', name: 'San Isidro', boundary: { minLatitude: -12.115, maxLatitude: -12.085, minLongitude: -77.070, maxLongitude: -77.025 } },
  { slug: 'san-juan-de-lurigancho', name: 'San Juan de Lurigancho', boundary: { minLatitude: -12.085, maxLatitude: -11.900, minLongitude: -77.030, maxLongitude: -76.900 } },
  { slug: 'san-martin-de-porres', name: 'San Martín de Porres', boundary: { minLatitude: -12.080, maxLatitude: -11.950, minLongitude: -77.100, maxLongitude: -77.020 } },
];
