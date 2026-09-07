import { cpSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = resolve(root, 'apps/server/src/db/migrations');
const destination = resolve(root, 'apps/server/dist/db/migrations');
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
