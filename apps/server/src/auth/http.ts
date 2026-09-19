import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthSessionRepository } from '../db/auth-session-repository.js';
import type { ClassId, Student } from '../domain/types.js';
import { verifyTeacherPassword } from './password.js';
import { AuthSessions, STUDENT_SESSION_COOKIE, TEACHER_SESSION_COOKIE } from './session.js';
import { isAsciiDigitStudentNumber } from '../domain/normalization.js';
import { readBoundedJsonObject } from '../http/bounded-json.js';
import { closeUnconsumedRequestBody } from '../http/rejected-request.js';

const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const MAX_BODY_BYTES = 8 * 1024;

export type StudentJoinRequest = Readonly<{ classId: ClassId; studentNumber: string; displayName?: string }>;

/** Task 4 supplies roster/pending-request behaviour behind this narrow port. */
export interface StudentJoinPort {
  join(request: StudentJoinRequest): Promise<Student | undefined> | Student | undefined;
  /**
   * Optional durable dashboard update. Implementations that support it run
   * only after the session insert succeeds, so a different active device
   * cannot make a failed retry look like a new classroom entry.
   */
  recordAuthenticatedJoin?: (student: Student) => Promise<void> | void;
}

export type PasswordVerifier = (password: string, storedHash: string | undefined) => Promise<boolean>;
export type PasswordVerificationLimiter = Readonly<{ reserve: () => PasswordVerificationAdmission }>;
export type AuthHttpHandlerOptions = Readonly<{
  sessions: AuthSessions;
  sessionRepository: Pick<AuthSessionRepository, 'teacherPasswordHash'>;
  studentJoin: StudentJoinPort;
  /** Explicit same-origin value, e.g. http://192.168.1.20:4173. Required for every POST. */
  allowedOrigin: string;
  csrfSecret: string;
  passwordVerifier?: PasswordVerifier;
  /** Defaults to the process-wide Argon2 admission gate. */
  passwordVerificationLimiter?: PasswordVerificationLimiter;
  loginRateLimiter?: LoginRateLimiter;
  studentJoinRateLimiter?: StudentJoinRateLimiter;
  /** Receives a private reason for a deliberately generic student-facing denial. */
  auditStudentJoinDenial?: (entry: Readonly<{ code: 'STUDENT_JOIN_NOT_APPROVED' | 'STUDENT_SESSION_ALREADY_ACTIVE'; remoteAddress: string; classId: ClassId }>) => void;
  /** Best-effort socket eviction after the durable leave + session revoke. */
  onStudentLeft?: (entry: Readonly<{ studentSessionId: string; studentId: string; classId: ClassId }>) => void;
}>;

type LoginBody = Readonly<{ password?: unknown }>;
type StudentJoinBody = Readonly<{ classId?: unknown; displayName?: unknown; studentNumber?: unknown }>;

export class LoginRateLimiter {
  private readonly attempts = new Map<string, Readonly<{ failures: number[]; reservations: Map<number, number>; lastAccessedAt: number }>>();
  private nextReservation = 0;
  constructor(private readonly maximum = 5, private readonly windowMs = 15 * 60 * 1000, private readonly maximumEntries = 1_024, private readonly reservationTtlMs = Math.min(windowMs, 60_000)) {}

  /** Checks a failure-only budget; this never records a successful request. */
  allow(key: string, now: Date): boolean {
    const timestamp = now.getTime();
    this.cleanup(timestamp);
    const existing = this.attempts.get(key);
    if (existing === undefined) return true;
    const failures = this.recent(existing.failures, timestamp);
    const reservations = this.recentReservations(existing.reservations, timestamp);
    this.attempts.set(key, { failures, reservations, lastAccessedAt: timestamp });
    return failures.length + reservations.size < this.maximum;
  }

  /** Atomically occupies capacity before an expensive asynchronous operation. */
  reserve(key: string, now: Date): RateLimitReservation | undefined {
    const timestamp = now.getTime();
    this.cleanup(timestamp);
    const entry = this.entryFor(key, timestamp);
    if (entry === undefined || entry.failures.length + entry.reservations.size >= this.maximum) return undefined;
    const id = this.nextReservation++;
    entry.reservations.set(id, timestamp);
    this.attempts.set(key, { ...entry, lastAccessedAt: timestamp });
    let completed = false;
    return {
      release: () => { if (!completed) { completed = true; this.release(key, id, new Date()); } },
      fail: () => { if (!completed) { completed = true; this.failReservation(key, id, new Date()); } },
      succeed: () => { if (!completed) { completed = true; this.succeedReservation(key, id, new Date()); } }
    };
  }

  recordFailure(key: string, now: Date): void {
    const timestamp = now.getTime();
    this.cleanup(timestamp);
    const entry = this.entryFor(key, timestamp);
    if (entry === undefined) return;
    this.attempts.set(key, { ...entry, failures: [...entry.failures, timestamp], lastAccessedAt: timestamp });
  }

  clear(key: string): void { this.attempts.delete(key); }

  private recent(failures: readonly number[], timestamp: number): number[] { return failures.filter((time) => time > timestamp - this.windowMs); }
  private recentReservations(reservations: ReadonlyMap<number, number>, timestamp: number): Map<number, number> {
    return new Map([...reservations].filter(([, time]) => time > timestamp - this.reservationTtlMs));
  }
  private cleanup(timestamp: number): void {
    for (const [key, entry] of this.attempts) {
      const failures = this.recent(entry.failures, timestamp);
      const reservations = this.recentReservations(entry.reservations, timestamp);
      if (failures.length === 0 && reservations.size === 0) this.attempts.delete(key);
      else if (failures.length !== entry.failures.length || reservations.size !== entry.reservations.size) this.attempts.set(key, { failures, reservations, lastAccessedAt: entry.lastAccessedAt });
    }
  }
  private entryFor(key: string, timestamp: number): { failures: number[]; reservations: Map<number, number>; lastAccessedAt: number } | undefined {
    const existing = this.attempts.get(key);
    if (existing !== undefined) return { failures: this.recent(existing.failures, timestamp), reservations: this.recentReservations(existing.reservations, timestamp), lastAccessedAt: timestamp };
    if (!this.evictOneIfFull()) return undefined;
    return { failures: [], reservations: new Map(), lastAccessedAt: timestamp };
  }
  private release(key: string, id: number, now: Date): void {
    const entry = this.attempts.get(key); if (entry === undefined) return;
    const reservations = this.recentReservations(entry.reservations, now.getTime());
    reservations.delete(id);
    this.writeOrDelete(key, { failures: this.recent(entry.failures, now.getTime()), reservations, lastAccessedAt: now.getTime() });
  }
  private failReservation(key: string, id: number, now: Date): void {
    const entry = this.attempts.get(key); if (entry === undefined) return;
    const timestamp = now.getTime(); const reservations = this.recentReservations(entry.reservations, timestamp);
    if (!reservations.delete(id)) return;
    this.writeOrDelete(key, { failures: [...this.recent(entry.failures, timestamp), timestamp], reservations, lastAccessedAt: timestamp });
  }
  private succeedReservation(key: string, id: number, now: Date): void {
    const entry = this.attempts.get(key); if (entry === undefined) return;
    const timestamp = now.getTime(); const reservations = this.recentReservations(entry.reservations, timestamp);
    reservations.delete(id);
    // A successful teacher login resets its prior failure bucket, while active
    // concurrent reservations remain protected from oversubscription.
    this.writeOrDelete(key, { failures: [], reservations, lastAccessedAt: timestamp });
  }
  private writeOrDelete(key: string, entry: Readonly<{ failures: number[]; reservations: Map<number, number>; lastAccessedAt: number }>): void {
    if (entry.failures.length === 0 && entry.reservations.size === 0) this.attempts.delete(key);
    else this.attempts.set(key, entry);
  }
  private evictOneIfFull(): boolean {
    if (this.attempts.size < this.maximumEntries) return true;
    let oldest: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.attempts) {
      if (entry.reservations.size === 0 && entry.lastAccessedAt < oldestAccess) { oldest = key; oldestAccess = entry.lastAccessedAt; }
    }
    if (oldest !== undefined) this.attempts.delete(oldest);
    return this.attempts.size < this.maximumEntries;
  }
}

export type RateLimitReservation = Readonly<{ release: () => void; fail: () => void; succeed: () => void }>;

export type PasswordVerificationAdmission = Readonly<{ reservation: Promise<PasswordVerificationReservation | undefined>; cancel: () => void }>;
export type PasswordVerificationReservation = Readonly<{ release: () => void }>;

/**
 * A bounded asynchronous semaphore for deliberately expensive password work.
 * The default instance below is process-global: changing source addresses must
 * not turn the per-IP rate limiter into an Argon2 parallelism bypass.
 */
export class BoundedPasswordVerificationLimiter implements PasswordVerificationLimiter {
  private active = 0;
  private readonly waiting: Array<Readonly<{ grant: (reservation: PasswordVerificationReservation | undefined) => void; cancelled: () => boolean }>> = [];

  constructor(private readonly maximumActive = 3, private readonly maximumQueued = 21) {
    if (!Number.isSafeInteger(maximumActive) || !Number.isSafeInteger(maximumQueued) || maximumActive < 2 || maximumActive > 4 || maximumQueued < 0) throw new Error('PASSWORD_VERIFICATION_LIMIT_INVALID');
  }

  reserve(): PasswordVerificationAdmission {
    let reservation: PasswordVerificationReservation | undefined;
    let cancelled = false;
    let grant!: (value: PasswordVerificationReservation | undefined) => void;
    let queued: Readonly<{ grant: (reservation: PasswordVerificationReservation | undefined) => void; cancelled: () => boolean }> | undefined;
    const pending = new Promise<PasswordVerificationReservation | undefined>((resolve) => { grant = resolve; });
    const give = (): void => {
      if (cancelled) { grant(undefined); return; }
      this.active += 1;
      let released = false;
      reservation = { release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      } };
      grant(reservation);
    };
    if (this.active < this.maximumActive) give();
    else if (this.waiting.length >= this.maximumQueued) grant(undefined);
    else {
      queued = { grant: () => give(), cancelled: () => cancelled };
      this.waiting.push(queued);
    }
    return {
      reservation: pending,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (reservation !== undefined) reservation.release();
        else {
          const index = this.waiting.findIndex((entry) => entry === queued);
          if (index >= 0) this.waiting.splice(index, 1);
          grant(undefined);
        }
      }
    };
  }

  private drain(): void {
    while (this.active < this.maximumActive && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      if (!next.cancelled()) next.grant(undefined);
    }
  }
}

const processPasswordVerificationLimiter = new BoundedPasswordVerificationLimiter();

/** Shared limiter for both public student-join routes. Identity is scoped to a
 * class; the higher class/IP backstop remains friendly to a classroom NAT. */
export class StudentJoinRateLimiter {
  private readonly identities: LoginRateLimiter;
  private readonly classIps: LoginRateLimiter;
  constructor(identityMaximum = 5, classIpMaximum = 50, windowMs = 15 * 60 * 1000, maximumEntries = 1_024) {
    this.identities = new LoginRateLimiter(identityMaximum, windowMs, maximumEntries);
    this.classIps = new LoginRateLimiter(classIpMaximum, windowMs, maximumEntries);
  }

  reserve(address: string, request: Readonly<{ classId: string; studentNumber: string }>, now: Date): RateLimitReservation | undefined {
    const identity = this.identities.reserve(studentIdentityRateKey(request), now);
    if (identity === undefined) return undefined;
    const classIp = this.classIps.reserve(studentClassIpRateKey(address, request.classId), now);
    if (classIp === undefined) { identity.release(); return undefined; }
    let completed = false;
    return {
      release: () => { if (!completed) { completed = true; identity.release(); classIp.release(); } },
      // Pending and denied joins consume a bounded budget. This prevents either
      // public endpoint from growing pending rows without limit.
      fail: () => { if (!completed) { completed = true; identity.fail(); classIp.fail(); } },
      // A roster match consumes neither identity nor classroom/NAT capacity.
      succeed: () => { if (!completed) { completed = true; identity.release(); classIp.release(); } }
    };
  }
}

/**
 * Standalone HTTP listener for composition by a later bootstrap task. It never
 * installs itself into server.ts, so tests and composition can inject a safe
 * StudentJoinPort rather than reaching trusted persistence directly.
 */
export function createAuthHttpHandler(options: AuthHttpHandlerOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const rateLimiter = options.loginRateLimiter ?? new LoginRateLimiter();
  // Identity failures protect a particular pupil without allowing five valid
  // joins behind one NAT address to lock out the rest of a class. A much higher
  // IP-only failure budget still limits broad credential spraying.
  const studentJoinRateLimiter = options.studentJoinRateLimiter ?? new StudentJoinRateLimiter();
  const verifyPassword = options.passwordVerifier ?? verifyTeacherPassword;
  const passwordVerificationLimiter = options.passwordVerificationLimiter ?? processPasswordVerificationLimiter;
  return async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://auth.local').pathname;
    if (!pathname.startsWith('/api/auth/')) { json(request, response, 404, { error: 'NOT_FOUND' }); return; }

    if (request.method === 'POST' && !hasAllowedOrigin(request, options.allowedOrigin)) {
      json(request, response, 403, { error: 'ORIGIN_REQUIRED' }); return;
    }

    try {
      if (request.method === 'POST' && pathname === '/api/auth/teacher/login') {
        const body = await readJson<LoginBody>(request);
        if (typeof body.password !== 'string') { json(request, response, 400, { error: 'INVALID_REQUEST' }); return; }
        const now = new Date();
        const rateKey = `teacher:${remoteAddress(request)}`;
        const reservation = rateLimiter.reserve(rateKey, now);
        if (reservation === undefined) { json(request, response, 429, { error: 'RATE_LIMITED' }); return; }
        const admission = passwordVerificationLimiter.reserve();
        let verified: boolean;
        let verifierReservation: PasswordVerificationReservation | undefined;
        const releaseOnAbort = () => { admission.cancel(); reservation.release(); };
        request.once('aborted', releaseOnAbort);
        try {
          verifierReservation = await admission.reservation;
          if (verifierReservation === undefined) { reservation.release(); if (!request.aborted) json(request, response, 429, { error: 'RATE_LIMITED' }); return; }
          verified = await verifyPassword(body.password, options.sessionRepository.teacherPasswordHash());
        } catch (error) { reservation.release(); throw error; }
        finally { verifierReservation?.release(); request.removeListener('aborted', releaseOnAbort); }
        if (request.aborted) return;
        if (!verified) {
          reservation.fail();
          json(request, response, 401, { error: 'INVALID_CREDENTIALS' }); return;
        }
        reservation.succeed();
        const login = options.sessions.createTeacherSession();
        setSessionCookie(response, TEACHER_SESSION_COOKIE, login.token);
        json(request, response, 200, { actor: 'teacher', csrfToken: csrfToken(login.token, options.csrfSecret) }); return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/student/join') {
        const body = await readJson<StudentJoinBody>(request);
        if (!isStudentJoinBody(body)) { json(request, response, 400, { error: 'INVALID_REQUEST' }); return; }
        if (!isAsciiDigitStudentNumber(body.studentNumber)) { json(request, response, 400, { error: 'STUDENT_NUMBER_DIGITS_ONLY' }); return; }
        const now = new Date();
        const address = remoteAddress(request);
        const reservation = studentJoinRateLimiter.reserve(address, body, now);
        if (reservation === undefined) { json(request, response, 429, { error: 'RATE_LIMITED' }); return; }
        const denyStudentJoin = (code: 'STUDENT_JOIN_NOT_APPROVED' | 'STUDENT_SESSION_ALREADY_ACTIVE') => {
          reservation.fail();
          options.auditStudentJoinDenial?.({ code, remoteAddress: address, classId: body.classId as ClassId });
          json(request, response, 403, { error: 'STUDENT_ACCESS_DENIED' });
        };
        let student: Student | undefined;
        const releaseOnAbort = () => reservation.release();
        request.once('aborted', releaseOnAbort);
        try { student = await options.studentJoin.join({ classId: body.classId as ClassId, studentNumber: body.studentNumber, ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}) }); }
        catch (error) { reservation.release(); throw error; }
        finally { request.removeListener('aborted', releaseOnAbort); }
        if (request.aborted) return;
        if (student === undefined) { denyStudentJoin('STUDENT_JOIN_NOT_APPROVED'); return; }
        let login;
        try { login = options.sessions.createStudentSession(student); }
        catch (error) {
          if (error instanceof Error && error.message === 'STUDENT_SESSION_ALREADY_ACTIVE') { denyStudentJoin('STUDENT_SESSION_ALREADY_ACTIVE'); return; }
          throw error;
        }
        try { await options.studentJoin.recordAuthenticatedJoin?.(student); }
        catch (error) {
          // No cookie has been sent yet.  Roll back the just-created session
          // rather than leaving an unreachable active session behind.
          options.sessions.logoutStudent(login.token);
          reservation.release();
          throw error;
        }
        reservation.succeed();
        setSessionCookie(response, STUDENT_SESSION_COOKIE, login.token);
        json(request, response, 200, { actor: 'student', csrfToken: csrfToken(login.token, options.csrfSecret), sessionId: login.session.id }); return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/student/leave') {
        const token = parseCookies(request.headers.cookie)[STUDENT_SESSION_COOKIE];
        if (token === undefined || !isValidCsrfToken(request.headers['x-csrf-token'], token, options.csrfSecret)) { json(request, response, 403, { error: 'CSRF_REQUIRED' }); return; }
        const left = options.sessions.leaveStudentSession(token);
        if (left === undefined) { clearSessionCookie(response, STUDENT_SESSION_COOKIE); json(request, response, 401, { error: 'STUDENT_AUTH_REQUIRED' }); return; }
        try { options.onStudentLeft?.(left); } catch { /* durable leave is authoritative */ }
        clearSessionCookie(response, STUDENT_SESSION_COOKIE);
        response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        const cookies = parseCookies(request.headers.cookie);
        const teacherToken = cookies[TEACHER_SESSION_COOKIE];
        const studentToken = cookies[STUDENT_SESSION_COOKIE];
        const token = teacherToken ?? studentToken;
        if (token !== undefined && !isValidCsrfToken(request.headers['x-csrf-token'], token, options.csrfSecret)) { json(request, response, 403, { error: 'CSRF_REQUIRED' }); return; }
        if (teacherToken !== undefined) options.sessions.logoutTeacher(teacherToken);
        if (studentToken !== undefined) options.sessions.logoutStudent(studentToken);
        clearSessionCookie(response, TEACHER_SESSION_COOKIE);
        clearSessionCookie(response, STUDENT_SESSION_COOKIE);
        response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); return;
      }

      if (request.method === 'GET' && pathname === '/api/auth/session') {
        const cookies = parseCookies(request.headers.cookie);
        const teacher = options.sessions.authenticateTeacher(cookies[TEACHER_SESSION_COOKIE]);
        if (teacher !== undefined) { json(request, response, 200, { actor: 'teacher' }); return; }
        const student = options.sessions.authenticateStudent(cookies[STUDENT_SESSION_COOKIE]);
        if (student !== undefined) { json(request, response, 200, { actor: 'student', classId: student.classId, sessionId: student.studentSessionId }); return; }
        json(request, response, 401, { error: 'UNAUTHENTICATED' }); return;
      }

      // A restored page needs a CSRF token without putting any session secret
      // in web storage.  The non-simple header plus Fetch Metadata make this a
      // same-origin bootstrap, rather than a permissive Origin fallback.
      if (request.method === 'POST' && pathname === '/api/auth/teacher/csrf') {
        if (!hasCsrfBootstrapProof(request, options.allowedOrigin)) { json(request, response, 403, { error: 'ORIGIN_REQUIRED' }); return; }
        const token = parseCookies(request.headers.cookie)[TEACHER_SESSION_COOKIE];
        if (options.sessions.authenticateTeacher(token) === undefined) { json(request, response, 401, { error: 'TEACHER_AUTH_REQUIRED' }); return; }
        json(request, response, 200, { csrfToken: csrfToken(token!, options.csrfSecret) }); return;
      }

      if (request.method === 'POST' && pathname === '/api/auth/student/csrf') {
        // Chromium omits Origin on a same-origin fetch. This is a dedicated
        // bootstrap protocol, not a permissive Origin fallback: the client
        // must opt in with a non-simple header and the browser must attest a
        // same-origin fetch. If Origin is present it must still match exactly.
        if (!hasCsrfBootstrapProof(request, options.allowedOrigin)) { json(request, response, 403, { error: 'ORIGIN_REQUIRED' }); return; }
        const token = parseCookies(request.headers.cookie)[STUDENT_SESSION_COOKIE];
        const student = options.sessions.authenticateStudent(token);
        if (student === undefined) { json(request, response, 401, { error: 'STUDENT_AUTH_REQUIRED' }); return; }
        // authenticateStudent succeeds only for a defined, still-active token.
        json(request, response, 200, { csrfToken: csrfToken(token!, options.csrfSecret) }); return;
      }

      json(request, response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof RequestBodyError) { json(request, response, 400, { error: 'INVALID_REQUEST' }); return; }
      json(request, response, 500, { error: 'AUTH_INTERNAL_ERROR' });
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
function hasCsrfBootstrapProof(request: IncomingMessage, allowedOrigin: string): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== allowedOrigin) return false;
  return allowedOrigin.length > 0 && request.headers['x-csrf-bootstrap'] === '1' && request.headers['sec-fetch-site'] === 'same-origin';
}
function remoteAddress(request: IncomingMessage): string { return request.socket.remoteAddress ?? 'unknown'; }
function studentIdentityRateKey(body: Readonly<{ classId: string; studentNumber: string }>): string {
  const normalize = (value: string) => value.normalize('NFKC').trim().toUpperCase();
  return `student:${normalize(body.classId)}:${normalize(body.studentNumber)}`;
}
function studentClassIpRateKey(address: string, classId: string): string { return `student-ip:${address}:${classId.normalize('NFKC').trim().toUpperCase()}`; }
function isStudentJoinBody(body: StudentJoinBody): body is Readonly<{ classId: string; studentNumber: string; displayName?: string }> {
  return typeof body.classId === 'string' && body.classId.length > 0 && typeof body.studentNumber === 'string' && body.studentNumber.trim().length > 0;
}

class RequestBodyError extends Error {}
async function readJson<T>(request: IncomingMessage): Promise<T> {
  try { return await readBoundedJsonObject(request, MAX_BODY_BYTES) as T; }
  catch { throw new RequestBodyError(); }
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

function json(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
  closeUnconsumedRequestBody(request, response);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
