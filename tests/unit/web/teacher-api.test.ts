import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TeacherApi, readableError } from '../../../apps/web/src/lib/teacher-api.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('TeacherApi', () => {
  it('keeps the CSRF token in memory and adds it only to protected mutations', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ actor: 'teacher', csrfToken: 'csrf-value' }), { status: 200 }))
      .mockResolvedValueOnce(new globalThis.Response(null, { status: 204 }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const api = new TeacherApi();
    await api.login('secret');
    await api.createClass('1A');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth/teacher/login');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' });
    expect((fetch.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers).toMatchObject({ 'x-csrf-token': 'csrf-value' });
  });

  it('does not issue a protected request without a login-derived CSRF token', async () => {
    const api = new TeacherApi();
    await expect(api.createClass('1A')).rejects.toMatchObject({ status: 401 });
  });

  it('preserves server error codes for an accessible UI message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new globalThis.Response(JSON.stringify({ error: 'CLASS_NAME_REQUIRED' }), { status: 400 })) as typeof globalThis.fetch;
    const api = new TeacherApi();
    await expect(api.login('secret')).rejects.toEqual(new ApiError(400, 'CLASS_NAME_REQUIRED'));
    expect(readableError(new ApiError(429, 'RATE_LIMITED'))).toContain('請稍候');
  });

  it('restores a teacher session with a same-origin CSRF bootstrap and returns roster validation feedback', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ actor: 'teacher' }), { status: 200 }))
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ csrfToken: 'restored' }), { status: 200 }))
      .mockResolvedValueOnce(new globalThis.Response(JSON.stringify({ rows: [], issues: [{ line: 2, message: '學號已存在於班級名單' }] }), { status: 422 }));
    globalThis.fetch = fetch as typeof globalThis.fetch;
    const api = new TeacherApi();
    await expect(api.restoreTeacher()).resolves.toBe(true);
    await expect(api.importRoster('class-1', '學號,姓名\nA1,Ada')).resolves.toMatchObject({ issues: [{ line: 2 }] });
    expect((fetch.mock.calls[1]?.[1] as { headers: Record<string, string> }).headers).toMatchObject({ 'x-csrf-bootstrap': '1' });
    expect((fetch.mock.calls[2]?.[1] as { headers: Record<string, string> }).headers).toMatchObject({ 'x-csrf-token': 'restored' });
  });
});
