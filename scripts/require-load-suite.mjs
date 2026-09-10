import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the k6 scenario in the repository for production/LAN runs, while the
// Node harness is the portable CI acceptance test. The latter starts the real
// application with ephemeral data and therefore does not need k6 installed.
const tsxCli = fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/cli.mjs', import.meta.url));
const harness = fileURLToPath(new URL('../tests/load/classroom-50.node.ts', import.meta.url));
const result = spawnSync(process.execPath, [tsxCli, harness], {
  stdio: 'inherit',
  env: process.env
});

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
