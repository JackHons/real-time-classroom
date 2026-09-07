import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env as processEnvironment } from 'node:process';

type Environment = Readonly<Record<string, string | undefined>>;

export type RuntimeConfig = Readonly<{
  databasePath: string;
  allowedOrigin: string;
  csrfSecret: string;
  host: string;
  port: number;
}>;

/** Reads only explicit deployment values; no production secret is generated or embedded. */
export function readRuntimeConfig(environment: Environment = processEnvironment): RuntimeConfig {
  const allowedOrigin = environment.LAN_CLASSROOM_ALLOWED_ORIGIN;
  const csrfSecret = environment.LAN_CLASSROOM_CSRF_SECRET;
  if (allowedOrigin === undefined || csrfSecret === undefined) throw new Error('RUNTIME_SECURITY_CONFIGURATION_REQUIRED');
  const databasePath = environment.LAN_CLASSROOM_DATABASE_PATH ?? defaultDatabasePath(environment);
  const port = environment.LAN_CLASSROOM_PORT === undefined ? 4173 : Number(environment.LAN_CLASSROOM_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_PORT_INVALID');
  return { databasePath, allowedOrigin, csrfSecret, host: environment.LAN_CLASSROOM_HOST ?? '0.0.0.0', port };
}

function defaultDatabasePath(environment: Environment): string {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) throw new Error('LOCALAPPDATA_REQUIRED_OR_SET_LAN_CLASSROOM_DATABASE_PATH');
  const directory = join(localAppData, 'LanClassroomPlatform');
  mkdirSync(directory, { recursive: true });
  return join(directory, 'classroom.sqlite');
}
