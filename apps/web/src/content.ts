export const siteNotice = 'Información sobre cortes generada por la comunidad, no oficial.';

/** The provider naming travels with the data on every surface, including inside the onboarding. */
export const unofficialNotice = 'No es un canal oficial de Sedapal, Luz del Sur ni de ningún proveedor.';

/**
 * Shown in place of the activation control after a successful request. Activation
 * is a state inside the location step, never an early completion of the flow.
 */
export const locationSuccess = {
  message: 'Ubicación activada',
  detail: 'Los cortes cerca tuyo se ordenan por distancia. Tu posición no se guarda.',
};

/** `GeolocationPositionError.code` tells a denied permission apart from a slow or missing fix. */
export function reportLocationError(code: number): string {
  if (code === 2) return 'No pudimos detectar tu ubicación: parece que no hay señal de GPS. Prueba cerca de una ventana o con los datos activados y reintenta.';
  if (code === 3) return 'Tu ubicación tardó demasiado en llegar. Reintenta.';
  return 'Para enviar el reporte necesitamos tu ubicación una sola vez. Permite la ubicación para este sitio en tu navegador y vuelve a enviarlo.';
}

export const reportCopy = {
  timeout: 'La conexión está lenta y no supimos si tu reporte llegó. Reintenta: no se enviará dos veces.',
  loadFailed: 'No pudimos cargar los cortes. Revisa tu conexión.',
  loadFailedState: 'No pudimos cargar los cortes ahora. Revisa tu conexión.',
  stale: 'No pudimos actualizar los cortes. Esto es lo último que tenemos.',
  mapFailed: 'No pudimos cargar el mapa. Revisa tu conexión y recarga la página.',
};

/** Wording rule: «distrito» for the covered places, «área» for a drawn spot, «zona amplia» only in the privacy sentence. */
export const mapLabel = 'Mapa de cortes y reportes sin confirmar. La misma información está en la lista del panel.';

export const outsideCoverageAnswer = 'Tu ubicación está fuera de los distritos con cobertura. Aquí todavía no podemos mostrar ni recibir reportes.';

export function coverageList(districts: string[]): string {
  return districts.length === 0 ? '' : `Distritos con cobertura: ${districts.join(', ')}.`;
}

/** Nothing reported anywhere: names the covered districts so an empty map is not mistaken for «all fine here». */
export function emptyMapState(district: string | undefined, covered: string[]): string {
  const where = district ?? 'los distritos con cobertura';
  const list = !district && covered.length > 0 ? ` (${covered.join(', ')})` : '';
  return `Nadie ha reportado cortes en ${where}${list}. Si se fue el servicio en tu casa, repórtalo: así sabrás si es solo tu casa.`;
}

/** A district with nothing reported while other districts have areas: say where the rest is. */
export function emptyDistrictState(district: string, otherAreas: number): string {
  return `Nadie ha reportado cortes en ${district}. Hay ${otherAreas === 1 ? '1 área' : `${otherAreas} áreas`} con reportes en otros distritos.`;
}

/** A dialog titled «Cortes» over a single unconfirmed report would present it as fact. */
export function cellInfoTitle(allConfirmed: boolean): string {
  return allConfirmed ? 'Cortes en esta área' : 'Reportes en esta área';
}

/** The promise made after sending must be one the map keeps, so it follows the status sent. */
export function thanksMessage(status: string | undefined): string {
  return status === 'restored'
    ? 'Gracias. Si otros vecinos también avisan que volvió, el corte se cerrará en el mapa.'
    : 'Recibimos tu reporte. Aparecerá en el mapa como «sin confirmar» hasta que otros vecinos reporten lo mismo cerca de ti.';
}

export const ownReportLabel = 'Tu reporte · sin confirmar';

export interface OnboardingStep {
  id: string;
  title: string;
  body: string;
  image: string;
  alt: string;
}

/**
 * Copy rules: neutral Spanish with tuteo, the real publication rules, no report
 * counts as claims, and geolocation explained before it is ever requested.
 */
export const onboardingSteps: OnboardingStep[] = [
  {
    id: 'community',
    title: 'Un mapa hecho por vecinos',
    body: 'Los cortes de agua, luz e internet que ves aquí los reportan vecinos como tú, no las empresas.',
    image: '/onboarding/1onboard.webp',
    alt: 'Ilustración de vecinos en un barrio con un mapa que marca áreas con cortes.',
  },
  {
    id: 'location',
    title: 'Tu ubicación, usada una sola vez',
    body: 'En el mapa, tu ubicación se queda en tu navegador: solo la usamos para ordenar los cortes por cercanía. Si envías un reporte, tu ubicación exacta se manda una sola vez: el servidor la convierte en una zona amplia y la descarta. No se guarda ni se muestra.',
    image: '/onboarding/2onboard.webp',
    alt: 'Ilustración de un teléfono mostrando una zona amplia en el mapa sin señalar una casa exacta.',
  },
  {
    id: 'report',
    title: 'Reporta en pocos toques',
    body: 'Elige el servicio y la empresa, y di qué pasa: «No hay servicio» o «Ya volvió». Avisar de que volvió el servicio ayuda tanto como avisar del corte.',
    image: '/onboarding/3onboard.webp',
    alt: 'Ilustración de un vecino eligiendo servicios afectados en su teléfono para enviar un reporte.',
  },
  {
    id: 'publication',
    title: 'Cómo se publica tu reporte',
    body: 'Tu primer reporte aparece como «sin confirmar». Cuando tres vecinos distintos reportan lo mismo en el mismo lugar, el corte queda confirmado. Puedes enviar un reporte por dispositivo, servicio y estado cada hora, y solo en los distritos donde funciona el mapa por ahora.',
    image: '/onboarding/4onboard.webp',
    alt: 'Ilustración de tres vecinos distintos reportando lo mismo y el corte quedando confirmado en el mapa.',
  },
];
