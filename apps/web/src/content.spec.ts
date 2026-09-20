import { describe, expect, it } from 'vitest';

import { locationSuccess, onboardingSteps, siteNotice, unofficialNotice } from './content.js';

describe('site content', () => {
  it('identifies the community data as unofficial', () => {
    expect(siteNotice).toContain('no oficial');
  });

  it('names the providers in the permanent unofficial notice', () => {
    expect(unofficialNotice.toLowerCase()).toContain('no es un canal oficial');
    expect(unofficialNotice).toContain('Sedapal');
    expect(unofficialNotice).toContain('Luz del Sur');
  });

  it('celebrates activation while the flow stays open', () => {
    expect(locationSuccess.message).toBe('Ubicación activada');
    expect(locationSuccess.detail.length).toBeGreaterThan(0);
    // The success state never claims the position was stored anywhere.
    expect(`${locationSuccess.message} ${locationSuccess.detail}`.toLowerCase()).not.toContain('guardamos tu ubicación');
  });
});

describe('onboarding steps', () => {
  it('offers exactly four ordered illustrated steps', () => {
    expect(onboardingSteps).toHaveLength(4);
    for (const [index, step] of onboardingSteps.entries()) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      expect(step.image).toBe(`/onboarding/${index + 1}onboard.webp`);
      expect(step.alt.length).toBeGreaterThan(0);
    }
  });

  it('frames the map as community generated and unofficial from the first step', () => {
    const [first] = onboardingSteps;
    expect(`${first?.title} ${first?.body}`.toLowerCase()).toContain('no oficial');
  });

  it('explains that map proximity stays in the browser and a submitted coordinate is used once and discarded', () => {
    const [, second] = onboardingSteps;
    const text = `${second?.title} ${second?.body}`.toLowerCase();
    expect(text).toContain('una sola vez');
    expect(text).toContain('no se guarda');
    expect(text).toContain('navegador');
    expect(text).toContain('servidor');
    expect(text).toContain('descarta');
    // The earlier copy falsely claimed the location never leaves the browser.
    expect(text).not.toContain('nunca sale de tu navegador');
  });

  it('explains consensus, the hourly repeat limit and the pilot-zone restriction', () => {
    const publication = onboardingSteps[3];
    const text = `${publication?.title} ${publication?.body}`.toLowerCase();
    expect(text).toContain('sin confirmar');
    expect(text).toContain('tres vecinos');
    expect(text).toContain('cada hora');
    expect(text).toContain('zonas piloto');
  });

  it('never exposes report counts as product claims', () => {
    for (const step of onboardingSteps) {
      expect(step.body).not.toMatch(/\d+\s+(reportes|vecinos) (activos|hoy|ahora)/);
    }
  });
});
