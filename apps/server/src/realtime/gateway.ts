import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ClassId } from '../domain/types.js';

/** Keep this discriminator byte-for-byte aligned with the web client's allowlist. */
export type RealtimeResourceType = 'question' | 'file-task' | 'pending' | 'roster' | 'submission';
export type RealtimeChangeInput = Readonly<{ classId: ClassId; resourceType: RealtimeResourceType; id: string; event: string; audience?: 'all' | 'teacher' }>;
export type RealtimeChange = Readonly<{ resourceType: RealtimeResourceType; id: string; version: number; event: string }>;

export type RealtimeTeacher = Readonly<{ actor: 'teacher'; teacherSessionId: string }>;
export type RealtimeStudent = Readonly<{ actor: 'student'; studentSessionId: string; studentId: string; classId: ClassId }>;
export type RealtimePrincipal = RealtimeTeacher | RealtimeStudent;

export type RealtimeGatewayOptions = Readonly<{
  allowedOrigin: string;
  authenticateTeacher: (token: string | undefined) => Readonly<{ teacherSessionId: string }> | undefined;
  authenticateStudent: (token: string | undefined) => Readonly<{ studentSessionId: string; studentId: string; classId: ClassId }> | undefined;
  /** Must check both existence and this teacher's authority for the class. */
  canTeacherAccessClass: (teacher: RealtimeTeacher, classId: ClassId) => boolean;
  /** Production defaults admit 100 concurrent browser transports, including 50-client class tests. */
  maximumConnections?: number;
  heartbeatMs?: number;
  sessionCheckMs?: number;
}>;

export type RealtimeGateway = Readonly<{
  publish: (change: RealtimeChangeInput) => void;
  /** Global teacher-only invalidations (for example the shared question bank). */
  publishTeacher: (change: Omit<RealtimeChangeInput, 'classId' | 'audience'>) => void;
  /** A deleted class must not retain stale room membership. */
  evictClass: (classId: ClassId) => void;
  close: () => Promise<void>;
}>;

const ROOM_PREFIX = 'class:';
const TEACHER_GLOBAL_ROOM = 'teacher:global';
const SUBSCRIBE_EVENT = 'class:subscribe';
const CHANGE_EVENT = 'class:changed';
const REFETCH_EVENT = 'class:refetch';
const MAX_SUBSCRIBES_PER_WINDOW = 12;
const SUBSCRIBE_WINDOW_MS = 10_000;

/**
 * A deliberately tiny, lossy notification bus. Durable state remains REST-only:
 * a notification only tells a class-scoped client which resource to refetch.
 */
export class RealtimeNotificationBus {
  private readonly gateways = new Set<RealtimeGateway>();
  /** More than one explicit listener is supported by the Windows LAN launcher. */
  attach(gateway: RealtimeGateway): void { this.gateways.add(gateway); }
  publish(change: RealtimeChangeInput): void { for (const gateway of this.gateways) gateway.publish(change); }
  publishTeacher(change: Omit<RealtimeChangeInput, 'classId' | 'audience'>): void { for (const gateway of this.gateways) gateway.publishTeacher(change); }
  evictClass(classId: ClassId): void { for (const gateway of this.gateways) gateway.evictClass(classId); }
}

/** Attaches Socket.IO to the already-created single Node HTTP server. */
export function attachRealtimeGateway(server: HttpServer, options: RealtimeGatewayOptions): RealtimeGateway {
  assertAllowedOrigin(options.allowedOrigin);
  const maximumConnections = options.maximumConnections ?? 100;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const sessionCheckMs = options.sessionCheckMs ?? 30_000;
  if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1 || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000 || !Number.isSafeInteger(sessionCheckMs) || sessionCheckMs < 1_000) throw new Error('REALTIME_CONFIGURATION_INVALID');

  // Reserve at the Engine.IO handshake, not Socket.IO middleware.  A peer that
  // never authenticates still owns a transport and is therefore counted.
  let connections = 0;
  const reservations = new WeakMap<IncomingMessage, () => void>();
  const releaseTransport = (request: IncomingMessage | undefined): void => { if (request !== undefined) reservations.get(request)?.(); };
  let version = 0;
  const io = new Server(server, {
    // There are no client-to-server commands apart from a small subscription
    // request. Keep Engine.IO parsing bounded before Socket.IO sees it.
    maxHttpBufferSize: 1_024,
    pingInterval: heartbeatMs,
    pingTimeout: Math.min(10_000, heartbeatMs),
    allowRequest: (request, callback) => {
      if (!hasExactPrivateLanOrigin(request, options.allowedOrigin)) { callback('ORIGIN_FORBIDDEN', false); return; }
      const query = request.url === undefined ? undefined : new URL(request.url, 'http://engine.local').searchParams;
      // Engine.IO rejects these before creating a transport. Do not reserve a
      // connection for a malformed handshake that can never emit close.
      if (query?.get('EIO') !== '4' || !isEngineTransport(query.get('transport'))) { callback(null, true); return; }
      // Engine.IO only creates a transport for requests without a sid.
      if (query.has('sid')) { callback(null, true); return; }
      if (connections >= maximumConnections) { callback('REALTIME_CONNECTION_LIMIT', false); return; }
      connections += 1;
      let released = false;
      reservations.set(request, () => { if (!released) { released = true; connections -= 1; } });
      callback(null, true);
    }
  });

  io.engine.on('connection', (transport) => {
    // An Engine.IO close includes unauthenticated handshakes and failed Socket.IO
    // upgrades. It is the one ownership boundary for the reservation.
    transport.once('close', () => releaseTransport(transport.request));
  });

  io.use((socket, next) => {
    const principal = authenticate(socket.handshake.headers.cookie, options);
    if (principal === undefined) {
      // Namespace authentication happens after Engine.IO has allocated the
      // transport. Release that reservation and tear it down now, rather than
      // allowing unauthenticated polling clients to consume the heartbeat.
      releaseTransport(socket.conn.request);
      next(new Error('REALTIME_AUTH_REQUIRED'));
      // Let Socket.IO flush its standard connect_error packet before the
      // Engine.IO close; the reservation was already released above.
      globalThis.setTimeout(() => socket.conn.close(), 0);
      return;
    }
    socket.data.principal = principal;
    next();
  });

  io.on('connection', (socket) => {
    const principal = principalFor(socket);
    if (principal.actor === 'student') socket.join(room(principal.classId, 'student'));
    else socket.join(TEACHER_GLOBAL_ROOM);
    // A reconnect is intentionally not a state replay. Every client starts by
    // reading its normal REST views, which preserves authorization and paging.
    emitRefetch(socket);
    let windowStartedAt = Date.now();
    let subscriptions = 0;
    const checkSession = globalThis.setInterval(() => {
      const current = authenticate(socket.handshake.headers.cookie, options);
      if (current === undefined || !sameSession(principal, current)) socket.disconnect(true);
    }, sessionCheckMs);

    socket.on(SUBSCRIBE_EVENT, (payload: unknown) => {
      const now = Date.now();
      if (now - windowStartedAt >= SUBSCRIBE_WINDOW_MS) { windowStartedAt = now; subscriptions = 0; }
      subscriptions += 1;
      if (subscriptions > MAX_SUBSCRIBES_PER_WINDOW) { socket.disconnect(true); return; }
      const classId = subscriptionClassId(payload);
      if (classId === undefined) { socket.emit('realtime:error', { code: 'INVALID_SUBSCRIPTION' }); return; }
      const current = authenticate(socket.handshake.headers.cookie, options);
      if (current === undefined || !sameSession(principal, current)) { socket.disconnect(true); return; }
      if (principal.actor === 'student') {
        // Student scope is fixed by the authenticated session and was joined at
        // connect time. Never let this event join a student to a teacher room.
        if (principal.classId !== classId) socket.emit('realtime:error', { code: 'CLASS_SCOPE_FORBIDDEN' });
        else emitRefetch(socket);
        return;
      }
      if (!options.canTeacherAccessClass(principal, classId)) { socket.emit('realtime:error', { code: 'CLASS_SCOPE_FORBIDDEN' }); return; }
      // Authorize before changing membership: a rejected switch retains the
      // previously selected class.  Teachers hold exactly one class room.
      for (const joined of socket.rooms) if (joined.startsWith(ROOM_PREFIX) && joined.endsWith(':teacher')) socket.leave(joined);
      socket.join(room(classId, 'teacher'));
      emitRefetch(socket);
    });
    socket.onAny((event) => {
      // Socket events are subscription-only. This makes it impossible for the
      // realtime transport to become a shadow mutation API by accident.
      if (event !== SUBSCRIBE_EVENT) socket.disconnect(true);
    });
    socket.once('disconnect', () => { globalThis.clearInterval(checkSession); });
  });

  return {
    publish: (change) => {
      if (!validChange(change)) return;
      version = version === Number.MAX_SAFE_INTEGER ? 1 : version + 1;
      const notification: RealtimeChange = { resourceType: change.resourceType, id: change.id, version, event: change.event };
      // volatile avoids buffering stale invalidation messages behind a slow
      // client. The next REST refetch is authoritative in all cases.
      if (change.audience !== 'teacher') io.to(room(change.classId, 'student')).volatile.emit(CHANGE_EVENT, notification);
      io.to(room(change.classId, 'teacher')).volatile.emit(CHANGE_EVENT, notification);
    },
    publishTeacher: (change) => {
      if (!validChange({ ...change, classId: 'teacher-global' as ClassId, audience: 'teacher' })) return;
      version = version === Number.MAX_SAFE_INTEGER ? 1 : version + 1;
      io.to(TEACHER_GLOBAL_ROOM).volatile.emit(CHANGE_EVENT, { resourceType: change.resourceType, id: change.id, version, event: change.event } satisfies RealtimeChange);
    },
    evictClass: (classId) => {
      const studentRoom = room(classId, 'student');
      const teacherRoom = room(classId, 'teacher');
      // Students can no longer have a valid class scope; teachers merely leave
      // the deleted room and stay connected for their remaining classes.
      for (const socket of io.sockets.adapter.rooms.get(studentRoom) ?? []) io.sockets.sockets.get(socket)?.disconnect(true);
      io.in(teacherRoom).socketsLeave(teacherRoom);
    },
    close: () => new Promise((resolve) => io.close(() => resolve()))
  };
}

function authenticate(cookieHeader: string | undefined, options: RealtimeGatewayOptions): RealtimePrincipal | undefined {
  const cookies = parseCookies(cookieHeader);
  const teacher = options.authenticateTeacher(cookies.teacher_session);
  if (teacher !== undefined) return { actor: 'teacher', teacherSessionId: teacher.teacherSessionId };
  const student = options.authenticateStudent(cookies.student_session);
  return student === undefined ? undefined : { actor: 'student', studentSessionId: student.studentSessionId, studentId: student.studentId, classId: student.classId };
}

function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try { cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim()); } catch { /* malformed cookies are unauthenticated */ }
  }
  return cookies;
}
function sameSession(left: RealtimePrincipal, right: RealtimePrincipal): boolean {
  return left.actor === right.actor && (left.actor === 'teacher'
    ? left.teacherSessionId === (right as RealtimeTeacher).teacherSessionId
    : left.studentSessionId === (right as RealtimeStudent).studentSessionId && left.classId === (right as RealtimeStudent).classId);
}
function principalFor(socket: Socket): RealtimePrincipal { return socket.data.principal as RealtimePrincipal; }
function room(classId: ClassId, audience: 'student' | 'teacher'): string { return `${ROOM_PREFIX}${classId}:${audience}`; }
function subscriptionClassId(payload: unknown): ClassId | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const classId = (payload as { classId?: unknown }).classId;
  return typeof classId === 'string' && classId.length > 0 && classId.length <= 200 ? classId as ClassId : undefined;
}
function validChange(change: RealtimeChangeInput): boolean {
  const events: Readonly<Record<RealtimeResourceType, readonly string[]>> = {
    question: ['question_opened', 'question_closed', 'answer_updated', 'draft_created', 'draft_updated', 'draft_deleted', 'template_created', 'template_updated', 'template_deleted'],
    'file-task': ['filetask_created', 'filetask_updated', 'filetask_opened', 'filetask_closed', 'filetask_deleted'],
    pending: ['pending_requested', 'pending_resolved'],
    roster: ['roster_imported', 'roster_changed', 'class_deleted'],
    submission: ['submission_committed', 'submission_deleted']
  };
  return typeof change.classId === 'string' && change.classId.length > 0 && change.classId.length <= 200
    && typeof change.resourceType === 'string' && Object.hasOwn(events, change.resourceType)
    && typeof change.id === 'string' && change.id.length > 0 && change.id.length <= 200
    && typeof change.event === 'string' && events[change.resourceType]?.includes(change.event) === true
    && (change.audience === undefined || change.audience === 'all' || change.audience === 'teacher');
}
function emitRefetch(socket: Socket): void { socket.emit(REFETCH_EVENT, { reason: 'connected' }); }
function assertAllowedOrigin(origin: string): void { if (new URL(origin).origin !== origin || !origin.startsWith('http://')) throw new Error('REALTIME_ALLOWED_ORIGIN_REQUIRED'); }
function hasExactPrivateLanOrigin(request: IncomingMessage, allowedOrigin: string): boolean { return request.headers.origin === allowedOrigin && isPrivateLanAddress(request.socket.remoteAddress); }
function isPrivateLanAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.replace(/^::ffff:/, '');
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  if (/^10\./.test(normalized) || /^192\.168\./.test(normalized) || /^(?:172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(normalized)) return true;
  return /^(?:fc|fd)[0-9a-f:]*$/i.test(normalized);
}
function isEngineTransport(value: string | null): value is 'polling' | 'websocket' { return value === 'polling' || value === 'websocket'; }
