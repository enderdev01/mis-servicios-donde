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
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true, reports: 3 },
      { h3Cell: anotherCell, service: 'internet', provider: 'movistar', confirmed: true, reports: 3 },
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
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true, reports: 3 },
      { h3Cell: anotherCell, service: 'water', provider: 'sedapal', confirmed: false, reports: 1 },
    ],
  }));

  await page.goto('/');

  await expect(page.locator(mapBlobs)).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('1 confirmado · 1 sin confirmar.');
  // The list says what the map draws: one area, one row.
  await expect(page.locator('#cell-list .cell-row')).toHaveCount(1);
});

test('renders a pending report dashed and unconfirmed', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false, reports: 1 }],
  }));

  await page.goto('/');

  await expect(page.getByRole('status')).toContainText('1 sin confirmar.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Posible corte de luz, sin confirmar');
  await expect(page.locator(mapBlobs)).toHaveCount(1);
});

test('keeps the outage area geographic while zooming in', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }],
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
    if (!currentMap || !marker) return Number.POSITIVE_INFINITY;
    const mapCentre = { x: currentMap.x + currentMap.width / 2, y: currentMap.y + currentMap.height / 2 };
    const markerCentre = { x: marker.x + marker.width / 2, y: marker.y + marker.height / 2 };
    return Math.hypot(mapCentre.x - markerCentre.x, mapCentre.y - markerCentre.y);
  }).toBeLessThan(60);
});

test('anchors the visitor own cell to the local position', async ({ page }) => {
  await asReturningVisitor(page);
  await page.context().grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:4331' });
  await page.context().setGeolocation({ latitude: -12.0464, longitude: -77.0428 });
  await page.route('**/v1/cells', (route) => route.fulfill({
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }],
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
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [{ h3Cell: '8999999999fffff', service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }] }));

  await page.goto('/');

  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua confirmado');
  await expect(page.locator(mapBlobs)).toHaveCount(0);
});

test('keeps the map empty and the notice standing when nothing is reported', async ({ page }) => {
  await asReturningVisitor(page);
  await page.route('**/v1/cells', (route) => route.fulfill({ json: [] }));

  await page.goto('/');

  await expect(page.getByRole('status')).toContainText('Nadie ha reportado cortes en la zona piloto.');
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

  await expect(page.locator('#map-legend li')).toContainText(['Agua', 'Luz', 'Internet', 'Confirmado', 'Sin confirmar']);
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
      { h3Cell: '898e62c2a9bffff', service: 'water', provider: 'sedapal', confirmed: true, reports: 3 },
      { h3Cell: '898e62c0c5bffff', service: 'electricity', provider: 'luz_del_sur', confirmed: true, reports: 3 },
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
      { h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true, reports: 3 },
      { h3Cell: limaCell, service: 'electricity', provider: 'luz_del_sur', confirmed: false, reports: 1 },
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
  await expect(streets).toContainText('Calles en la zona (aproximado)');
  await expect(streets).toContainText('Avenida Cajatambo');
  await expect(streets).toContainText('Abelardo Gamarra');
  await expect(streets).toContainText('Calle 1');
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
    json: [{ h3Cell: limaCell, service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }],
  }));

  await page.goto('/');
  await page.locator('#cell-list .cell-row').first().click();
  const streets = page.locator('#cell-info-streets');
  await expect(streets).toHaveText('Analizando las posibles calles…');

  releaseLookup();
  await expect(streets).toContainText('Calle 1');
});
