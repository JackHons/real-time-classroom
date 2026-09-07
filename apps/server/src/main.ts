import { createApplication, FirstRunSetupRequiredError } from './application.js';
import { openSqlite } from './db/connection.js';
import { readRuntimeConfig } from './runtime-config.js';
import { startServer, type HttpRequestListener } from './server.js';

const webModule = (await import(
  new URL('../../web/build/handler.js', import.meta.url).href
)) as Readonly<{ handler: HttpRequestListener }>;

const config = readRuntimeConfig();
const database = openSqlite(config.databasePath);
let apiHandler;
try {
  apiHandler = createApplication({
    database,
    allowedOrigin: config.allowedOrigin,
    csrfSecret: config.csrfSecret
  }).apiHandler;
} catch (error) {
  if (!(error instanceof FirstRunSetupRequiredError)) throw error;
  // The first-run setup flow is intentionally not implemented in this task.
  // Do not serve UI or API routes until a loopback-only setup has stored a hash.
  console.error('FIRST_RUN_SETUP_REQUIRED: only GET /health is available until teacher setup completes.');
  database.close();
}
const server = await startServer({
  host: config.host,
  port: config.port,
  ...(apiHandler === undefined ? {} : { apiHandler, webHandler: webModule.handler })
});
console.info(`LAN Classroom host listening at http://${server.host}:${server.port}`);
