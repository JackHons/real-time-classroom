import { afterEach, describe, expect, it } from 'vitest';
import { createFirstRunSetupHandler, isStrongPassword } from '../../../apps/server/src/first-run-setup.js';
import { startServer, type RunningServer } from '../../../apps/server/src/server.js';

class SetupRepository {
  hash: string | undefined;
  teacherPasswordHash(): string | undefined { return this.hash; }
  setTeacherPasswordHashIfAbsent(hash: string): boolean { if (this.hash !== undefined) return false; this.hash = hash; return true; }
}

let server: RunningServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('loopback-only first-run setup', () => {
  it('rejects proxy headers, requires CSRF, and atomically consumes the setup slot', async () => {
    const repository = new SetupRepository();
    server = await startServer({ host: '127.0.0.1', port: 0, bootstrapHandler: createFirstRunSetupHandler({ repository, hashPassword: async () => '$argon2id$test' }) });
    const origin = `http://127.0.0.1:${server.port}`;
    const proxied = await fetch(`${origin}/setup`, { headers: { forwarded: 'for=198.51.100.7' } });
    expect(proxied.status).toBe(404);
    const csrf = await fetch(`${origin}/api/setup/csrf`);
    expect(csrf.status).toBe(200);
    const cookie = csrf.headers.get('set-cookie')?.split(';')[0];
    const token = (await csrf.json() as { csrfToken: string }).csrfToken;
    const body = JSON.stringify({ password: 'Strong-passphrase-1!', confirmPassword: 'Strong-passphrase-1!' });
    const response = await fetch(`${origin}/api/setup/teacher-password`, { method: 'POST', headers: { origin, cookie: cookie!, 'x-csrf-token': token, 'content-type': 'application/json' }, body });
    expect(response.status).toBe(201);
    expect(repository.hash).toBe('$argon2id$test');
    expect((await fetch(`${origin}/api/setup/csrf`)).status).toBe(410);
  });

  it('rejects weak or mismatched passwords before writing a hash', async () => {
    expect(isStrongPassword('short')).toBe(false);
    expect(isStrongPassword('OnlyLettersAndDigits123')).toBe(false);
    expect(isStrongPassword('Strong-passphrase-1!')).toBe(true);
  });

  it('allows exactly one winner when two setup posts race', async () => {
    const repository = new SetupRepository();
    server = await startServer({ host: '127.0.0.1', port: 0, bootstrapHandler: createFirstRunSetupHandler({ repository, hashPassword: async (password) => `$argon2id$${password}` }) });
    const origin = `http://127.0.0.1:${server.port}`;
    const csrf = await fetch(`${origin}/api/setup/csrf`);
    const cookie = csrf.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('missing setup cookie');
    const token = (await csrf.json() as { csrfToken: string }).csrfToken;
    const post = () => fetch(`${origin}/api/setup/teacher-password`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Strong-passphrase-1!', confirmPassword: 'Strong-passphrase-1!' }) });
    const statuses = (await Promise.all([post(), post()])).map((response) => response.status).sort();
    expect(statuses).toEqual([201, 410]);
  });

  it('supports a real IPv6 loopback authority without accepting an IPv4 Host', async () => {
    const repository = new SetupRepository();
    server = await startServer({ host: '::1', port: 0, bootstrapHandler: createFirstRunSetupHandler({ repository, hashPassword: async () => '$argon2id$test' }) });
    const origin = `http://[::1]:${server.port}`;
    expect((await fetch(`${origin}/setup`)).status).toBe(200);
    const csrf = await fetch(`${origin}/api/setup/csrf`);
    const cookie = csrf.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('missing setup cookie');
    const token = (await csrf.json() as { csrfToken: string }).csrfToken;
    const accepted = await fetch(`${origin}/api/setup/teacher-password`, { method: 'POST', headers: { origin, cookie, 'x-csrf-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Strong-passphrase-1!', confirmPassword: 'Strong-passphrase-1!' }) });
    expect(accepted.status).toBe(201);
  });

  it('treats a malformed setup cookie as an invalid CSRF token', async () => {
    const repository = new SetupRepository();
    server = await startServer({ host: '127.0.0.1', port: 0, bootstrapHandler: createFirstRunSetupHandler({ repository }) });
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${origin}/api/setup/teacher-password`, { method: 'POST', headers: { origin, cookie: 'lan_classroom_first_run=%', 'x-csrf-token': 'invalid', 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(403);
  });
});
