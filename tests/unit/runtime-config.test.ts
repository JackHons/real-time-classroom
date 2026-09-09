import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRuntimeConfig } from '../../apps/server/src/runtime-config.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('runtime CSRF secret persistence', () => {
  it('atomically creates a canonical secret and reuses it on every later read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lan-classroom-secret-')); directories.push(directory);
    const environment = { LAN_CLASSROOM_ALLOWED_ORIGIN: 'http://127.0.0.1:4173', LAN_CLASSROOM_DATABASE_PATH: join(directory, 'classroom.sqlite') };
    const first = readRuntimeConfig(environment);
    const second = readRuntimeConfig(environment);
    expect(first.csrfSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.csrfSecret).toBe(first.csrfSecret);
    expect(JSON.parse(readFileSync(join(directory, 'runtime-secrets.json'), 'utf8'))).toEqual({ csrfSecret: first.csrfSecret });
  });

  it('fails closed rather than accepting a corrupt or non-canonical persisted secret', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lan-classroom-secret-')); directories.push(directory);
    // Last base64url character has unused bits for a 32-byte value; B decodes
    // but is not the canonical encoding of the resulting bytes.
    writeFileSync(join(directory, 'runtime-secrets.json'), JSON.stringify({ csrfSecret: `${'A'.repeat(42)}B` }));
    expect(() => readRuntimeConfig({ LAN_CLASSROOM_ALLOWED_ORIGIN: 'http://127.0.0.1:4173', LAN_CLASSROOM_DATABASE_PATH: join(directory, 'classroom.sqlite') })).toThrow('RUNTIME_SECRET_INVALID');
  });

  it('recovers from a crashed writer\'s stale lock and temporary file without reading it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lan-classroom-secret-')); directories.push(directory);
    const temporary = join(directory, `runtime-secrets.${'a'.repeat(24)}.tmp`);
    const lock = join(directory, 'runtime-secrets.lock');
    writeFileSync(temporary, '{partial');
    writeFileSync(lock, 'crashed');
    utimesSync(lock, new Date(0), new Date(0));
    const config = readRuntimeConfig({ LAN_CLASSROOM_ALLOWED_ORIGIN: 'http://127.0.0.1:4173', LAN_CLASSROOM_DATABASE_PATH: join(directory, 'classroom.sqlite') });
    expect(config.csrfSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(existsSync(temporary)).toBe(false);
  });
});
