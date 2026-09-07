# Runtime data and operational boundary

## Data directory

The production default is `%LOCALAPPDATA%\LanClassroomPlatform`, outside the web root and outside this repository. Planned child directories are:

- `database/` for SQLite database files and journals;
- `uploads/staging/` for incomplete uploads; and
- `uploads/files/` for committed opaque storage keys.

Do not place student uploads, SQLite files, session secrets, or production logs under the source checkout. The application must verify that this directory is writable and has sufficient free disk before declaring readiness.

## Network boundary

The MVP is a single Windows service for a teacher-confirmed, trusted **Private** LAN only. It uses HTTP and does not claim confidentiality, protection from same-network interception or modification, or session-token theft resistance. It must never open a Windows Public firewall profile and must not be exposed to the Internet, a reverse proxy, or another network segment without a separately approved deployment design.

## Retention

Data is retained until a teacher explicitly deletes it. CSV and ZIP downloads are exports only; they are not backup or restoration mechanisms. Incomplete staging data may be reconciled or removed according to its persisted state, but valid submissions must not be silently removed.
