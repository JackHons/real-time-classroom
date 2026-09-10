# 50-student load acceptance

`pnpm test:load` starts the actual server against a fresh OS-temporary SQLite
database and private upload directory. It creates a class of 50 rostered
students, concurrently creates sessions and Socket.IO connections, reconnects a
client, opens/answers/revises/closes a question, and streams one upload per
student with a global limit of 10 transfers. It then restarts the server and
reconciles the same SQLite/upload state before checking health.

The default CI fixture is 64 KiB per student. It proves the upload streaming,
concurrency, cleanup, latency/error, RSS, event-loop-delay, and SQLite-busy
observability paths without committing test data or writing to runtime data.
It emits an ignored JSON artifact under `test-results/load/` (or the path in
`LOAD_ARTIFACT`).

For the Windows 5 GB acceptance run, use a disposable machine with at least
5,512 MB free in its temporary-volume filesystem:

```powershell
$env:LOAD_FULL_5GB = '1'
pnpm test:load
```

The runner verifies disk capacity before beginning. Each 100,000,000-byte body
is generated as a 64 KiB stream, so the 5 GB case does not allocate 5 GB of
memory. Delete `LOAD_FULL_5GB` afterwards. The generated database and uploads
are removed in a `finally` block, whether the suite passes or fails.

`tests/load/classroom-50.js` remains the k6 scenario for an operator-provisioned
LAN deployment. It is deliberately opt-in: set its documented `K6_*` session
fixtures and run `k6 run tests/load/classroom-50.js`. The Node suite is used in
CI because it provisions only ephemeral local data and needs no k6 binary.

The CI workflow uses Node 24 on Ubuntu and Windows. It runs only the small
fixture; the full 5 GB check is an explicitly authorized operational acceptance
run.
