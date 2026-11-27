import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, revealNotice, test } from './fixtures.js';

/** Real resolution-9 indices over the pilot area. */
const limaCell = '898e62c0cdbffff';
const anotherCell = '898e62c01afffff';
const mapBlobs = '#outage-map .leaflet-overlay-pane path';

test('draws one soft blob per reported cell without exposing the index', async ({ page }) => {
  // Returning-user state: this spec exercises the map, not the first run.
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: anotherCell, service: 'internet', provider: 'movistar', confirmed: true },
    ],
  }));

  await page.goto('/');

  await expect(page.getByRole('status')).toContainText('2 confirmados.');
  await expect(page.locator(mapBlobs)).toHaveCount(2);
  await expect(page.locator('body')).not.toContainText(limaCell);
});

test('unifies adjacent reports from the same service into one growing area', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: anotherCell, service: 'water', provider: 'sedapal', confirmed: false },
    ],
  }));

  await page.goto('/');

  await expect(page.locator(mapBlobs)).toHaveCount(1);
  // The summary counts areas, like the list: one area that is not fully confirmed is one unconfirmed area.
  await expect(page.getByRole('status')).toContainText('1 sin confirmar.');
  // The list says what the map draws: one area, one row.
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
});

test('renders a pending report dashed and unconfirmed', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false }],
  }));

  await page.goto('/');

  await expect(page.getByRole('status')).toContainText('1 sin confirmar.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Posible corte de luz, sin confirmar');
  await expect(page.locator(mapBlobs)).toHaveCount(1);
});

test('keeps the outage area geographic while zooming in', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }],
  }));

  await page.goto('/');

  const blob = page.locator(mapBlobs).first();
  await expect(blob).toBeVisible();
  await page.waitForTimeout(600);
  const before = await blob.boundingBox();
  expect(before).not.toBeNull();
  await page.locator('.leaflet-control-zoom-in').click();
  await expect.poll(async () => (await blob.boundingBox())?.width ?? 0).toBeGreaterThan((before?.width ?? 0) + 2);
});

test('repositions on the visitor instead of fitting the whole district', async ({ page }) => {
  await asReturningVisitor(page);
  await page.context().grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:4331' });
  await page.context().setGeolocation({ latitude: -12.0228, longitude: -77.0314 });
  await page.route('**/v1/zones', (route) => route.fulfill({
    json: [{ slug: 'rimac', name: 'Rímac', boundary: { minLatitude: -12.045, maxLatitude: -12.005, minLongitude: -77.05, maxLongitude: -77 } }],
  }));
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');
  const map = page.locator('#outage-map');
  const mapBox = await map.boundingBox();
  expect(mapBox).not.toBeNull();

  await page.mouse.move((mapBox?.x ?? 0) + (mapBox?.width ?? 0) / 2, (mapBox?.y ?? 0) + (mapBox?.height ?? 0) / 2);
  await page.mouse.down();
  await page.mouse.move((mapBox?.x ?? 0) + 120, (mapBox?.y ?? 0) + 80);
  await page.mouse.up();
  await page.locator('.locate-control').click();

  await expect.poll(async () => {
    const currentMap = await map.boundingBox();
    const marker = await page.locator('.me span').boundingBox();
    const rail = await page.locator('#rail').boundingBox();
    if (!currentMap || !marker || !rail) return Number.POSITIVE_INFINITY;
    // The side rail covers the left of the map: the visitor is centred in what remains visible.
    const mapCentre = { x: (rail.x + rail.width + currentMap.x + currentMap.width) / 2, y: currentMap.y + currentMap.height / 2 };
    const markerCentre = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
    return Math.hypot(mapCentre.x - markerCentre.x, mapCentre.y - markerCentre.y);
  }).toBeLessThan(60);
});

test('anchors the visitor own cell to the local position', async ({ page }) => {
  await asReturningVisitor(page);
  await page.context().grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:4331' });
  await page.context().setGeolocation({ latitude: -12.0464, longitude: -77.0428 });
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }],
  }));

  await page.goto('/');
  const blob = page.locator(mapBlobs).first();
  await expect(blob).toBeVisible();
  // Geolocation is never automatic: the visitor's dot appears only after the
  // explicit locate action.
  await page.locator('.locate-control').click();
  await expect(page.locator('.me span')).toBeVisible();

  await expect.poll(async () => {
    const area = await blob.boundingBox();
    const marker = await page.locator('.me span').boundingBox();
    if (!area || !marker) return Number.POSITIVE_INFINITY;
    const areaCentre = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    const markerCentre = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
    return Math.hypot(areaCentre.x - markerCentre.x, areaCentre.y - markerCentre.y);
  }).toBeLessThan(5);
});

test('lists a malformed cell as text but refuses to map it', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [{ h3Cell: '8999999999fffff', service: 'water', provider: 'sedapal', confirmed: true }] }));

  await page.goto('/');

  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua confirmado');
  await expect(page.locator(mapBlobs)).toHaveCount(0);
});

test('keeps the map empty and the notice standing when nothing is reported', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');

  await expect(page.getByRole('status')).toContainText('Nadie ha reportado cortes en los distritos con cobertura.');
  await expect(page.getByRole('button', { name: 'Reportar un corte' })).toBeVisible();
  await expect(page.locator(mapBlobs)).toHaveCount(0);
  await revealNotice(page);
  await expect(page.getByRole('note')).toContainText('no oficial');
});

test('says so when the cells cannot be loaded instead of reading as no outages', async ({ page }) => {
  await asReturningVisitor(page);
  // Not routed: the fixture aborts every /v1 call, which is a network failure.

  await page.goto('/');

  await expect(page.locator('#answer')).toContainText('No pudimos cargar los cortes.');
  await expect(page.getByRole('status')).toContainText('No pudimos cargar los cortes ahora.');
  await expect(page.getByRole('status')).not.toContainText('Nadie ha reportado');
  await expect(page.getByRole('button', { name: 'Reintentar' })).toBeVisible();
});

test('retries the load from the failure state', async ({ page }) => {
  await asReturningVisitor(page);
  let attempts = 0;
  await page.route('**/v1/cells', (route) => {
    attempts += 1;
    return attempts === 1
      ? route.abort()
      : route.fulfill({ json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }] });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Reintentar' }).click();

  await expect(page.getByRole('status')).toContainText('1 confirmado.');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
});

test('explains what each service colour means', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');

  // Two keys on two lines: which service, and how sure.
  await expect(page.locator('#map-legend li')).toContainText(['Agua', 'Luz', 'Internet']);
  await expect(page.locator('#map-legend-states li')).toContainText(['Confirmado', 'Sin confirmar']);
});

test('centres on a district and filters its reports', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/zones', (route) => route.fulfill({
    json: [
      { slug: 'rimac', name: 'Rímac', boundary: { minLatitude: -12.045, maxLatitude: -12.005, minLongitude: -77.05, maxLongitude: -77 } },
      { slug: 'brena', name: 'Breña', boundary: { minLatitude: -12.07, maxLatitude: -12.045, minLongitude: -77.06, maxLongitude: -77.035 } },
    ],
  }));
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: '898e62c2a9bffff', service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: '898e62c0c5bffff', service: 'electricity', provider: 'luz_del_sur', confirmed: true },
    ],
  }));

  await page.goto('/');

  const district = page.getByLabel('Ver distrito');
  await expect(district.locator('option')).toHaveCount(3);
  await expect(district).toHaveValue('all');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de luz');

  await district.selectOption('rimac');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua');
  await expect(page.getByLabel('Cortes confirmados por zona')).not.toContainText('Corte de luz');

  await district.selectOption('all');
  await page.getByLabel('Ver empresa').selectOption('luz_del_sur');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de luz');
  await expect(page.getByLabel('Cortes confirmados por zona')).not.toContainText('Corte de agua');
});

test('opens a modal with every stacked report, state only, and no street lookup while one is unconfirmed', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**overpass-api.de/api/interpreter', (route) => route.fulfill({
    json: {
      elements: [
        { tags: { name: 'Avenida Cajatambo' } },
        { tags: { name: 'Abelardo Gamarra' } },
        { tags: { name: 'Calle 1' } },
        { tags: { name: 'Avenida Cajatambo' } },
      ],
    },
  }));
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false },
    ],
  }));

  await page.goto('/');

  await page.locator('#cell-list .cell-row').first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Agua');
  await expect(dialog).toContainText('Luz');
  await expect(dialog).toContainText('Sedapal');
  await expect(dialog).toContainText('Luz del Sur');
  await expect(dialog).toContainText('Confirmado');
  await expect(dialog).toContainText('Sin confirmar');
  await expect(dialog).not.toContainText('vecino');
  await expect(dialog).toContainText('Información sobre cortes generada por la comunidad, no oficial.');
  // One unconfirmed report in the group: street names would point at its block.
  await expect(page.locator('#cell-info-streets')).toBeHidden();
});

test('lists approximate streets only when every report in the area is confirmed', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**overpass-api.de/api/interpreter', (route) => route.fulfill({
    json: {
      elements: [
        { tags: { name: 'Avenida Cajatambo' } },
        { tags: { name: 'Abelardo Gamarra' } },
        { tags: { name: 'Calle 1' } },
        { tags: { name: 'Avenida Cajatambo' } },
      ],
    },
  }));
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: true },
    ],
  }));

  await page.goto('/');

  await page.locator('#cell-list .cell-row').first().click();
  const streets = page.locator('#cell-info-streets');
  await expect(streets).toContainText('Calles en esta área (aproximado)');
  await expect(streets).toContainText('Avenida Cajatambo');
  await expect(streets).toContainText('Abelardo Gamarra');
  await expect(streets).toContainText('Calle 1');
});

const rimacZone = { slug: 'rimac', name: 'Rímac', boundary: { minLatitude: -12.045, maxLatitude: -12.005, minLongitude: -77.05, maxLongitude: -77 } };
const brenaZone = { slug: 'brena', name: 'Breña', boundary: { minLatitude: -12.07, maxLatitude: -12.045, minLongitude: -77.06, maxLongitude: -77.035 } };
/** Far outside both boxes above, and away from every fixture cell. */
const sanJuanZone = { slug: 'sjl', name: 'San Juan de Lurigancho', boundary: { minLatitude: -12.0, maxLatitude: -11.9, minLongitude: -77.0, maxLongitude: -76.9 } };
const rimacCell = '898e62c2a9bffff';
const brenaCell = '898e62c0c5bffff';

async function shareLocation(page: Page, latitude: number, longitude: number): Promise<void> {
  await page.context().grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:4331' });
  await page.context().setGeolocation({ latitude, longitude });
}

async function openMobileSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Ver el panel' }).click();
  await expect(page.locator('#rail')).toHaveCSS('transform', /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
}

test('lists one row per service, company and state in a merged area dialog', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**overpass-api.de/**', (route) => route.abort());
  await page.route('**nominatim.openstreetmap.org/**', (route) => route.abort());
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: anotherCell, service: 'water', provider: 'sedapal', confirmed: true },
    ],
  }));

  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();

  await expect(page.locator('#cell-info-list li')).toHaveCount(1);
  await expect(page.locator('#cell-info-title')).toHaveText('Cortes en esta área');
});

test('titles a dialog over an unconfirmed report as a report, not an outage', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false }],
  }));

  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();

  await expect(page.locator('#cell-info-title')).toHaveText('Reportes en esta área');
  await expect(page.locator('#outage-map')).toHaveAttribute('aria-label', /reportes sin confirmar/);
});

test('answers with the confirmed outage first and counts reports apart', async ({ page }) => {
  await asReturningVisitor(page);
  await shareLocation(page, -12.0464, -77.0428);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false },
      { h3Cell: rimacCell, service: 'water', provider: 'sedapal', confirmed: true },
    ],
  }));

  await page.goto('/');
  // No position yet: a lone report is not an outage, and the next step is a button.
  await expect(page.locator('#answer')).toContainText('1 corte confirmado y 1 reporte sin confirmar.');
  await page.getByRole('button', { name: 'Ver lo más cerca de mí' }).click();

  await expect(page.locator('#answer')).toContainText('Corte de agua confirmado');
  await expect(page.locator('#answer')).toContainText('Más cerca, un reporte de luz sin confirmar');
  await expect(page.locator('#answer')).not.toContainText('Lo más cerca');
  await expect(page.getByRole('button', { name: 'Ver lo más cerca de mí' })).toHaveCount(0);
});

test('says plainly that the visitor is outside the covered districts and refuses to send', async ({ page }) => {
  await asReturningVisitor(page);
  await shareLocation(page, -12.1215, -77.03);
  await page.route('**/v1/zones', (route) => route.fulfill({ json: [rimacZone, brenaZone] }));
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: rimacCell, service: 'water', provider: 'sedapal', confirmed: true }],
  }));

  await page.goto('/');
  await page.locator('.locate-control').click();

  await expect(page.locator('#answer')).toContainText('Tu ubicación está fuera de los distritos con cobertura.');
  await expect(page.locator('#map-state')).toContainText('Distritos con cobertura: Rímac, Breña.');
  await expect(page.locator('#coverage-note')).toBeVisible();
  await expect(page.locator('#submit')).toBeDisabled();
  await expect(page.locator('#submit')).toHaveAttribute('aria-describedby', 'coverage-note');
});

test('names the covered districts when nothing is reported at all', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/zones', (route) => route.fulfill({ json: [rimacZone, brenaZone] }));
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');

  await expect(page.locator('#map-state')).toContainText('Nadie ha reportado cortes en los distritos con cobertura (Rímac, Breña).');
  await expect(page.locator('#filters-box')).toBeHidden();
});

test('says where the rest is when the chosen district is empty', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/zones', (route) => route.fulfill({ json: [rimacZone, brenaZone, sanJuanZone] }));
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: rimacCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: brenaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: true },
    ],
  }));

  await page.goto('/');
  await page.getByLabel('Ver distrito').selectOption('sjl');

  await expect(page.locator('#map-state')).toContainText('Nadie ha reportado cortes en San Juan de Lurigancho. Hay 2 áreas con reportes en otros distritos.');
  await expect(page.locator('#map-state')).not.toContainText('No hay cortes reportados en este momento.');
  await expect(page.getByRole('button', { name: 'Reportar un corte' })).toBeVisible();
  await page.getByRole('button', { name: 'Ver todos los distritos' }).click();
  await expect(page.getByLabel('Ver distrito')).toHaveValue('all');
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(2);
});

test('frames the areas inside what the side rail leaves visible', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: rimacCell, service: 'internet', provider: 'movistar', confirmed: true },
    ],
  }));

  await page.goto('/');
  await expect(page.locator(mapBlobs)).toHaveCount(2);
  await page.waitForTimeout(600);

  const railBox = await page.locator('#rail').boundingBox();
  expect(railBox).not.toBeNull();
  const lefts = await page.locator(mapBlobs).evaluateAll((paths) => paths.map((path) => path.getBoundingClientRect().left));
  for (const left of lefts) expect(left).toBeGreaterThanOrEqual((railBox?.x ?? 0) + (railBox?.width ?? 0));
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('tapping a row folds the sheet so the map is visible', async ({ page }) => {
    await asReturningVisitor(page);
    await page.route('**overpass-api.de/**', (route) => route.abort());
    await page.route('**/v1/cells', (route) => route.fulfill({
      json: [{ h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false }],
    }));

    await page.goto('/');
    await openMobileSheet(page);
    await page.getByRole('tab', { name: 'Reportes' }).click();
    await page.locator('#cell-list .cell-row').first().click();

    await expect(page.locator('#rail')).toHaveAttribute('data-state', 'peek');
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('puts the list above the filters, and the filters behind one closed summary', async ({ page }) => {
    await asReturningVisitor(page);
    await page.route('**/v1/zones', (route) => route.fulfill({ json: [rimacZone, brenaZone] }));
    await page.route('**/v1/cells', (route) => route.fulfill({
      json: [{ h3Cell: rimacCell, service: 'water', provider: 'sedapal', confirmed: true }],
    }));

    await page.goto('/');
    await openMobileSheet(page);
    await page.getByRole('tab', { name: 'Reportes' }).click();

    const row = await page.locator('#cell-list .cell-row').first().boundingBox();
    // It started at y=694 behind five controls; now the list is the first thing under the status line.
    expect(row?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(600);
    await expect(page.getByLabel('Ver distrito')).toBeHidden();
    await page.getByText('Filtrar (distrito, servicio, empresa)').click();
    await expect(page.getByLabel('Ver distrito')).toBeVisible();
    await page.getByLabel('Ver distrito').selectOption('rimac');
    await expect(page.locator('#filters-summary')).toHaveText('Filtrar (Rímac)');
  });

  test('offers the locate button inside the peeking sheet, not below it', async ({ page }) => {
    await asReturningVisitor(page);
    await page.route('**/v1/cells', (route) => route.fulfill({
      json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }],
    }));

    await page.goto('/');

    const locateButton = page.getByRole('button', { name: 'Ver lo más cerca de mí' });
    await expect(locateButton).toBeVisible();
    const button = await locateButton.boundingBox();
    expect((button?.y ?? 0) + (button?.height ?? 0)).toBeLessThanOrEqual(844);
  });
});

test('lets a returning visitor see the site name and replay how it works', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');

  await expect(page.locator('#identity-toggle')).toContainText('Mis Servicios');
  await revealNotice(page);
  await page.getByRole('button', { name: 'Ver cómo funciona' }).click();
  await expect(page.locator('#onboarding')).toBeVisible();
  await expect(page.locator('#onboarding')).toContainText('Paso 1 de 4');
});

test('shows a confirmed area heavier than a pending one and stacks glyphs that share a centre', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true },
      { h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false },
    ],
  }));

  await page.goto('/');

  await expect(page.locator(mapBlobs)).toHaveCount(2);
  // One marker, two glyphs: the water one is not hidden under the light one.
  await expect(page.locator('#outage-map .blob-glyph')).toHaveCount(1);
  await expect(page.locator('#outage-map .blob-glyph .g')).toHaveCount(2);
  await expect(page.locator('#outage-map .blob-glyph .g.confirmed')).toHaveCount(1);
  await expect(page.locator(`${mapBlobs}.cell[stroke-dasharray]`)).toHaveCount(1);
});

test('shows street analysis while nearby data is loading', async ({ page }) => {
  await asReturningVisitor(page);
  let releaseLookup: () => void = () => {};
  const lookupReleased = new Promise<void>((resolve) => { releaseLookup = resolve; });
  await page.route('**overpass-api.de/api/interpreter', async (route) => {
    await lookupReleased;
    await route.fulfill({ json: { elements: [{ tags: { name: 'Calle 1' } }] } });
  });
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true }],
  }));

  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();
  const streets = page.locator('#cell-info-streets');
  await expect(streets).toHaveText('Analizando las posibles calles…');

  releaseLookup();
  await expect(streets).toContainText('Calle 1');
});
