import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiDirectory = resolve(scriptDirectory, '..');
const source = resolve(apiDirectory, 'prisma/migrations');
const destination = resolve(apiDirectory, 'dist/prisma/migrations');

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`Copied SQL migrations to ${destination}`);
