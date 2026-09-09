import { createApplication, FirstRunSetupRequiredError } from './application.js';
import { openSqlite } from './db/connection.js';
import { readRuntimeConfig } from './runtime-config.js';
import { startServer, type HttpRequestListener } from './server.js';
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
let health: Readonly<{ status: 200 | 503; state: 'ready' | 'not_ready'; reason?: string }> = { status: 200, state: 'ready' };
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
    // The first-run setup flow is intentionally not implemented in this task.
    // Do not serve UI or API routes until a loopback-only setup has stored a hash.
    health = { status: 503, state: 'not_ready', reason: 'FIRST_RUN_SETUP_REQUIRED' };
    console.error('FIRST_RUN_SETUP_REQUIRED: only GET /health is available until teacher setup completes.');
    database.close();
  } else if (isUploadStorageStartupError(error)) {
    // Storage reconciliation is a readiness prerequisite. Keep the process
    // observable but fail closed: no UI or API is attached while durable state
    // and private files disagree.
    health = { status: 503, state: 'not_ready', reason: 'UPLOAD_STORAGE_NOT_READY' };
    console.error('UPLOAD_STORAGE_NOT_READY: only GET /health is available until storage integrity is restored.');
    database.close();
  } else throw error;
}
const server = await startServer({
  host: config.host,
  port: config.port,
  health,
  ...(apiHandler === undefined
    ? {}
    : { apiHandler, webHandler: webModule.handler, ...(realtime === undefined ? {} : { realtime, onRealtimeGateway: (gateway) => { realtimeNotifications?.attach(gateway); flushTaskCloseNotifications?.(); } }) })
});
console.info(`LAN Classroom host listening at http://${server.host}:${server.port}`);

function isUploadStorageStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'UPLOAD_STORAGE_INTEGRITY_FAILED' || error.message.startsWith('UPLOAD_STORAGE_');
}
