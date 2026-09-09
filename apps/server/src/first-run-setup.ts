import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import argon2 from 'argon2';
import { TEACHER_PASSWORD_ARGON2_POLICY } from './auth/password.js';
import type { AuthSessionRepository } from './db/auth-session-repository.js';
import type { HttpRouteHandler } from './server.js';

const MAX_BODY_BYTES = 2_048;
const SETUP_COOKIE = 'lan_classroom_first_run';
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

export type FirstRunSetupOptions = Readonly<{
  repository: Pick<AuthSessionRepository, 'teacherPasswordHash' | 'setTeacherPasswordHashIfAbsent'>;
  now?: () => Date;
  hashPassword?: (password: string) => Promise<string>;
}>;

/**
 * First-run is intentionally a separate, very small HTTP surface.  It trusts
 * neither Host forwarding headers nor proxy client-address headers: a request
 * must be a direct TCP loopback request addressed to literal 127.0.0.1.
 */
export function createFirstRunSetupHandler(options: FirstRunSetupOptions): HttpRouteHandler {
  const now = options.now ?? (() => new Date());
  const hashPassword = options.hashPassword ?? ((password) => argon2.hash(password, TEACHER_PASSWORD_ARGON2_POLICY));
  const attempts = new Map<string, number[]>();
  let bootstrapSecret = randomBytes(32).toString('base64url');
  return async (request, response) => {
    // Use the TCP listener's actual local port, rather than a configured
    // value. This remains exact when a test or a local operator uses port 0.
    const expectedHost = `127.0.0.1:${request.socket.localPort}`;
    const expectedOrigin = `http://${expectedHost}`;
    const pathname = new URL(request.url ?? '/', expectedOrigin).pathname;
    if (pathname !== '/setup' && pathname !== '/api/setup/csrf' && pathname !== '/api/setup/teacher-password') return false;
    if (!isDirectLoopback(request) || request.headers.host !== expectedHost || hasProxyHeaders(request)) {
      sendJson(response, 404, { error: 'NOT_FOUND' }); return true;
    }
    if (options.repository.teacherPasswordHash() !== undefined) {
      sendJson(response, 410, { error: 'SETUP_GONE' }); return true;
    }
    if (pathname === '/setup' && request.method === 'GET') { sendSetupPage(response); return true; }
    if (pathname === '/api/setup/csrf' && request.method === 'GET') {
      // A fresh secret invalidates a copied or stale setup page without ever
      // accepting a browser-supplied bootstrap secret.
      bootstrapSecret = randomBytes(32).toString('base64url');
      response.setHeader('set-cookie', `${SETUP_COOKIE}=${encodeURIComponent(bootstrapSecret)}; Max-Age=600; Path=/api/setup; HttpOnly; SameSite=Strict`);
      sendJson(response, 200, { csrfToken: csrfToken(bootstrapSecret) }); return true;
    }
    if (pathname !== '/api/setup/teacher-password' || request.method !== 'POST') { sendJson(response, 404, { error: 'NOT_FOUND' }); return true; }
    if (request.headers.origin !== expectedOrigin || !validCsrf(request, bootstrapSecret)) { sendJson(response, 403, { error: 'SETUP_CSRF_REQUIRED' }); return true; }
    const address = request.socket.remoteAddress ?? 'unknown';
    const time = now().getTime();
    const prior = (attempts.get(address) ?? []).filter((item) => time - item < WINDOW_MS);
    if (prior.length >= MAX_ATTEMPTS) { attempts.set(address, prior); sendJson(response, 429, { error: 'SETUP_RATE_LIMITED' }); return true; }
    // Consume the bounded attempt before parsing: malformed bodies cannot be
    // used to bypass the same local rate budget.
    prior.push(time); attempts.set(address, prior);
    try {
      const body = await readJson(request);
      if (!isPasswordBody(body) || body.password !== body.confirmPassword || !isStrongPassword(body.password)) {
        sendJson(response, 400, { error: 'SETUP_PASSWORD_POLICY' }); return true;
      }
      const hash = await hashPassword(body.password);
      // INSERT ... DO NOTHING is the race arbiter.  Hashing is outside the DB
      // transaction; only the winning request can persist a credential.
      if (!options.repository.setTeacherPasswordHashIfAbsent(hash, now().toISOString() as never)) {
        sendJson(response, 410, { error: 'SETUP_GONE' }); return true;
      }
      bootstrapSecret = randomBytes(32).toString('base64url');
      response.setHeader('set-cookie', `${SETUP_COOKIE}=; Max-Age=0; Path=/api/setup; HttpOnly; SameSite=Strict`);
      sendJson(response, 201, { status: 'configured' }); return true;
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof BodyTooLarge) { sendJson(response, 400, { error: 'INVALID_REQUEST' }); return true; }
      sendJson(response, 500, { error: 'SETUP_INTERNAL_ERROR' }); return true;
    }
  };
}

export function isStrongPassword(password: string): boolean {
  // NFKC is not applied: changing a submitted secret before hashing is an
  // avoidable surprise. Length is measured in Unicode code points.
  return [...password].length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^\p{L}\p{N}\s]/u.test(password);
}

function isPasswordBody(value: unknown): value is Readonly<{ password: string; confirmPassword: string }> {
  return typeof value === 'object' && value !== null && typeof (value as { password?: unknown }).password === 'string' && typeof (value as { confirmPassword?: unknown }).confirmPassword === 'string';
}
function isDirectLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function hasProxyHeaders(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some((name) => name === 'via' || name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'));
}
function validCsrf(request: IncomingMessage, secret: string): boolean {
  const cookie = parseCookie(request.headers.cookie, SETUP_COOKIE);
  const header = request.headers['x-csrf-token'];
  if (cookie === undefined || header === undefined || typeof header !== 'string' || cookie !== secret) return false;
  const expected = Buffer.from(csrfToken(secret)); const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function csrfToken(secret: string): string { return createHmac('sha256', secret).update('first-run-setup').digest('base64url'); }
function parseCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) { const index = part.indexOf('='); if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim()); }
  return undefined;
}
class BodyTooLarge extends Error {}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += buffer.length; if (size > MAX_BODY_BYTES) throw new BodyTooLarge(); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function sendJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function sendSetupPage(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
  response.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>首次設定｜LAN 課堂平台</title><style>body{font:16px system-ui;max-width:36rem;margin:3rem auto;padding:1rem}label,input,button{display:block;width:100%;box-sizing:border-box;margin:.7rem 0}input,button{min-height:44px;padding:.55rem}button{background:#064a9b;color:#fff;border:0;border-radius:.3rem}.error{color:#a22b18}</style><main><h1>設定教師共用密碼</h1><p>此頁只在本機可開啟，完成後會永久關閉。</p><form id="setup"><label>新密碼（至少 12 字元，含大小寫、數字與符號）<input id="password" type="password" autocomplete="new-password" required></label><label>再次確認密碼<input id="confirm" type="password" autocomplete="new-password" required></label><button>完成設定</button><p id="message" class="error" role="alert"></p></form></main><script>const m=document.querySelector('#message'),f=document.querySelector('#setup'),p=document.querySelector('#password'),c2=document.querySelector('#confirm');(async()=>{const r=await fetch('/api/setup/csrf',{credentials:'same-origin'});if(!r.ok){m.textContent='首次設定已不可使用。';return}const c=(await r.json()).csrfToken;f.addEventListener('submit',async e=>{e.preventDefault();const r=await fetch('/api/setup/teacher-password',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-csrf-token':c},body:JSON.stringify({password:p.value,confirmPassword:c2.value})});m.textContent=r.ok?'設定完成，請重新整理或重新啟動服務後登入。':'設定失敗，請確認密碼規則或重新載入頁面。';if(r.ok)f.querySelector('button').disabled=true})})().catch(()=>m.textContent='無法建立安全設定工作階段。')</script></html>`);
}
