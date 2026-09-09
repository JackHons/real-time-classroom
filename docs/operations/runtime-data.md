# Runtime data and operational boundary

## Data directory

The production default is `%LOCALAPPDATA%\LanClassroomPlatform`, outside the web root and outside this repository. Planned child directories are:

- `database/` for SQLite database files and journals;
- `uploads/staging/` for incomplete uploads; and
- `uploads/files/` for committed opaque storage keys.

Do not place student uploads, SQLite files, session secrets, or production logs under the source checkout. The application must verify that this directory is writable and has sufficient free disk before declaring readiness.

On its first start the service creates `runtime-secrets.json` next to the SQLite database only if `LAN_CLASSROOM_CSRF_SECRET` was not supplied. It publishes a synced temporary file by atomic rename under an exclusive startup lock, so readers never observe partial JSON. Every later startup validates the exact 32-byte base64url value and reapplies owner-only permissions (a Windows owner-only ACL, or POSIX mode `0600`). Keep this directory private and do not copy that secret into the repository.

## First-run and upgrade

Until a teacher password hash exists, the only setup page is `http://127.0.0.1:<port>/setup`. The service rejects named hosts, LAN requests, forwarded/proxy headers, and any Origin other than that literal local origin. The page asks for the password twice and is permanently gone after the first successful atomic write. Restart the service after setup to attach the normal application routes.

SQLite migrations run one at a time in transactions and record their completion in `schema_migrations`; retrying after an interrupted migration is safe. Existing SQLite data, teacher password hashes, and private upload objects are never replaced by an upgrade. `/health` includes the application version, latest applied schema version, and `upgradeReady` after the runtime initializes. This product deliberately provides **no backup or restore feature**; exports are not backups.

## Network boundary

The MVP is a single Windows service for a teacher-confirmed, trusted **Private** LAN only. It uses HTTP and does not claim confidentiality, protection from same-network interception or modification, or session-token theft resistance. It must never open a Windows Public firewall profile and must not be exposed to the Internet, a reverse proxy, or another network segment without a separately approved deployment design.

## Retention

Data is retained until a teacher explicitly deletes it. CSV and ZIP downloads are exports only; they are not backup or restoration mechanisms. Incomplete staging data may be reconciled or removed according to its persisted state, but valid submissions must not be silently removed.
