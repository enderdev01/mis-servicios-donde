import { type Page } from '@playwright/test';
import { asReturningVisitor, expect, revealNotice, test } from './fixtures.js';

async function grantLocation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: (success: (position: GeolocationPosition) => void) => success({ coords: { latitude: -12.0464, longitude: -77.0428 } } as GeolocationPosition) },
    });
  });
}

test('submits a report and renders only the public aggregate after confirmation', async ({ page }) => {
  // Returning-user state: this spec exercises the report flow, not the first run.
  await asReturningVisitor(page);
  let reported = false;
  await grantLocation(page);
  await page.route('**/v1/reports', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ services: ['water'], providers: { water: 'sedapal' }, status: 'outage' });
    expect(route.request().postDataJSON()).not.toHaveProperty('name');
    reported = true;
    await route.fulfill({ status: 201, json: { submissionId: 'release-browser-submission', accepted: true } });
  });
  await page.route('**/v1/cells?service=water', async (route) => route.fulfill({
    json: reported ? [{ h3Cell: '8999999999fffff', service: 'water', provider: 'sedapal', confirmed: true, reports: 3, deviceToken: 'never-public' }] : [],
  }));

  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await page.getByLabel('Empresa de agua').selectOption('sedapal');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();
  await expect(page.getByRole('dialog')).toContainText('Gracias por tu reporte');
  await page.getByRole('button', { name: 'Entendido' }).click();

  await page.getByLabel('Ver servicio').selectOption('water');
  await expect(page.getByRole('status')).toContainText('1 confirmado.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toContainText('Corte de agua en una zona cercana');
  await revealNotice(page);
  await expect(page.getByRole('note')).toContainText('No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.');
  await expect(page.locator('body')).not.toContainText('8999999999fffff');
  await expect(page.locator('body')).not.toContainText('never-public');
});

test('keeps the browser private and actionable when rollout APIs are disabled', async ({ page }) => {
  await asReturningVisitor(page);
  await grantLocation(page);
  await page.route('**/v1/cells', async (route) => route.fulfill({ json: [] }));
  await page.route('**/v1/reports', async (route) => route.fulfill({ status: 400, json: { code: 'report_unavailable' } }));

  await page.goto('/');
  await page.getByRole('checkbox', { name: 'Agua' }).check();
  await page.getByLabel('Empresa de agua').selectOption('sedapal');
  await page.getByRole('button', { name: 'Enviar reporte' }).click();

  await expect(page.getByRole('alert')).toContainText('No pudimos enviar tu reporte ahora.');
  await expect(page.getByRole('status')).toContainText('No hay cortes reportados en este momento.');
  await expect(page.getByLabel('Cortes confirmados por zona')).toBeEmpty();
});
