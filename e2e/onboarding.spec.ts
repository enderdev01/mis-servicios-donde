import { type Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

interface GeoSpy {
  count: () => Promise<number>;
}

/**
 * Replaces the geolocation API with a counting stub so tests can assert that
 * no permission request is triggered before an explicit visitor action, and
 * drive grant, denial and a never-settling permission prompt.
 */
async function spyGeolocation(page: Page, outcome: 'granted' | 'pending' | 'denied'): Promise<GeoSpy> {
  await page.addInitScript((outcome: string) => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: (position: GeolocationPosition) => void, error: (err: GeolocationPositionError) => void) => {
          const win = window as typeof window & { __geoCalls?: number };
          win.__geoCalls = (win.__geoCalls ?? 0) + 1;
          if (outcome === 'denied') error({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
          if (outcome === 'granted') success({
            coords: { latitude: -12.0464, longitude: -77.0428, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
            timestamp: Date.now(),
          } as GeolocationPosition);
        },
      },
    });
  }, outcome);
  return { count: () => page.evaluate(() => (window as typeof window & { __geoCalls?: number }).__geoCalls ?? 0) };
}

test('walks a first visit through four illustrated steps', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();
  await expect(onboarding.locator('.onboarding-title')).toContainText('Un mapa hecho por vecinos');
  await expect(onboarding.locator('.onboarding-figure img')).toBeVisible();
  await expect(onboarding.locator('.onboarding-figure img')).toHaveAttribute('alt', /vecinos/);
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 1 de 4');
  await expect(page.getByRole('note')).toContainText('No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.');

  await expect(onboarding.getByRole('button', { name: 'Anterior' })).toBeDisabled();
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-title')).toContainText('Tu ubicación, usada una sola vez');
  await expect(onboarding.getByRole('button', { name: 'Activar ubicación' })).toBeVisible();

  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-title')).toContainText('Reporta en dos toques');
  await expect(onboarding.locator('.onboarding-body')).toContainText('No hay servicio');

  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-title')).toContainText('Cómo se publica tu reporte');
  await expect(onboarding.locator('.onboarding-body')).toContainText('sin confirmar');
  await expect(onboarding.locator('.onboarding-body')).toContainText('tres vecinos distintos');
  await expect(onboarding.locator('.onboarding-body')).toContainText('cada hora');
  await expect(onboarding.locator('.onboarding-body')).toContainText('zonas piloto');
});

test('fades between steps and still lands on every step with rapid clicks', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });

  // The illustration and the content column carry a real opacity transition, so
  // a step change reads as a fade rather than an instant swap.
  const durations = await page.evaluate(() => ({
    stage: getComputedStyle(document.querySelector('.onboarding-stage')!).transitionDuration,
    content: getComputedStyle(document.querySelector('.onboarding-content')!).transitionDuration,
  }));
  expect(durations.stage).not.toBe('0s');
  expect(durations.content).not.toBe('0s');

  // A step change dims the current slide out before swapping. Rapid clicks are
  // queued, so none of the three forward moves is dropped.
  const next = onboarding.getByRole('button', { name: 'Siguiente' });
  await next.click();
  await page.locator('.onboarding-card[data-fade="out"]').waitFor({ state: 'attached' });
  await next.click();
  await next.click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 4 de 4');
  await expect(page.locator('.onboarding-card[data-fade="out"]')).toHaveCount(0);
});

test('reveals the new illustration only once it is decoded', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();

  // Every step illustration is fetched at open, so a move never has to wait on
  // the network and the reused <img> is not left painting the previous bitmap.
  await page.waitForFunction(() => {
    const loaded = performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/onboarding/'));
    return new Set(loaded.map((entry) => entry.name)).size >= 4;
  });

  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 2 de 4');
  const image = await page.evaluate(() => {
    const img = document.querySelector('.onboarding-figure img') as HTMLImageElement;
    return { src: img.getAttribute('src'), complete: img.complete, naturalWidth: img.naturalWidth };
  });
  expect(image.src).toBe('/onboarding/2onboard.webp');
  expect(image.complete).toBe(true);
  expect(image.naturalWidth).toBeGreaterThan(0);
});

test('fades the surface out before entering the app', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  for (let step = 0; step < 3; step += 1) await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 4 de 4');

  const layerDuration = await page.evaluate(
    () => getComputedStyle(document.querySelector('#onboarding')!).transitionDuration,
  );
  expect(layerDuration).not.toBe('0s');

  // Leaving the last step dissolves the whole surface before it is removed.
  await onboarding.getByRole('button', { name: 'Empezar a usar el mapa' }).click();
  await expect(page.locator('#onboarding[data-closing="true"]')).toHaveCount(1);
  await expect(onboarding).toBeHidden();
  await expect(page.locator('#onboarding[data-closing="true"]')).toHaveCount(0);
});

test('skips the slide fade under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  const durations = await page.evaluate(() => ({
    stage: getComputedStyle(document.querySelector('.onboarding-stage')!).transitionDuration,
    layer: getComputedStyle(document.querySelector('#onboarding')!).transitionDuration,
  }));
  expect(durations.stage).toBe('0s');
  expect(durations.layer).toBe('0s');

  // Navigation stays correct without the animation.
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 2 de 4');
  await expect(page.locator('.onboarding-card[data-fade="out"]')).toHaveCount(0);
});

test('never requests geolocation before the visitor activates it', async ({ page }) => {
  const geo = await spyGeolocation(page, 'pending');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Introducción al mapa comunitario' })).toBeVisible();
  expect(await geo.count()).toBe(0);

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  expect(await geo.count()).toBe(0);

  await onboarding.getByRole('button', { name: 'Activar ubicación' }).click();
  await expect.poll(() => geo.count()).toBe(1);

  await onboarding.getByRole('button', { name: 'Omitir' }).click();
  await expect(onboarding).toBeHidden();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Introducción al mapa comunitario' })).toBeHidden();
});

test('keeps the onboarding open on the location step after a successful activation', async ({ page }) => {
  // Mobile is where the step navigation can slide out of reach once the
  // success state adds content, so the contract is measured at 390x844.
  await page.setViewportSize({ width: 390, height: 844 });
  const geo = await spyGeolocation(page, 'granted');
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await onboarding.getByRole('button', { name: 'Activar ubicación' }).click();
  await expect.poll(() => geo.count()).toBe(1);

  // Success is a state inside the step, never an early completion.
  await expect(onboarding).toBeVisible();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 2 de 4');
  await expect(onboarding.locator('.onboarding-success')).toContainText('Ubicación activada');

  // Success is a real polite live region, and keyboard/AT users continue from
  // it: focus moves onto the status once activation settles.
  await expect(onboarding.locator('.onboarding-success')).toHaveAttribute('role', 'status');
  await expect(onboarding.locator('.onboarding-success')).toHaveAttribute('aria-live', 'polite');
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains('onboarding-success') ?? false),
  ).toBe(true);

  // The step navigation stays visible and hit-test reachable in the success
  // state, exactly as it was before activation.
  await assertNavigationReachable(page);

  // Default-scroll readability: the inserted success copy must be fully
  // readable right where the transition leaves the scroll — never painted
  // over by the nav footer and never clipped by the card.
  await assertFeedbackUnobscured(page, '.onboarding-success', 'the activation success copy');

  // The success status is focused by script after a pointer activation, so it
  // must not paint a ring on the mouse path — the status stays focused and
  // reachable for assistive technology either way.
  const statusOutlineStyle = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.querySelector('.onboarding-success')!).outlineStyle);
  expect(
    await statusOutlineStyle(),
    'no forced ring on the success status after a pointer activation',
  ).toBe('none');

  // Activation alone persists nothing: a reload replays the flow.
  expect(await page.evaluate(() => localStorage.getItem('mis-servicios:onboarding'))).toBeNull();
  await page.reload();
  await expect(onboarding).toBeVisible();

  // The replay also proves the keyboard path: navigating and activating with
  // real key presses is genuine keyboard input, so the success status paints
  // its focus indicator when the script hands it focus. The heading keeps its
  // programmatic focus on the keyboard-driven step change, but unpainted.
  await page.keyboard.press('Tab'); // heading -> Omitir
  await page.keyboard.press('Tab'); // Omitir -> Siguiente (Anterior is disabled)
  await page.keyboard.press('Enter'); // -> Paso 2
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 2 de 4');
  await page.keyboard.press('Tab'); // heading -> Omitir
  await page.keyboard.press('Tab'); // Omitir -> Activar ubicación
  const activateFocused = await page.evaluate(
    () => document.activeElement?.classList.contains('onboarding-activate') ?? false,
  );
  expect(activateFocused, 'Tab reaches the activation control').toBe(true);
  await page.keyboard.press('Enter');
  // A reload gives the page a fresh window, so the init-script counter
  // restarts: this replayed keyboard activation is call number 1.
  await expect.poll(() => geo.count()).toBe(1);
  await expect(onboarding.locator('.onboarding-success')).toContainText('Ubicación activada');
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains('onboarding-success') ?? false),
  ).toBe(true);
  expect(
    await statusOutlineStyle(),
    'the success status shows its ring after a keyboard activation',
  ).toBe('solid');

  // "Siguiente" keeps advancing normally from the success state (the keyboard
  // replay already sits on Paso 2).
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 3 de 4');
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 4 de 4');
  await onboarding.getByRole('button', { name: 'Empezar a usar el mapa' }).click();
  await expect(onboarding).toBeHidden();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Introducción al mapa comunitario' })).toBeHidden();
});

test('falls back to a usable map when location is denied', async ({ page }) => {
  // The denial geometry defect (nav painting over the note, retry clipped by
  // the card) was measured at 390x844, so the mobile contract is asserted there.
  await page.setViewportSize({ width: 390, height: 844 });
  const geo = await spyGeolocation(page, 'denied');
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await onboarding.getByRole('button', { name: 'Activar ubicación' }).click();
  await expect(onboarding.locator('.onboarding-note')).toContainText('No pudimos obtener tu ubicación');
  await expect(onboarding.getByRole('button', { name: 'Siguiente' })).toBeEnabled();

  // Denial is announced too: the fallback note is a polite live region, and
  // the navigation stays visible and hit-test reachable beside it.
  await expect(onboarding.locator('.onboarding-note')).toHaveAttribute('role', 'status');
  await expect(onboarding.locator('.onboarding-note')).toHaveAttribute('aria-live', 'polite');
  await assertNavigationReachable(page);

  // Default-scroll readability: the denial note must be fully readable at the
  // scroll position the transition leaves behind, and the retry control must
  // be wholly inside the card and reachable across its whole box.
  await assertFeedbackUnobscured(page, '.onboarding-note', 'the denial note');
  await assertRetryFullyInsideCard(page);

  // Denial never takes the map down: the aggregate still loads as text.
  await expect(page.locator('#map-state')).toContainText('No hay cortes reportados en este momento.');

  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 3 de 4');
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 4 de 4');
  await onboarding.getByRole('button', { name: 'Empezar a usar el mapa' }).click();
  await expect(onboarding).toBeHidden();
  expect(await geo.count()).toBe(1);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Introducción al mapa comunitario' })).toBeHidden();
  // The map's own locate control stays available as the retry affordance.
  await expect(page.locator('.locate-control')).toBeVisible();
});

test('stays closed after completing every step', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 1 de 4');
  for (let step = 0; step < 3; step += 1) await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 4 de 4');
  await onboarding.getByRole('button', { name: 'Empezar a usar el mapa' }).click();

  await expect(onboarding).toBeHidden();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Introducción al mapa comunitario' })).toBeHidden();
});

test('closes with Escape and keeps the map useful after skipping', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await page.keyboard.press('Escape');
  await expect(onboarding).toBeHidden();

  await page.reload();
  await expect(onboarding).toBeHidden();
  await expect(page.getByRole('heading', { name: '¿Es solo tu casa?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enviar reporte' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('No hay cortes reportados en este momento.');
});

test('keeps the peek sheet and grip clear on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();
  const card = onboarding.locator('.onboarding-card');
  const cardBox = await card.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(cardBox?.x).toBeGreaterThanOrEqual(0);
  expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(390);
  // The card floats above the peek sheet: the grip stays visible and tappable.
  const grip = page.locator('#grip');
  await expect(grip).toBeVisible();
  const gripBox = await grip.boundingBox();
  expect(gripBox).not.toBeNull();
  expect(cardBox?.y ?? 0).toBeLessThan(gripBox?.y ?? 0);
  await expect(page.locator('#site-identity')).toBeVisible();
});

/**
 * Desktop ownership probe: the overlay must be the whole viewport, nothing
 * behind it may answer a pointer, the composition must not overflow, and the
 * integrated legal copy plus navigation must stay reachable.
 */
interface OwnershipReport {
  overlay: { x: number; y: number; width: number; height: number } | null;
  scrollWidth: number;
  scrollHeight: number;
  blocked: { selector: string; targetable: boolean }[];
  nextReachable: boolean;
  legalPresent: boolean;
  legalTargetable: boolean;
  figure: { x: number; y: number; width: number; height: number } | null;
  title: { x: number; y: number; width: number; height: number } | null;
}

async function measureOwnership(page: Page): Promise<OwnershipReport> {
  return page.evaluate(() => {
    const box = (element: Element): { x: number; y: number; width: number; height: number } => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const hit = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
      const target = document.elementFromPoint(x, y);
      return target instanceof Element && (target === element || element.contains(target));
    };
    const overlay = document.querySelector('#onboarding');
    const next = document.querySelector('.onboarding-primary');
    const legal = document.querySelector('.onboarding-legal');
    const figure = document.querySelector('.onboarding-figure');
    const title = document.querySelector('.onboarding-title');
    return {
      overlay: overlay ? box(overlay) : null,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      blocked: ['.leaflet-control-zoom-in', '#outage-map', '#rail'].map((selector) => {
        const element = document.querySelector(selector);
        return { selector, targetable: element ? hit(element) : false };
      }),
      nextReachable: next ? hit(next) : false,
      legalPresent: legal !== null,
      legalTargetable: legal ? hit(legal) : false,
      figure: figure ? box(figure) : null,
      title: title ? box(title) : null,
    };
  });
}

for (const [width, height] of [[1440, 900], [900, 844]] as const) {
  test(`owns the full viewport on a ${width}x${height} desktop first load`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');

    const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
    await expect(onboarding).toBeVisible();

    const report = await measureOwnership(page);
    // The layer is the whole viewport: a full-bleed surface, not a card beside the rail.
    expect(report.overlay).toEqual({ x: 0, y: 0, width, height });
    // The composition never overflows the viewport.
    expect(report.scrollWidth).toBeLessThanOrEqual(width);
    expect(report.scrollHeight).toBeLessThanOrEqual(height);
    // Nothing behind the surface answers a pointer: map, rail and zoom are all blocked.
    expect(report.blocked.map((entry) => entry.targetable)).toEqual([false, false, false]);
    // Navigation stays reachable and the integrated legal copy stays readable.
    expect(report.nextReachable).toBe(true);
    expect(report.legalPresent).toBe(true);
    expect(report.legalTargetable).toBe(true);
    await expect(onboarding.locator('.onboarding-legal')).toContainText('no oficial');
    await expect(onboarding.locator('.onboarding-legal')).toContainText('Sedapal');
    await expect(onboarding.locator('.onboarding-legal')).toContainText('Luz del Sur');

    // A deliberate two-column editorial composition: the illustration and the
    // step content sit side by side, never stacked in one stretched column.
    expect(report.figure).not.toBeNull();
    expect(report.title).not.toBeNull();
    const figure = report.figure!;
    const title = report.title!;
    expect(title.x).toBeGreaterThanOrEqual(figure.x + figure.width);
  });

  test(`keeps Escape and skip working on the ${width}x${height} desktop surface`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');

    const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
    await expect(onboarding).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(onboarding).toBeHidden();
    await page.reload();
    await expect(onboarding).toBeHidden();
    // The map is usable right after the first visit ends.
    await expect(page.getByRole('status')).toContainText('No hay cortes reportados en este momento.');
  });
}

test('keeps the onboarding reachable above an opened rail on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();

  // The card is a first-run teaching layer: it may sit above the opened sheet,
  // but skipping stays one tap away and the layer itself keeps the sheet taps
  // flowing around the card.
  await page.locator('#grip').click();
  await expect(page.locator('#grip')).toHaveAttribute('aria-expanded', 'true');
  await expect(onboarding).toBeVisible();
  const skip = onboarding.getByRole('button', { name: 'Omitir' });
  await expect(skip).toBeVisible();
  const skipReachable = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.onboarding-skip');
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return target instanceof Element && (target === button || button.contains(target));
  });
  expect(skipReachable).toBe(true);
  await skip.click();
  await expect(onboarding).toBeHidden();
  // Skipping the onboarding never collapses the sheet state underneath it.
  await expect(page.locator('#grip')).toHaveAttribute('aria-expanded', 'true');
});

/**
 * The step navigation is only usable when both buttons stay visible and a
 * pointer can actually reach their centre — a plain visibility check misses
 * the clipped-under-scroll case.
 */
async function assertNavigationReachable(page: Page): Promise<void> {
  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding.locator('.onboarding-ghost')).toBeVisible();
  // The primary control is "Siguiente" (or "Empezar a usar el mapa" on the last step).
  await expect(onboarding.locator('.onboarding-primary')).toBeVisible();
  const reachable = await page.evaluate(() => {
    const hit = (selector: string): boolean => {
      const button = document.querySelector<HTMLButtonElement>(selector);
      if (!button) return false;
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target instanceof Element && (target === button || button.contains(target));
    };
    return { prev: hit('.onboarding-ghost'), next: hit('.onboarding-primary') };
  });
  expect(reachable, 'Anterior and Siguiente answer a pointer at their centre').toEqual({ prev: true, next: true });
}

/**
 * Default-scroll feedback probe: after a state transition that inserts copy
 * (success status or denial note), the live region must be fully readable at
 * the scroll position the transition leaves behind — never painted over by
 * the nav footer and never clipped by the card. The probe samples the whole
 * box (3x3 grid), because a centre-only hit test misses partial occlusion.
 */
interface FeedbackClearanceReport {
  scrollTops: { card: number; content: number };
  copy: { x: number; y: number; width: number; height: number } | null;
  nav: { x: number; y: number; width: number; height: number } | null;
  card: { x: number; y: number; width: number; height: number } | null;
  copyInsideCard: boolean;
  navOverlapsCopy: boolean;
  coveredSamplePoints: string[];
}

async function measureFeedbackClearance(page: Page, selector: string): Promise<FeedbackClearanceReport> {
  return page.evaluate((sel: string) => {
    const box = (element: Element): { x: number; y: number; width: number; height: number } => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const intersects = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const contains = (
      outer: { x: number; y: number; width: number; height: number },
      inner: { x: number; y: number; width: number; height: number },
    ): boolean =>
      inner.x >= outer.x - .5 && inner.y >= outer.y - .5
      && inner.x + inner.width <= outer.x + outer.width + .5
      && inner.y + inner.height <= outer.y + outer.height + .5;
    const copy = document.querySelector(sel);
    const nav = document.querySelector('.onboarding-nav');
    const card = document.querySelector('.onboarding-card');
    const covered: string[] = [];
    if (copy) {
      const rect = copy.getBoundingClientRect();
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const x = rect.left + rect.width * ((col + .5) / 3);
          const y = rect.top + rect.height * ((row + .5) / 3);
          const target = document.elementFromPoint(x, y);
          if (!(target instanceof Element && (target === copy || copy.contains(target)))) {
            covered.push(`${Math.round(x)},${Math.round(y)}`);
          }
        }
      }
    }
    const scrollTop = (element: Element | null): number =>
      element instanceof HTMLElement ? element.scrollTop : -1;
    return {
      scrollTops: {
        card: scrollTop(card),
        content: scrollTop(document.querySelector('.onboarding-content')),
      },
      copy: copy ? box(copy) : null,
      nav: nav ? box(nav) : null,
      card: card ? box(card) : null,
      copyInsideCard: copy !== null && card !== null && contains(box(card), box(copy)),
      navOverlapsCopy: copy !== null && nav !== null && intersects(box(copy), box(nav)),
      coveredSamplePoints: covered,
    };
  }, selector);
}

async function assertFeedbackUnobscured(page: Page, selector: string, label: string): Promise<void> {
  const report = await measureFeedbackClearance(page, selector);
  expect(
    Math.max(report.scrollTops.card, report.scrollTops.content),
    `${label} is measured at the default scroll (no post-transition scrolling)`,
  ).toBe(0);
  expect(report.copy, `${label} renders`).not.toBeNull();
  expect(report.copyInsideCard, `${label} sits fully inside the card, unclipped`).toBe(true);
  expect(report.navOverlapsCopy, `${label} is not painted over by the nav footer`).toBe(false);
  expect(
    report.coveredSamplePoints,
    `${label} answers a pointer across its whole box, not only its centre`,
  ).toEqual([]);
}

/**
 * The denial retry control must be wholly inside the card (not clipped by its
 * scroll edge) and hit-test reachable across its box at the default scroll.
 */
async function assertRetryFullyInsideCard(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('.onboarding-activate');
    const card = document.querySelector<HTMLElement>('.onboarding-card');
    if (!button || !card) return { found: false as const, inside: false, covered: [] as string[] };
    const rect = button.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const inside = rect.top >= cardRect.top - .5 && rect.bottom <= cardRect.bottom + .5
      && rect.left >= cardRect.left - .5 && rect.right <= cardRect.right + .5;
    const covered: string[] = [];
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        const x = rect.left + rect.width * ((col + .5) / 3);
        const y = rect.top + rect.height * ((row + .5) / 3);
        const target = document.elementFromPoint(x, y);
        if (!(target instanceof Element && (target === button || button.contains(target)))) {
          covered.push(`${Math.round(x)},${Math.round(y)}`);
        }
      }
    }
    return { found: true as const, inside, covered };
  });
  expect(report.found, 'the retry control renders').toBe(true);
  expect(report.inside, 'the retry control sits fully inside the card, unclipped').toBe(true);
  expect(report.covered, 'the retry control answers a pointer across its whole box').toEqual([]);
}

/**
 * Shared hit-test/intersection probe: a control is only usable when something
 * actually reaches its centre, and two boxes only overlap when every edge test
 * agrees — a plain visibility check misses both kinds of occlusion.
 */
interface ClearanceReport {
  cardFound: boolean;
  controlsTargetable: boolean[];
  noticeTargetable: boolean;
  attributionClear: boolean;
  cardIntersectsControls: boolean;
}

async function measureClearance(page: Page): Promise<ClearanceReport> {
  return page.evaluate(() => {
    const box = (element: Element): { x: number; y: number; width: number; height: number } => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const intersects = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const hitTest = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target instanceof Element && (target === element || element.contains(target));
    };
    const card = document.querySelector('.onboarding-card');
    const notice = document.querySelector('.unofficial');
    const attribution = document.querySelector('.leaflet-control-attribution');
    const controls = ['.leaflet-control-zoom-in', '.leaflet-control-zoom-out', '.locate-control']
      .map((selector) => document.querySelector(selector));
    return {
      cardFound: card !== null,
      controlsTargetable: controls.map((control) => control !== null && hitTest(control)),
      noticeTargetable: notice === null ? false : hitTest(notice),
      attributionClear: card === null || attribution === null || !intersects(box(card), box(attribution)),
      cardIntersectsControls: card === null
        ? false
        : controls.some((control) => control !== null && intersects(box(card), box(control))),
    };
  });
}

test('keeps the map controls targetable and the attribution clear on every mobile step', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();

  for (let step = 1; step <= 4; step += 1) {
    if (step > 1) await onboarding.getByRole('button', { name: 'Siguiente' }).click();
    await expect(onboarding.locator('.onboarding-progress')).toContainText(`Paso ${step} de 4`);

    // Every step keeps its navigation reachable, including the location step
    // in its initial (pre-activation) state.
    await assertNavigationReachable(page);

    const report = await measureClearance(page);
    expect(report.cardFound, `step ${step} renders its card`).toBe(true);
    expect(
      report.controlsTargetable,
      `step ${step} keeps zoom and locate controls targetable`,
    ).toEqual([true, true, true]);
    expect(
      report.attributionClear,
      `step ${step} keeps the card clear of the attribution`,
    ).toBe(true);
  }
});

test('keeps the focus ring gated by input modality and Omitir one forward Tab away', async ({ page }) => {
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();

  // The open-time focus contract is the step heading; the fix must keep that
  // while putting the skip control directly after it in the forward order.
  const initialOnHeading = await page.evaluate(
    () => document.activeElement?.classList.contains('onboarding-title') ?? false,
  );
  expect(initialOnHeading).toBe(true);

  // Fresh load: the heading is focused programmatically before any input, so
  // it must not paint the focus ring — a painted outline there reads as
  // auto-selected text.
  const headingOutlineStyle = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.querySelector('.onboarding-title')!).outlineStyle);
  expect(
    await headingOutlineStyle(),
    'no focus ring on the programmatically focused heading at first load',
  ).toBe('none');

  await page.keyboard.press('Tab');
  const skipFocused = await page.evaluate(
    () => document.activeElement?.classList.contains('onboarding-skip') ?? false,
  );
  expect(skipFocused, 'one forward Tab from the initial focus reaches Omitir').toBe(true);
  // A genuine keyboard interaction on a real control always shows the
  // indicator; the modality gate only mutes the programmatic-focus moves.
  const skipOutline = await page.evaluate(
    () => getComputedStyle(document.querySelector('.onboarding-skip')!).outlineStyle,
  );
  expect(skipOutline, 'the focus indicator is present on Omitir after keyboard input').toBe('solid');

  // Keyboard step navigation brings the ring back on the heading: Tab lands
  // on "Siguiente" (Anterior is disabled on step 1), Enter advances, and the
  // next heading receives its programmatic focus, which must paint because
  // the last input was a keyboard one.
  await page.keyboard.press('Tab');
  const nextFocused = await page.evaluate(
    () => document.activeElement?.classList.contains('onboarding-primary') ?? false,
  );
  expect(nextFocused, 'Tab from Omitir reaches Siguiente').toBe(true);
  await page.keyboard.press('Enter');
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 2 de 4');
  const headingFocusedAfterEnter = await page.evaluate(
    () => document.activeElement?.classList.contains('onboarding-title') ?? false,
  );
  expect(headingFocusedAfterEnter, 'the step change still moves focus to the heading').toBe(true);
  expect(await headingOutlineStyle(), 'the heading shows the focus ring after keyboard navigation').toBe('solid');

  // Switching back to pointer input mutes it again: a pointer-driven step
  // change refocuses the heading, and that programmatic move paints nothing.
  await onboarding.getByRole('button', { name: 'Siguiente' }).click();
  await expect(onboarding.locator('.onboarding-progress')).toContainText('Paso 3 de 4');
  expect(await headingOutlineStyle(), 'a pointer-driven step change leaves the heading unpainted').toBe('none');
});

test('keeps the mobile clearance contract when returning to the map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const onboarding = page.getByRole('region', { name: 'Introducción al mapa comunitario' });
  await expect(onboarding).toBeVisible();
  await onboarding.getByRole('button', { name: 'Omitir' }).click();
  await expect(onboarding).toBeHidden();

  // Closing the first-run layer hands the map back intact: controls, notice
  // and attribution all keep their clearance in the same visit.
  const report = await measureClearance(page);
  expect(report.cardFound).toBe(false);
  expect(report.controlsTargetable, 'zoom and locate controls stay targetable after skip').toEqual([true, true, true]);
  expect(report.noticeTargetable, 'the permanent notice stays readable after skip').toBe(true);
});

test('keeps the permanent notice and the map controls clear of each other on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  // The notice is permanent, so it must actually be readable, and the controls
  // it shares the corner with must be really targetable — a hit-test at each
  // centre catches occlusion that a plain visibility check misses.
  const notice = page.getByRole('note');
  await expect(notice).toBeVisible();
  const report = await page.evaluate(() => {
    const isOccluded = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !(target instanceof Element && (target === element || element.contains(target)));
    };
    const notice = document.querySelector('.unofficial');
    const controls = ['.leaflet-control-zoom-in', '.locate-control'].map((selector) => document.querySelector(selector));
    return {
      controlsOccluded: controls.map((control) => control === null || isOccluded(control)),
      noticeOccluded: notice === null || isOccluded(notice),
    };
  });
  expect(report.controlsOccluded).toEqual([false, false]);
  expect(report.noticeOccluded).toBe(false);
});
