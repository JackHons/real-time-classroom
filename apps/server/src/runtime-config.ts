import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
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
  const host = environment.LAN_CLASSROOM_HOST ?? '127.0.0.1';
  const hosts = parseHosts(environment.LAN_CLASSROOM_HOSTS, host);
  const csrfSecret = environment.LAN_CLASSROOM_CSRF_SECRET ?? readOrCreateCsrfSecret(dirname(databasePath));
  if (csrfSecret.length < 32) throw new Error('RUNTIME_SECURITY_CONFIGURATION_REQUIRED');
  const port = environment.LAN_CLASSROOM_PORT === undefined ? 4173 : Number(environment.LAN_CLASSROOM_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RUNTIME_PORT_INVALID');
  const uploadStoragePath = environment.LAN_CLASSROOM_UPLOAD_STORAGE_PATH ?? join(dirname(databasePath), 'uploads');
  const uploadStorageMinimumFreeBytes = environment.LAN_CLASSROOM_UPLOAD_MINIMUM_FREE_BYTES === undefined
    ? DEFAULT_MINIMUM_FREE_BYTES
    : Number(environment.LAN_CLASSROOM_UPLOAD_MINIMUM_FREE_BYTES);
  if (!Number.isSafeInteger(uploadStorageMinimumFreeBytes) || uploadStorageMinimumFreeBytes < DEFAULT_MINIMUM_FREE_BYTES) throw new Error('RUNTIME_UPLOAD_STORAGE_RESERVE_INVALID');
  return { databasePath, uploadStoragePath, uploadStorageMinimumFreeBytes, allowedOrigin, csrfSecret, host, hosts, port };
}

function parseHosts(value: string | undefined, fallback: string): readonly string[] {
  const hosts = (value ?? fallback).split(',').map((host) => host.trim()).filter((host) => host.length > 0);
  if (hosts.length === 0 || hosts.some((host) => !isPermittedHost(host))) throw new Error('RUNTIME_HOST_INVALID');
  return [...new Set(hosts)];
}

/** The listener is deliberately limited to a literal loopback or private LAN address. */
function isPermittedHost(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && (octets[1] ?? -1) >= 16 && (octets[1] ?? -1) <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  if (family !== 6) return false;
  const normalized = host.toLowerCase();
  // Reject unspecified forms, including IPv4-mapped 0.0.0.0 (::ffff:0:0).
  if (normalized === '::' || normalized === '::0' || normalized === '::ffff:0:0') return false;
  return normalized === '::1' || /^f[cd][0-9a-f:]*$/i.test(normalized);
}

function readOrCreateCsrfSecret(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensurePrivateDirectory(directory);
  const filename = join(directory, 'runtime-secrets.json');
  const existing = readSecret(filename);
  if (existing !== undefined) return existing;

  // A lock protects the absent-file transition. Readers only ever open the
  // final name, which is published with an in-directory atomic rename.
  const lock = join(directory, 'runtime-secrets.lock');
  for (let retry = 0; retry < 100; retry += 1) {
    let lockDescriptor: number | undefined;
    try { lockDescriptor = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      const afterOtherWriter = readSecret(filename);
      if (afterOtherWriter !== undefined) return afterOtherWriter;
      clearStaleLock(lock);
      sleep(10);
      continue;
    }
    try {
      ensurePrivateFile(lock);
      cleanupStaleTemporarySecrets(directory);
      const afterLock = readSecret(filename);
      if (afterLock !== undefined) return afterLock;
      const secret = randomBytes(32).toString('base64url');
      const temporary = join(directory, `runtime-secrets.${randomBytes(12).toString('hex')}.tmp`);
      let temporaryDescriptor: number | undefined;
      try {
        temporaryDescriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(temporaryDescriptor, JSON.stringify({ csrfSecret: secret }) + '\n', { encoding: 'utf8' });
        fsyncSync(temporaryDescriptor);
      } finally { if (temporaryDescriptor !== undefined) closeSync(temporaryDescriptor); }
      ensurePrivateFile(temporary);
      // Same-directory rename is atomic: no reader can observe a partial JSON file.
      renameSync(temporary, filename);
      ensurePrivateFile(filename);
      return secret;
    } finally {
      if (lockDescriptor !== undefined) closeSync(lockDescriptor);
      // If a process dies or an antivirus holds this tiny lock briefly, the
      // next caller's stale-lock recovery handles it; do not mask a durable
      // successful secret write from a finally block.
      try { unlinkSync(lock); } catch { /* stale-lock recovery retries safely */ }
    }
  }
  throw new Error('RUNTIME_SECRET_LOCK_TIMEOUT');
}

function parseSecret(raw: string): string {
  try {
    const secret = (JSON.parse(raw) as { csrfSecret?: unknown }).csrfSecret;
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, 'base64url').length !== 32 || Buffer.from(secret, 'base64url').toString('base64url') !== secret) throw new Error('invalid');
    return secret;
  } catch { throw new Error('RUNTIME_SECRET_INVALID'); }
}
function readSecret(filename: string): string | undefined {
  try {
    const secret = parseSecret(readFileSync(filename, 'utf8'));
    ensurePrivateFile(filename);
    return secret;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}
function ensurePrivateDirectory(directory: string): void {
  try { chmodSync(directory, 0o700); } catch (error) { throw new Error('RUNTIME_DIRECTORY_PERMISSION_INVALID', { cause: error }); }
  if (isWindows()) { applyWindowsOwnerOnlyAcl(directory, '(OI)(CI)F', 'RUNTIME_DIRECTORY_PERMISSION_INVALID'); return; }
  if ((statSync(directory).mode & 0o077) !== 0) throw new Error('RUNTIME_DIRECTORY_PERMISSION_INVALID');
}
function ensurePrivateFile(filename: string): void {
  try { chmodSync(filename, 0o600); } catch (error) { throw new Error('RUNTIME_SECRET_PERMISSION_INVALID', { cause: error }); }
  if (isWindows()) { applyWindowsOwnerOnlyAcl(filename, 'F', 'RUNTIME_SECRET_PERMISSION_INVALID'); return; }
  if ((statSync(filename).mode & 0o077) !== 0) throw new Error('RUNTIME_SECRET_PERMISSION_INVALID');
}
function isWindows(): boolean { return processEnvironment.OS === 'Windows_NT'; }
function applyWindowsOwnerOnlyAcl(path: string, permission: string, code: string): void {
  try {
    const username = processEnvironment.USERNAME;
    if (username === undefined || username.length === 0) throw new Error('USERNAME_REQUIRED');
    // Reset inherited permissions, then retain only the owner and Windows
    // recovery principals.  Explicit broad principals are removed every run.
    execFileSync('icacls.exe', [path, '/inheritance:r', '/remove:g', '*S-1-1-0', '*S-1-5-11', '*S-1-5-32-545', '/grant:r', `${username}:${permission}`, `*S-1-5-18:${permission}`, `*S-1-5-32-544:${permission}`], { windowsHide: true, stdio: 'ignore' });
    execFileSync('icacls.exe', [path, '/verify'], { windowsHide: true, stdio: 'ignore' });
  } catch (error) { throw new Error(code, { cause: error }); }
}
function cleanupStaleTemporarySecrets(directory: string): void {
  for (const entry of readdirSync(directory)) {
    if (!/^runtime-secrets\.[a-f0-9]{24}\.tmp$/.test(entry)) continue;
    try { unlinkSync(join(directory, entry)); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
}
function clearStaleLock(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs < 30_000) return;
    unlinkSync(lock);
  } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
}
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined; }

function defaultDatabasePath(environment: Environment): string {
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) throw new Error('LOCALAPPDATA_REQUIRED_OR_SET_LAN_CLASSROOM_DATABASE_PATH');
  const directory = join(localAppData, 'LanClassroomPlatform');
  mkdirSync(directory, { recursive: true });
  return join(directory, 'classroom.sqlite');
}
