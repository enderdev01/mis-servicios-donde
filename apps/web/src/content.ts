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
    body: 'Los cortes de agua, luz e internet que ves aquí los reportan vecinos como tú. Es información de la comunidad, no oficial: no es un canal de Sedapal ni de Luz del Sur ni de ningún proveedor.',
    image: '/onboarding/1onboard.webp',
    alt: 'Ilustración de vecinos en un barrio con un mapa que marca zonas con cortes.',
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
    title: 'Reporta en dos toques',
    body: 'Elige los servicios afectados y di qué pasa: "No hay servicio" o "Ya volvió". Avisar de que volvió el servicio ayuda tanto como avisar del corte.',
    image: '/onboarding/3onboard.webp',
    alt: 'Ilustración de un vecino eligiendo servicios afectados en su teléfono para enviar un reporte.',
  },
  {
    id: 'publication',
    title: 'Cómo se publica tu reporte',
    body: 'Tu primer reporte aparece como "sin confirmar". Cuando tres vecinos distintos reportan lo mismo en la zona, el corte queda confirmado. Puedes enviar un reporte por dispositivo, servicio y estado cada hora, y solo dentro de las zonas piloto aprobadas.',
    image: '/onboarding/4onboard.webp',
    alt: 'Ilustración de tres vecinos distintos reportando lo mismo y el corte quedando confirmado en el mapa.',
  },
];
