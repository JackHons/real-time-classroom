import { startServer, type HttpRequestListener } from './server.js';

const webModule = (await import(
  new URL('../../web/build/handler.js', import.meta.url).href
)) as Readonly<{ handler: HttpRequestListener }>;

const server = await startServer({ webHandler: webModule.handler });
console.info(`LAN Classroom bootstrap host listening at http://${server.host}:${server.port}`);
