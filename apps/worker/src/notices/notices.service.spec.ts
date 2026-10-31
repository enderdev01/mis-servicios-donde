import { describe, expect, it } from 'vitest';

import { printableNotice } from './notices.service.js';

describe('printable notice policy', () => {
  it('uses only approved-zone aggregate community information', () => {
    const notice = printableNotice({ name: 'Central' });

    expect(notice).toEqual({
      title: 'Aviso comunitario de cortes — Central',
      zone: 'Central',
      instructions: 'Reporta cortes de agua, luz o internet en el mapa comunitario.',
      mapUrl: '/',
      notice: 'Información sobre cortes generada por la comunidad, no oficial.',
    });
  });

  it('does not include resident or report-level fields', () => {
    expect(JSON.stringify(printableNotice({ name: 'North' }))).not.toMatch(/device|name|latitude|longitude|timestamp|reportId/i);
  });
});
