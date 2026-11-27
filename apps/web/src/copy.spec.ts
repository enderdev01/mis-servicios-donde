import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
// Every file that holds copy a neighbour can see or hear (text, alt, aria-label).
const copyFiles = ['pages/index.astro', 'content.ts', 'map.ts'];

describe('neighbour-facing wording (#107)', () => {
  it.each(copyFiles)('%s says «distrito»/«área», never «piloto» or «zona» outside «zona amplia»', (file) => {
    const source = readFileSync(join(here, file), 'utf8').replaceAll(/zona amplia/gi, '');
    const hits = source.split('\n').flatMap((line, index) =>
      /\b(zonas?|piloto)\b/i.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
    );
    expect(hits).toEqual([]);
  });
});
