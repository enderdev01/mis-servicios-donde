type H3 = typeof import('h3-js');

// h3-js is an emscripten port: loaded on demand so the first paint, the
// onboarding and the rail never wait for it. Everything below that needs it
// throws until `loadH3()` has resolved.
let h3: H3 | undefined;

export async function loadH3(): Promise<void> {
  h3 ??= await import('h3-js');
}

export function isH3Loaded(): boolean {
  return h3 !== undefined;
}

function requireH3(): H3 {
  if (!h3) throw new Error('h3_not_loaded');
  return h3;
}

export type Service = 'water' | 'electricity' | 'internet';
export type Provider = 'sedapal' | 'luz_del_sur' | 'pluz' | 'movistar' | 'claro' | 'win' | 'wow' | 'mifibra' | 'other';

export interface ProviderOption {
  id: Provider;
  label: string;
}

export interface PublicCell {
  h3Cell: string;
  service: Service;
  provider: Provider;
  confirmed: boolean;
}

export interface CellBlob {
  service: Service;
  provider: Provider;
  /** H3 cells that form one contiguous affected area for this service/provider. */
  h3Cells: string[];
  centre: [number, number];
  /** Privacy-safe visual area covering contiguous H3 cells, regardless of confirmation state. */
  radiusMetres: number;
  confirmed: boolean;
}

export interface ServiceStyle {
  /** Text colour: darkened so it clears 4.5:1 on the pale ground. */
  ink: string;
  stroke: string;
  fill: string;
  label: string;
}

const supportedServices = new Set<string>(['water', 'electricity', 'internet']);

export const serviceStyles: Record<Service, ServiceStyle> = {
  water: { ink: '#0A6C9C', stroke: '#0A6C9C', fill: '#2C9FDA', label: 'Agua' },
  electricity: { ink: '#8A5A00', stroke: '#B47A00', fill: '#F0A81E', label: 'Luz' },
  internet: { ink: '#68399F', stroke: '#68399F', fill: '#9760D8', label: 'Internet' },
};

/** Lima provider catalog. "Other / I don't know" keeps reporting inclusive. */
export const providerOptions: Record<Service, ProviderOption[]> = {
  water: [
    { id: 'sedapal', label: 'Sedapal' },
    { id: 'other', label: 'Otra / No sé' },
  ],
  electricity: [
    { id: 'luz_del_sur', label: 'Luz del Sur' },
    { id: 'pluz', label: 'Pluz Energía' },
    { id: 'other', label: 'Otra / No sé' },
  ],
  internet: [
    { id: 'movistar', label: 'Movistar' },
    { id: 'claro', label: 'Claro' },
    { id: 'win', label: 'Win' },
    { id: 'wow', label: 'Wow' },
    { id: 'mifibra', label: 'MiFibra' },
    { id: 'other', label: 'Otra / No sé' },
  ],
};

/** Lima Metropolitana, the pilot area, shown until reported cells arrive. */
export const defaultCenter: [number, number] = [-12.0464, -77.0428];
export const defaultZoom = 13;

export const basemap = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 18,
};

export const loadingMessage = 'Cargando cortes…';

export function isPublicCell(value: unknown): value is PublicCell {
  if (typeof value !== 'object' || value === null) return false;
  const cell = value as Record<string, unknown>;
  return (
    typeof cell.h3Cell === 'string' &&
    typeof cell.service === 'string' &&
    supportedServices.has(cell.service) &&
    typeof cell.provider === 'string' &&
    isProviderForService(cell.service as Service, cell.provider) &&
    typeof cell.confirmed === 'boolean'
  );
}

/** Projects to the public fields only, so nothing else the API sends is ever held. */
export function toPublicCells(value: unknown): PublicCell[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPublicCell).map((cell) => ({ h3Cell: cell.h3Cell, service: cell.service, provider: cell.provider, confirmed: cell.confirmed }));
}

export function providerLabel(provider: Provider): string {
  for (const options of Object.values(providerOptions)) {
    const option = options.find((entry) => entry.id === provider);
    if (option) return option.label;
  }
  return 'Otra / No sé';
}

export function isProviderForService(service: Service, provider: string): provider is Provider {
  return providerOptions[service].some((option) => option.id === provider);
}

// One report should stay local on the map. The area grows only when another
// report lands in an adjacent H3 cell for the same service and provider.
const cellFootprintRadiusMetres = 120;

/**
 * H3 stays internal: adjacent cells for one service/provider become one soft
 * area, never a drawn hexagon. A report in the same cell increases confidence;
 * a report in an adjacent cell expands the geographic footprint.
 */
export function toCellBlobs(cells: PublicCell[]): CellBlob[] {
  // The clustering is quadratic in neighbour checks and every filter change asks
  // for it several times over the same cells: one entry per distinct input.
  const key = cells.map((cell) => `${cell.service}|${cell.provider}|${cell.h3Cell}|${cell.confirmed ? 1 : 0}`).join(',');
  const cached = blobCache.get(key);
  if (cached) return cached;
  const blobs = clusterCells(cells);
  if (blobCache.size >= blobCacheLimit) blobCache.delete(blobCache.keys().next().value as string);
  blobCache.set(key, blobs);
  return blobs;
}

const blobCache = new Map<string, CellBlob[]>();
const blobCacheLimit = 32;

function clusterCells(cells: PublicCell[]): CellBlob[] {
  const valid = cells.flatMap((cell) => {
    const centre = cellCenter(cell.h3Cell);
    return centre ? [{ cell, centre }] : [];
  });
  const visited = new Set<number>();
  const blobs: CellBlob[] = [];

  for (let index = 0; index < valid.length; index += 1) {
    if (visited.has(index)) continue;
    const cluster: typeof valid = [];
    const pending = [index];
    visited.add(index);

    while (pending.length > 0) {
      const current = pending.shift();
      if (current === undefined) continue;
      const entry = valid[current];
      if (!entry) continue;
      cluster.push(entry);

      for (let candidate = 0; candidate < valid.length; candidate += 1) {
        if (visited.has(candidate)) continue;
        const other = valid[candidate];
        if (!other || other.cell.service !== entry.cell.service || other.cell.provider !== entry.cell.provider || !cellsTouch(entry.cell.h3Cell, other.cell.h3Cell)) continue;
        visited.add(candidate);
        pending.push(candidate);
      }
    }

    const centre = averageCentre(cluster.map((entry) => entry.centre));
    const radiusMetres = Math.max(
      cellFootprintRadiusMetres,
      ...cluster.map((entry) => distanceMetres(centre, entry.centre) + cellFootprintRadiusMetres),
    );
    blobs.push({
      service: cluster[0].cell.service,
      provider: cluster[0].cell.provider,
      h3Cells: cluster.map((entry) => entry.cell.h3Cell),
      centre,
      radiusMetres,
      confirmed: cluster.every((entry) => entry.cell.confirmed),
    });
  }

  return blobs;
}

function cellsTouch(first: string, second: string): boolean {
  if (first === second) return true;
  try {
    return requireH3().areNeighborCells(first, second);
  } catch {
    return false;
  }
}

function averageCentre(centres: [number, number][]): [number, number] {
  const latitude = centres.reduce((total, [value]) => total + value, 0) / centres.length;
  const longitude = centres.reduce((total, [, value]) => total + value, 0) / centres.length;
  return [latitude, longitude];
}

export function boundsOf(blobs: CellBlob[]): [[number, number], [number, number]] | undefined {
  if (blobs.length === 0) return undefined;
  const latitudes = blobs.flatMap((blob) => {
    const delta = (blob.radiusMetres / earthRadiusMetres) * (180 / Math.PI);
    return [blob.centre[0] - delta, blob.centre[0] + delta];
  });
  const longitudes = blobs.flatMap((blob) => {
    const delta = (blob.radiusMetres / (earthRadiusMetres * Math.cos((blob.centre[0] * Math.PI) / 180))) * (180 / Math.PI);
    return [blob.centre[1] - delta, blob.centre[1] + delta];
  });
  return [
    [Math.min(...latitudes), Math.min(...longitudes)],
    [Math.max(...latitudes), Math.max(...longitudes)],
  ];
}

export function describeCell(service: Service, confirmed: boolean): string {
  const kind = serviceStyles[service].label.toLowerCase();
  return confirmed ? `Corte de ${kind} confirmado` : `Posible corte de ${kind}, sin confirmar`;
}

export function summarizeCells(confirmed: number, pending: number): string {
  if (confirmed === 0 && pending === 0) return 'No hay cortes reportados en este momento.';
  const parts: string[] = [];
  if (confirmed > 0) parts.push(`${confirmed} confirmado${confirmed === 1 ? '' : 's'}`);
  if (pending > 0) parts.push(`${pending} sin confirmar`);
  return `${parts.join(' · ')}.`;
}

export function cellCenter(h3Cell: string): [number, number] | undefined {
  const lib = requireH3();
  return lib.isValidCell(h3Cell) ? lib.cellToLatLng(h3Cell) : undefined;
}

/** Checks the visitor's position locally without sending it to the API. */
export function cellContainsPosition(h3Cell: string, position: [number, number]): boolean {
  const lib = requireH3();
  return lib.isValidCell(h3Cell) && lib.latLngToCell(position[0], position[1], lib.getResolution(h3Cell)) === h3Cell;
}

const earthRadiusMetres = 6_371_000;

export function distanceMetres(from: [number, number], to: [number, number]): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLng = toRadians(toLng - fromLng);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMetres * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Reads the way a neighbour says it: metres up close, one decimal past a kilometre. */
export function formatDistance(metres: number): string {
  if (metres < 950) return `a ${(Math.round(metres / 10) * 10).toString()} m`;
  return `a ${kilometres.format(metres / 1000)} km`;
}

const kilometres = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export interface NearbyCell extends PublicCell {
  metres?: number;
}

export interface ZoneBoundary {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export interface ZoneSummary {
  slug: string;
  name: string;
  boundary: ZoneBoundary;
}

/** Same boundary rule as `toPublicCells`: a proxy error page with a 200 must not reach the district filter. */
export function toZones(value: unknown): ZoneSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { slug, name, boundary } = entry as Record<string, unknown>;
    if (typeof slug !== 'string' || typeof name !== 'string' || typeof boundary !== 'object' || boundary === null) return [];
    const { minLatitude, maxLatitude, minLongitude, maxLongitude } = boundary as Record<string, unknown>;
    if (![minLatitude, maxLatitude, minLongitude, maxLongitude].every((number) => typeof number === 'number' && Number.isFinite(number))) return [];
    return [{ slug, name, boundary: { minLatitude, maxLatitude, minLongitude, maxLongitude } as ZoneBoundary }];
  });
}

/** A district box as a Leaflet-ready south-west / north-east pair. */
export function zoneBounds(boundary: ZoneBoundary): [[number, number], [number, number]] {
  return [
    [boundary.minLatitude, boundary.minLongitude],
    [boundary.maxLatitude, boundary.maxLongitude],
  ];
}

export function boundaryContains(boundary: ZoneBoundary, latitude: number, longitude: number): boolean {
  return latitude >= boundary.minLatitude && latitude <= boundary.maxLatitude && longitude >= boundary.minLongitude && longitude <= boundary.maxLongitude;
}

export function cellInZone(h3Cell: string, boundary: ZoneBoundary): boolean {
  const centre = cellCenter(h3Cell);
  return centre ? boundaryContains(boundary, centre[0], centre[1]) : false;
}

/**
 * Sorting happens here, in the browser, from a position the API never receives.
 * Confirmed cells read before pending ones with the same distance: a quorum is
 * more trustworthy than a lone report.
 */
export function sortByProximity(cells: PublicCell[], origin?: [number, number]): NearbyCell[] {
  const order: Service[] = ['water', 'electricity', 'internet'];
  const withDistance = cells.map((cell) => ({ ...cell, metres: origin ? measure(cell.h3Cell, origin) : undefined }));
  return withDistance.sort((a, b) => {
    if (a.metres !== undefined && b.metres !== undefined && a.metres !== b.metres) return a.metres - b.metres;
    if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
    return order.indexOf(a.service) - order.indexOf(b.service);
  });
}

function measure(h3Cell: string, origin: [number, number]): number | undefined {
  const centre = cellCenter(h3Cell);
  return centre ? distanceMetres(origin, centre) : undefined;
}

export interface AreaRow {
  service: Service;
  provider: Provider;
  confirmed: boolean;
  h3Cells: string[];
  centre?: [number, number];
  metres?: number;
}

/** One row per drawn area, the same grouping the map uses; an unmappable index still rows as text. */
export function areaRows(cells: NearbyCell[]): AreaRow[] {
  const areas = toCellBlobs(cells).map((blob) => {
    const distances = cells
      .filter((cell) => cell.service === blob.service && cell.provider === blob.provider && blob.h3Cells.includes(cell.h3Cell))
      .flatMap((cell) => (cell.metres === undefined ? [] : [cell.metres]));
    return { service: blob.service, provider: blob.provider, confirmed: blob.confirmed, h3Cells: blob.h3Cells, centre: blob.centre, metres: distances.length > 0 ? Math.min(...distances) : undefined };
  });
  const unmapped = cells
    .filter((cell) => !cellCenter(cell.h3Cell))
    .map((cell) => ({ service: cell.service, provider: cell.provider, confirmed: cell.confirmed, h3Cells: [cell.h3Cell], centre: undefined, metres: cell.metres }));
  return [...areas, ...unmapped];
}

/** The summary counts what the list shows: areas, never cells. */
export function countAreas(cells: NearbyCell[]): { confirmed: number; pending: number } {
  const rows = areaRows(cells);
  const confirmed = rows.filter((row) => row.confirmed).length;
  return { confirmed, pending: rows.length - confirmed };
}

/** A merged area holds several cells: identical service, company and state read as one row. */
export function dedupeRows<T extends { service: Service; provider: Provider; confirmed: boolean }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.service}|${row.provider}|${row.confirmed ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The H3 cell a position falls in, at the resolution of an already published cell (9 when there is none). */
export function positionCell(position: [number, number], reference?: string): string {
  const lib = requireH3();
  const resolution = reference && lib.isValidCell(reference) ? lib.getResolution(reference) : 9;
  return lib.latLngToCell(position[0], position[1], resolution);
}

const kindOf = (service: Service): string => serviceStyles[service].label.toLowerCase();

function countsAnswer(confirmed: number, pending: number): string {
  const outages = `${confirmed} ${confirmed === 1 ? 'corte confirmado' : 'cortes confirmados'}`;
  const reports = `${pending} ${pending === 1 ? 'reporte sin confirmar' : 'reportes sin confirmar'}`;
  if (pending === 0) return `${outages}.`;
  if (confirmed === 0) return `${reports}. Todavía no hay cortes confirmados.`;
  return `${outages} y ${reports}.`;
}

/**
 * The one line worth reading before anything is expanded. A lone unconfirmed
 * report is never worded as an outage: confirmed areas lead, pending ones say so.
 */
export function leadAnswer(cells: NearbyCell[]): string {
  const rows = areaRows(cells);
  if (rows.length === 0) return 'Sin cortes reportados cerca.';
  const near = rows
    .flatMap((row) => (row.metres === undefined ? [] : [{ ...row, metres: row.metres }]))
    .sort((a, b) => a.metres - b.metres || Number(b.confirmed) - Number(a.confirmed));
  const [nearest] = near;
  if (!nearest) {
    const confirmed = rows.filter((row) => row.confirmed).length;
    return countsAnswer(confirmed, rows.length - confirmed);
  }
  if (nearest.confirmed) return `Corte de ${kindOf(nearest.service)} confirmado ${formatDistance(nearest.metres)}`;
  const confirmedNear = near.find((row) => row.confirmed);
  const pending = `un reporte de ${kindOf(nearest.service)} sin confirmar ${formatDistance(nearest.metres)}`;
  return confirmedNear
    ? `Corte de ${kindOf(confirmedNear.service)} confirmado ${formatDistance(confirmedNear.metres)}. Más cerca, ${pending}.`
    : `Sin cortes confirmados cerca. Hay ${pending}.`;
}
