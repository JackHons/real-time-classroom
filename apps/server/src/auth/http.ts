import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthSessionRepository } from '../db/auth-session-repository.js';
import type { ClassId, Student } from '../domain/types.js';
import { verifyTeacherPassword } from './password.js';
import { AuthSessions, STUDENT_SESSION_COOKIE, TEACHER_SESSION_COOKIE } from './session.js';

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;

export type StudentJoinRequest = Readonly<{ classId: ClassId; displayName: string; studentNumber: string }>;

/** Task 4 supplies roster/pending-request behaviour behind this narrow port. */
export interface StudentJoinPort {
  join(request: StudentJoinRequest): Promise<Student | undefined> | Student | undefined;
}

export type PasswordVerifier = (password: string, storedHash: string | undefined) => Promise<boolean>;
export type AuthHttpHandlerOptions = Readonly<{
  sessions: AuthSessions;
  sessionRepository: Pick<AuthSessionRepository, 'teacherPasswordHash'>;
  studentJoin: StudentJoinPort;
  /** Explicit same-origin value, e.g. http://192.168.1.20:4173. Required for every POST. */
  allowedOrigin: string;
  csrfSecret: string;
  passwordVerifier?: PasswordVerifier;
  loginRateLimiter?: LoginRateLimiter;
}>;

type LoginBody = Readonly<{ password?: unknown }>;
type StudentJoinBody = Readonly<{ classId?: unknown; displayName?: unknown; studentNumber?: unknown }>;

export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(private readonly maximum = 5, private readonly windowMs = 15 * 60 * 1000) {}

  allow(key: string, now: Date): boolean {
    const threshold = now.getTime() - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((time) => time > threshold);
    if (recent.length >= this.maximum) { this.attempts.set(key, recent); return false; }
    recent.push(now.getTime());
    this.attempts.set(key, recent);
    return true;
  }
}

/**
 * Standalone HTTP listener for composition by a later bootstrap task. It never
 * installs itself into server.ts, so tests and composition can inject a safe
 * StudentJoinPort rather than reaching trusted persistence directly.
 */
export function createAuthHttpHandler(options: AuthHttpHandlerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const rateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  const verifyPassword = options.passwordVerifier ?? verifyTeacherPassword;
  return async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://auth.local').pathname;
    if (!pathname.startsWith('/api/auth/')) { json(response, 404, { error: 'NOT_FOUND' }); return; }

    if (request.method === 'POST' && !hasAllowedOrigin(request, options.allowedOrigin)) {
      json(response, 403, { error: 'ORIGIN_REQUIRED' }); return;
    }

    try {
      if (request.method === 'POST' && pathname === '/api/auth/teacher/login') {
        const body = await readJson<LoginBody>(request);
        if (typeof body.password !== 'string') { json(response, 400, { error: 'INVALID_REQUEST' }); return; }
        if (!rateLimiter.allow(`teacher:${remoteAddress(request)}`, new Date())) { json(response, 429, { error: 'RATE_LIMITED' }); return; }
        if (!await verifyPassword(body.password, options.sessionRepository.teacherPasswordHash())) { json(response, 401, { error: 'INVALID_CREDENTIALS' }); return; }
        const login = options.sessions.createTeacherSession();
        setSessionCookie(response, TEACHER_SESSION_COOKIE, login.token);
        json(response, 200, { actor: 'teacher', csrfToken: csrfToken(login.token, options.csrfSecret) }); return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/student/join') {
        const body = await readJson<StudentJoinBody>(request);
        if (!isStudentJoinBody(body)) { json(response, 400, { error: 'INVALID_REQUEST' }); return; }
        if (!rateLimiter.allow(`student:${remoteAddress(request)}:${body.classId}`, new Date())) { json(response, 429, { error: 'RATE_LIMITED' }); return; }
        const student = await options.studentJoin.join({ classId: body.classId as ClassId, displayName: body.displayName, studentNumber: body.studentNumber });
        if (student === undefined) { json(response, 403, { error: 'STUDENT_JOIN_NOT_APPROVED' }); return; }
        const login = options.sessions.createStudentSession(student);
        setSessionCookie(response, STUDENT_SESSION_COOKIE, login.token);
        json(response, 200, { actor: 'student', csrfToken: csrfToken(login.token, options.csrfSecret) }); return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        const cookies = parseCookies(request.headers.cookie);
        const teacherToken = cookies[TEACHER_SESSION_COOKIE];
        const studentToken = cookies[STUDENT_SESSION_COOKIE];
        const token = teacherToken ?? studentToken;
        if (token !== undefined && !isValidCsrfToken(request.headers['x-csrf-token'], token, options.csrfSecret)) { json(response, 403, { error: 'CSRF_REQUIRED' }); return; }
        if (teacherToken !== undefined) options.sessions.logoutTeacher(teacherToken);
        if (studentToken !== undefined) options.sessions.logoutStudent(studentToken);
        clearSessionCookie(response, TEACHER_SESSION_COOKIE);
        clearSessionCookie(response, STUDENT_SESSION_COOKIE);
        response.writeHead(204); response.end(); return;
      }

      if (request.method === 'GET' && pathname === '/api/auth/session') {
        const cookies = parseCookies(request.headers.cookie);
        const teacher = options.sessions.authenticateTeacher(cookies[TEACHER_SESSION_COOKIE]);
        if (teacher !== undefined) { json(response, 200, { actor: 'teacher' }); return; }
        const student = options.sessions.authenticateStudent(cookies[STUDENT_SESSION_COOKIE]);
        if (student !== undefined) { json(response, 200, { actor: 'student', classId: student.classId }); return; }
        json(response, 401, { error: 'UNAUTHENTICATED' }); return;
      }

      json(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof RequestBodyError) { json(response, 400, { error: 'INVALID_REQUEST' }); return; }
      if (error instanceof Error && error.message === 'STUDENT_SESSION_ALREADY_ACTIVE') { json(response, 409, { error: error.message }); return; }
      json(response, 500, { error: 'AUTH_INTERNAL_ERROR' });
    }
  };
}

export function csrfToken(sessionToken: string, secret: string): string { return createHmac('sha256', secret).update(sessionToken).digest('base64url'); }

/** Shared by the composition root so every cookie-authenticated mutation has identical CSRF verification. */
export function isValidCsrfToken(header: string | string[] | undefined, sessionToken: string, secret: string): boolean {
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(csrfToken(sessionToken, secret));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hasAllowedOrigin(request: IncomingMessage, allowedOrigin: string): boolean { return allowedOrigin.length > 0 && request.headers.origin === allowedOrigin; }
function remoteAddress(request: IncomingMessage): string { return request.socket.remoteAddress ?? 'unknown'; }
function isStudentJoinBody(body: StudentJoinBody): body is Readonly<{ classId: string; displayName: string; studentNumber: string }> {
  return typeof body.classId === 'string' && body.classId.length > 0 && typeof body.displayName === 'string' && body.displayName.trim().length > 0 && typeof body.studentNumber === 'string' && body.studentNumber.trim().length > 0;
}

class RequestBodyError extends Error {}
async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestBodyError();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    try { cookies[key] = decodeURIComponent(part.slice(separator + 1).trim()); } catch { /* ignore invalid cookies */ }
  }
  return cookies;
}

function setSessionCookie(response: ServerResponse, name: string, token: string): void {
  // HTTP is intentionally supported only on the documented trusted private LAN.
  // Secure is omitted because a Secure cookie would not be returned over HTTP.
  response.setHeader('set-cookie', `${name}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(response: ServerResponse, name: string): void {
  const existing = response.getHeader('set-cookie');
  const clear = `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
  response.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)]), clear]);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
