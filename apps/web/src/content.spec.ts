import { describe, expect, it } from 'vitest';

import { cellInfoTitle, coverageList, emptyDistrictState, emptyMapState, locationSuccess, mapLabel, onboardingSteps, reportLocationError, reportRejection, siteNotice, streetLookupNotice, thanksMessage, unofficialNotice } from './content.js';

describe('answer copy', () => {
  it('titles a dialog with unconfirmed reports as reports, not outages', () => {
    expect(cellInfoTitle(true)).toBe('Cortes en esta área');
    expect(cellInfoTitle(false)).toBe('Reportes en esta área');
  });

  it('labels the map as showing unconfirmed reports too', () => {
    expect(mapLabel).toContain('reportes sin confirmar');
    expect(mapLabel).not.toContain('confirmados');
  });

  it('promises the unconfirmed area only for an outage report', () => {
    expect(thanksMessage('outage')).toContain('«sin confirmar»');
    expect(thanksMessage('restored')).not.toContain('sin confirmar');
    expect(thanksMessage('restored')).toContain('volvió');
  });

  it('names the covered districts, never the team words', () => {
    expect(coverageList(['Breña', 'Rímac'])).toBe('Distritos con cobertura: Breña, Rímac.');
    expect(coverageList([])).toBe('');
    expect(emptyMapState(undefined, [])).toContain('los distritos con cobertura');
    expect(emptyMapState('Breña', ['Breña', 'Rímac'])).toMatch(/^Nadie ha reportado cortes en Breña\./);
    for (const text of [emptyMapState(undefined, ['Breña']), thanksMessage('outage'), cellInfoTitle(false)]) {
      expect(text.toLowerCase()).not.toMatch(/piloto|zona/);
    }
  });

  it('says where the other areas are when the chosen district is empty', () => {
    expect(emptyDistrictState('San Juan de Lurigancho', 5)).toBe('Nadie ha reportado cortes en San Juan de Lurigancho. Hay 5 áreas con reportes en otros distritos.');
    expect(emptyDistrictState('Breña', 1)).toContain('Hay 1 área con reportes');
  });
});

describe('report location errors', () => {
  it('only asks for the permission when it was denied', () => {
    expect(reportLocationError(1)).toContain('Permite la ubicación');
    expect(reportLocationError(2)).not.toContain('Permite');
    expect(reportLocationError(3)).toContain('Reintenta');
    expect(reportLocationError(3)).not.toContain('Permite');
  });
});

describe('report rejections', () => {
  const generic = 'No pudimos enviar tu reporte ahora. Vuelve a intentarlo más tarde.';

  it('answers each Worker code with its own message', () => {
    expect(reportRejection('intake_paused')).toBe('Por ahora no estamos recibiendo reportes. El mapa sigue funcionando.');
    expect(reportRejection('outside_pilot_zone')).toContain('fuera de los distritos que cubre el mapa');
  });

  it('rounds the wait up to whole minutes', () => {
    expect(reportRejection('rate_limited', 600)).toContain('en unos 10 minutos');
    expect(reportRejection('rate_limited', 61)).toContain('en unos 2 minutos');
    expect(reportRejection('rate_limited', 30)).toContain('aproximadamente 1 minuto');
  });

  it('keeps the generic message for other, unknown or incomplete answers', () => {
    expect(reportRejection('report_unavailable')).toBe(generic);
    expect(reportRejection(undefined)).toBe(generic);
    expect(reportRejection('rate_limited')).toBe(generic);
    expect(reportRejection('rate_limited', 0)).toBe(generic);
  });

  it('never uses the team words', () => {
    for (const text of [reportRejection('intake_paused'), reportRejection('outside_pilot_zone'), reportRejection('rate_limited', 90), generic]) {
      expect(text.toLowerCase()).not.toMatch(/piloto|zona/);
    }
  });
});

describe('street lookup disclosure', () => {
  it('names the services and says the position is not what is sent', () => {
    expect(streetLookupNotice).toContain('Overpass');
    expect(streetLookupNotice).toContain('Nominatim');
    expect(streetLookupNotice).toContain('no tu posición');
  });
});

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

  it('frames the map as community generated from the first step, leaving the naming to the legal line', () => {
    const [first] = onboardingSteps;
    expect(`${first?.title} ${first?.body}`.toLowerCase()).toContain('vecinos');
    expect(first?.body).toContain('no las empresas');
    // The body no longer repeats the legal line that sits directly below it on every step.
    expect(first?.body).not.toContain('Sedapal');
    expect(`${siteNotice} ${unofficialNotice}`).toContain('no oficial');
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

  it('explains consensus, the hourly repeat limit and the covered-district restriction', () => {
    const publication = onboardingSteps[3];
    const text = `${publication?.title} ${publication?.body}`.toLowerCase();
    expect(text).toContain('sin confirmar');
    expect(text).toContain('tres vecinos');
    expect(text).toContain('cada hora');
    expect(text).toContain('distritos donde funciona el mapa');
    expect(text).not.toContain('piloto');
  });

  it('never exposes report counts as product claims', () => {
    for (const step of onboardingSteps) {
      expect(step.body).not.toMatch(/\d+\s+(reportes|vecinos) (activos|hoy|ahora)/);
    }
  });
});
