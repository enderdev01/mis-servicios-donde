import { asReturningVisitor, expect, test } from './fixtures.js';

test('serves the static public foundation', async ({ request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  await expect(response.text()).resolves.toContain('Información sobre cortes generada por la comunidad, no oficial.');
});

test('offers an unofficial filtered map and accessible report validation', async ({ page }) => {
  // Returning-user state: this spec exercises the map and panel, not the first run.
  await asReturningVisitor(page);
  await page.route('**/v1/cells?service=water', (route) => route.fulfill({ json: [{ h3Cell: '8999999999fffff', service: 'water', provider: 'sedapal', confirmed: true, reports: 3 }] }));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '¿Es solo tu casa?' })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.');
  await expect(page.getByLabel('Ver servicio')).toHaveValue('all');
  await expect(page.getByRole('status')).toContainText('No hay cortes reportados en este momento.');

  await page.getByLabel('Ver servicio').selectOption('water');
  await expect(page.getByRole('status')).toContainText('1 confirmado.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua en una zona cercana');

  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.getByRole('alert')).toContainText('Elige al menos un servicio afectado.');
});

test('keeps the identity notice permanently visible in every state', async ({ page }) => {
  await asReturningVisitor(page);
  await page.goto('/');

  const identity = page.locator('#site-identity');
  await expect(identity).toBeVisible();
  await expect(identity.getByRole('note')).toBeVisible();
  // Past the old 3.5s auto-hide window: the notice now never yields the map.
  await page.waitForTimeout(4_500);
  await expect(identity).toBeVisible();
  await expect(identity.getByRole('note')).toBeVisible();
});
