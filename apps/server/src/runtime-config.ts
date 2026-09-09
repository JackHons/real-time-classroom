import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { env as processEnvironment } from 'node:process';
import { DEFAULT_MINIMUM_FREE_BYTES } from './uploads/storage.js';

type Environment = Readonly<Record<string, string | undefined>>;

export type RuntimeConfig = Readonly<{
  databasePath: string;
  uploadStoragePath: string;
  uploadStorageMinimumFreeBytes: number;
  allowedOrigin: string;
  csrfSecret: string;
  host: string;
  /** A launcher may expose the selected private NIC and loopback, never a wildcard. */
  hosts: readonly string[];
  port: number;
}>;

/**
 * Reads explicit deployment values and creates the CSRF secret once in the
 * private runtime directory when it has not been provisioned externally.
 * The secret is never placed under the checkout or regenerated on restart.
 */
export function readRuntimeConfig(environment: Environment = processEnvironment): RuntimeConfig {
  const allowedOrigin = environment.LAN_CLASSROOM_ALLOWED_ORIGIN;
  const databasePath = environment.LAN_CLASSROOM_DATABASE_PATH ?? defaultDatabasePath(environment);
  if (allowedOrigin === undefined) throw new Error('RUNTIME_SECURITY_CONFIGURATION_REQUIRED');
  const csrfSecret = environment.LAN_CLASSROOM_CSRF_SECRET ?? readOrCreateCsrfSecret(dirname(databasePath));
  if (csrfSecret.length < 32) throw new Error('RUNTIME_SECURITY_CONFIGURATION_REQUIRED');
  const port = environment.LAN_CLASSROOM_PORT === undefined ? 4173 : Number(environment.LAN_CLASSROOM_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_PORT_INVALID');
  const uploadStoragePath = environment.LAN_CLASSROOM_UPLOAD_STORAGE_PATH ?? join(dirname(databasePath), 'uploads');
  const uploadStorageMinimumFreeBytes = environment.LAN_CLASSROOM_UPLOAD_MINIMUM_FREE_BYTES === undefined
    ? DEFAULT_MINIMUM_FREE_BYTES
    : Number(environment.LAN_CLASSROOM_UPLOAD_MINIMUM_FREE_BYTES);
  if (!Number.isSafeInteger(uploadStorageMinimumFreeBytes) || uploadStorageMinimumFreeBytes < DEFAULT_MINIMUM_FREE_BYTES) throw new Error('RUNTIME_UPLOAD_STORAGE_RESERVE_INVALID');
  const host = environment.LAN_CLASSROOM_HOST ?? '127.0.0.1';
  const hosts = parseHosts(environment.LAN_CLASSROOM_HOSTS, host);
  return { databasePath, uploadStoragePath, uploadStorageMinimumFreeBytes, allowedOrigin, csrfSecret, host, hosts, port };
}

function parseHosts(value: string | undefined, fallback: string): readonly string[] {
  const hosts = (value ?? fallback).split(',').map((host) => host.trim()).filter((host) => host.length > 0);
  if (hosts.length === 0 || hosts.some((host) => host === '0.0.0.0' || host === '::')) throw new Error('RUNTIME_HOST_INVALID');
  return [...new Set(hosts)];
}

function readOrCreateCsrfSecret(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are installation-owned. */ }
  const filename = join(directory, 'runtime-secrets.json');
  try { return parseSecret(readFileSync(filename, 'utf8')); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new Error('RUNTIME_SECRET_INVALID', { cause: error });
  }
  const secret = randomBytes(32).toString('base64url');
  let descriptor: number | undefined;
  try {
    // Exclusive creation ensures two starting processes never overwrite a
    // usable secret. fsync makes the generated value durable before use.
    descriptor = openSync(filename, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ csrfSecret: secret }) + '\n', { encoding: 'utf8' });
    fsyncSync(descriptor);
    try { chmodSync(filename, 0o600); } catch { /* Windows ACLs are installation-owned. */ }
    return secret;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return parseSecret(readFileSync(filename, 'utf8'));
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function parseSecret(raw: string): string {
  try {
    const secret = (JSON.parse(raw) as { csrfSecret?: unknown }).csrfSecret;
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('invalid');
    return secret;
  } catch { throw new Error('RUNTIME_SECRET_INVALID'); }
}
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined; }

function defaultDatabasePath(environment: Environment): string {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) throw new Error('LOCALAPPDATA_REQUIRED_OR_SET_LAN_CLASSROOM_DATABASE_PATH');
  const directory = join(localAppData, 'LanClassroomPlatform');
  mkdirSync(directory, { recursive: true });
  return join(directory, 'classroom.sqlite');
}
