import { createApplication, FirstRunSetupRequiredError } from './application.js';
import process, { exit } from 'node:process';
import { setTimeout } from 'node:timers';
import { openSqlite } from './db/connection.js';
import { SqliteAuthSessionRepository } from './db/auth-session-repository.js';
import { migrationReadiness } from './db/migrator.js';
import { createFirstRunSetupHandler } from './first-run-setup.js';
import { readRuntimeConfig } from './runtime-config.js';
import { startServer, type HttpRequestListener, type HttpRouteHandler } from './server.js';
import type { RealtimeGatewayOptions, RealtimeNotificationBus } from './realtime/gateway.js';

const webModule = (await import(
  new URL('../../web/build/handler.js', import.meta.url).href
)) as Readonly<{ handler: HttpRequestListener }>;

const config = readRuntimeConfig();
const database = openSqlite(config.databasePath);
let apiHandler;
let realtime: RealtimeGatewayOptions | undefined;
let realtimeNotifications: RealtimeNotificationBus | undefined;
let flushTaskCloseNotifications: (() => void) | undefined;
let bootstrapHandler: HttpRouteHandler | undefined;
let health: Readonly<{ status: 200 | 503; state: 'ready' | 'not_ready'; reason?: string; version?: string; schemaVersion?: string; upgradeReady?: boolean }> = { status: 200, state: 'ready' };
try {
  const application = createApplication({
    database,
    allowedOrigin: config.allowedOrigin,
    csrfSecret: config.csrfSecret,
    uploadStorageRoot: config.uploadStoragePath,
    uploadStorageOptions: { minimumFreeBytes: config.uploadStorageMinimumFreeBytes }
  });
  // Do not accept upload requests until durable intents and private storage
  // agree; startup is deliberately fail-closed when reconciliation fails.
  await application.reconcileUploads();
  apiHandler = application.apiHandler;
  realtime = application.realtime;
  realtimeNotifications = application.realtimeNotifications;
  flushTaskCloseNotifications = application.flushTaskCloseNotifications;
} catch (error) {
  if (error instanceof FirstRunSetupRequiredError) {
    // No application or LAN route is attached until the direct-loopback setup
    // handler wins the atomic password insert. This deliberately does not
    // trust a forwarded client address or a LAN Host header.
    health = { status: 503, state: 'not_ready', reason: 'FIRST_RUN_SETUP_REQUIRED' };
    bootstrapHandler = createFirstRunSetupHandler({
      repository: new SqliteAuthSessionRepository(database),
      onConfigured: () => {
        // Exit with a dedicated, non-error code after the HTTP response has
        // drained. LanClassroomSupervisor.ps1 alone recognizes this code and
        // relaunches into the fully configured normal application.
        setTimeout(() => exit(75), 25).unref();
      }
    });
    console.error('FIRST_RUN_SETUP_REQUIRED: only direct loopback /setup and GET /health are available until teacher setup completes.');
  } else if (isUploadStorageStartupError(error)) {
    // Storage reconciliation is a readiness prerequisite. Keep the process
    // observable but fail closed: no UI or API is attached while durable state
    // and private files disagree.
    health = { status: 503, state: 'not_ready', reason: 'UPLOAD_STORAGE_NOT_READY' };
    console.error('UPLOAD_STORAGE_NOT_READY: only GET /health is available until storage integrity is restored.');
  } else throw error;
}
const readiness = migrationReadiness(database);
health = { ...health, version: '0.1.0', schemaVersion: readiness.schemaVersion, upgradeReady: readiness.upgradeReady };
const server = await startServer({
  host: config.host,
  hosts: config.hosts,
  port: config.port,
  health,
  ...(bootstrapHandler === undefined ? {} : { bootstrapHandler }),
  ...(apiHandler === undefined
    ? {}
    : { apiHandler, webHandler: webModule.handler, ...(realtime === undefined ? {} : { realtime, onRealtimeGateway: (gateway) => { realtimeNotifications?.attach(gateway); flushTaskCloseNotifications?.(); } }) })
});
console.info(`LAN Classroom host listening at ${server.hosts.map((host) => `http://${host}:${server.port}`).join(', ')}`);

let stopping = false;
async function gracefulShutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // server.close stops accepts first and waits for active HTTP/Socket.IO work.
  const deadline = setTimeout(() => process.exit(1), 8_000); deadline.unref();
  try { await server.close(); database.close(); process.exit(0); }
  catch { process.exit(1); }
}
process.once('SIGTERM', () => { void gracefulShutdown(); });
process.once('SIGINT', () => { void gracefulShutdown(); });

function isUploadStorageStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'UPLOAD_STORAGE_INTEGRITY_FAILED' || error.message.startsWith('UPLOAD_STORAGE_');
}
