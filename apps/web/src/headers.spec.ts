import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const vercel = JSON.parse(readFileSync(join(here, '..', 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const headers = Object.fromEntries(vercel.headers.find((entry) => entry.source === '/(.*)')?.headers.map((h) => [h.key, h.value]) ?? []);
const csp = headers['Content-Security-Policy'] ?? headers['Content-Security-Policy-Report-Only'] ?? '';
const directive = (name: string): string[] => csp.split(';').map((part) => part.trim().split(/\s+/)).find(([key]) => key === name)?.slice(1) ?? [];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|astro)$/.test(name) && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Every external origin the app code mentions, with the CSP directive that governs how it is used. */
function externalOrigins(): { origin: string; directive: string }[] {
  const found = new Map<string, string>();
  for (const file of sourceFiles(here)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      for (const [origin] of line.matchAll(/https?:\/\/[^/\s'"`)<>]+/g)) {
        if (origin.includes('w3.org') || /href=|attribution/.test(line)) continue; // namespace URIs and plain links load nothing
        found.set(origin, /fetch\(/.test(line) ? 'connect-src' : /url:/.test(line) ? 'img-src' : 'unclassified');
      }
    }
  }
  return [...found].map(([origin, kind]) => ({ origin, directive: kind }));
}

describe('security headers', () => {
  it('sends the baseline privacy headers', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toContain('geolocation=(self)');
  });

  it('allows every external origin the source uses, in the directive that governs it', () => {
    const origins = externalOrigins();
    expect(origins.length).toBeGreaterThan(0);
    for (const { origin, directive: name } of origins) {
      expect(name, `classify ${origin}: add it to this spec and to the CSP`).not.toBe('unclassified');
      expect(directive(name), `${origin} missing from ${name}`).toContain(origin);
    }
  });
});
