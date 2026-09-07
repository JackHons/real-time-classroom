# Bootstrap entry-point and quality-gate contract

## Single service contract

`apps/server/src/main.ts` is the only executable entry point. After `pnpm build`, it dynamically loads the SvelteKit Node adapter handler from `apps/web/build/handler.js` and passes that handler to `startServer()` in `apps/server/src/server.ts`.

`startServer(options): Promise<RunningServer>` is a reusable module contract, not a second executable service. Its result contains the resolved host and port plus `close(): Promise<void>` for controlled shutdown. The host answers `GET /health` itself and delegates all other requests to the supplied SvelteKit handler. Future REST and Socket.IO work attaches to this same host.

Distribution must contain both `apps/server/dist/` and `apps/web/build/`; omitting either is a packaging failure. `node apps/server/dist/main.js` is the only supported process command. The adapter output must not be launched as a separate server.

## Honest quality gates

| Command | Task 1 status | Meaning |
|---|---|---|
| `pnpm lint` | verified | TypeScript ESLint plus executable `svelte-check` template/type gate |
| `pnpm check` | verified | strict server TypeScript and Svelte diagnostics |
| `pnpm test:unit` | verified | bootstrap host export and local health response |
| `pnpm test:integration` | unverified | exits non-zero until an integration test exists |
| `pnpm test:e2e` | unverified | exits non-zero until a Playwright test exists |
| `pnpm test:a11y` | unverified | exits non-zero until an `@a11y` Playwright test exists |
| `pnpm test:load` | unverified | exits non-zero until Task 10 adds a k6 suite |

The declared browser matrix is Chrome, Microsoft Edge, and Firefox. It is a required future execution matrix, not a claim that Task 1 has already exercised those browsers.
