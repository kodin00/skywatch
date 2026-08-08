# AGENTS.md

Guidance for AI coding agents (and new humans) working in the Skywatch repo. Read this before editing.
`README.md` explains what Skywatch *is* and how to deploy it; this file explains how to *change* it.

## What this repo is

Skywatch is a Cloudflare-native control plane. Three deliverables live here:

| Part | Path | Stack |
| --- | --- | --- |
| Dashboard (SPA) | `src/` | React 19 + Vite, one file: `src/App.tsx` |
| Control-plane API | `worker/index.ts` | Cloudflare Worker (TypeScript) + D1 |
| VPS agent | `agent/` | Rust (axum + bollard), installed on a Linux host via systemd |

The browser never talks to the agent. Browser → Worker (same-origin `/api/*`) → agent (HMAC-signed HTTP over a VPC Service, Tunnel, or plain HTTPS).

## Toolchain and commands

Toolchains are pinned in `mise.toml` (Node 24.18.1, Rust 1.97.1). Use `mise install && mise run setup` for a fresh clone.

```bash
npm run test        # vitest (worker + dashboard)
npm run check       # test + cf-typegen + build + wrangler deploy --dry-run   <- gate for web changes
mise run agent:check # bash -n, skywatch.test.sh, fmt --check, clippy -D warnings, cargo test, release build
mise run check      # both of the above
```

There is **no CI for pull requests** — `.github/workflows/agent-release.yml` only fires on `agent-v*` tags. Run the relevant check yourself; nothing else will.

Touching the Worker or `wrangler.jsonc` → run `npm run check`. Touching `agent/` → run `mise run agent:check`.

## Architecture facts that shape every change

- **`worker/index.ts` is a single 2900-line file** — types, routes, helpers, and crypto all in one module, no router library. `fetch()` (≈line 175) is an if-chain over `method + url.pathname`. Add routes there, next to their siblings.
- **`src/App.tsx` is a single 1465-line file** — ~20 components, no router, no state library. Section switching is a `useState<'workers'|'servers'|'projects'>` in `Dashboard` plus ternaries. There is no URL routing, so no deep links.
- **Only `/api/*` reaches the Worker.** `run_worker_first: ["/api/*"]` in `wrangler.jsonc` means everything else is served straight from the `ASSETS` binding — Worker-level logging never sees asset requests.
- **The schema lives in code, not in migrations.** `ensureSchema(db)` (worker/index.ts ≈294) runs idempotent `CREATE TABLE IF NOT EXISTS` on nearly every request. `wrangler.jsonc` declares no `migrations_dir` and no script runs `wrangler d1 migrations apply`, so `migrations/*.sql` are a historical record only. **Schema changes must go into `ensureSchema()`, and a new `migrations/000N_*.sql` should be added to keep the record in sync.**
- **One encryption key wraps everything.** A non-extractable Worker `secret_key` binding, `SKYWATCH_TOKEN_KEY`, created during `/api/setup` via the Cloudflare API. Every secret in D1 (Cloudflare token, agent HMAC keys, GitHub PAT, project `.env`) is AES-256-GCM ciphertext + IV, each with a **distinct AAD constant** so ciphertexts can't be swapped between purposes. New secret at rest → new AAD constant, `encryptSecret`/`decryptSecret` helpers.
- **The key is briefly absent after setup.** The binding only becomes visible after Cloudflare propagates the redeploy, hence the `finalizing` / `setup_finalizing` (503) states. New code that needs the key must tolerate its absence, not assume it.
- **Auth is Cloudflare Access, not app-level.** There are no users, passwords, or sessions in this codebase. After setup, Access fronts the Worker with an owner-only policy. The Worker's own defense is `assertSameOrigin(request)` on every non-GET (≈line 184) — so never give a GET route side effects.

## Worker conventions

- Throw `HttpError(status, message, code)`; the top-level `fetch` catch maps it. Unknown errors become a generic 500 and are `console.error({ event, ... })`'d. Error codes are short snake_case (`invalid_pairing_token`, `not_configured`) and tests assert on them, so treat them as API surface.
- Return via `json(body, status?)` (sets `Cache-Control: no-store`); `withHeaders()` wraps everything with the baseline security headers.
- Read bodies with `readJson<T>(request, maxBytes?)` — enforces content-type and a byte cap (16KB default, 2MB for projects).
- Validation is hand-rolled per field, no schema library. Copy the style in `validateProjectPayload` / `validateAgentEndpoint`: one specific `HttpError(400, …, specific_code)` per bad field.
- Resource IDs are canonical UUIDs (`isCanonicalUuid`); container IDs are exactly 64 hex chars. Path params are pulled by hand-written `matchXRoute` helpers.
- DB objects are `snake_case` and prefixed `skywatch_`; TS types are `PascalCase`, `StoredX` for row shapes, defined inline at the top of the file.

## Agent ↔ Worker protocol

Symmetric HMAC-SHA256 with a shared 32-byte key (`key_id` + `controller.key`). Both directions are signed:

```
request:  skywatch-agent-v1\nMETHOD\n/path?query\ntimestamp\nnonce\nbodySha256Hex
response: skywatch-agent-response-v1\nnonce\nstatus\ntimestamp\nbodySha256Hex
```

Headers: `X-Skywatch-{Key-Id,Timestamp,Nonce,Content-Sha256,Signature}`. 60s skew window, in-memory nonce replay cache, constant-time comparison, node-identity pinning against `/v1/health`'s `nodeId`. **Any change to the canonical strings, headers, or skew rules must land in `worker/index.ts` (`agentRequestCanonical`, `verifyAgentResponse`) and `agent/src/auth.rs` together, and is a wire-breaking change for already-installed agents.**

## Frontend conventions

- Fetch only through the `api<T>(path, init)` wrapper (`src/App.tsx` ≈144) — same-origin credentials, JSON headers, throws on non-2xx. Never call `fetch` directly.
- Loading pattern: local `useState` for data/loading/error + `useEffect` with a `cancelled` guard. There is no shared store, so duplicate fetches across sections are expected.
- Live data: copy `ServerWorkspace`'s poller (5s interval, exponential backoff to 60s, paused when `document.visibilityState !== 'visible'`, `pollInFlight` ref). Don't invent a second async primitive.
- Styling: one hand-written `src/styles.css`, flat kebab-case component classes with state modifier classes (`.active`, `.danger`), dark-only. Use the `:root` custom properties (`--sage`, `--surface`, `--line`, …) — never hardcode colors. Add a `/* Section */` block and extend the existing 1050/840/680px media queries.
- Icons: `lucide-react` only. Runtime deps are react, react-dom, lucide-react — keep it that way; formatting helpers are hand-rolled on purpose.

**Adding a dashboard section:** extend `Dashboard`'s `section` union, add a sidebar `nav-button`, add branches to the topbar and content ternaries, write a self-contained `XyzDashboard` component in the same file, reuse `ConfirmDialog` / `.dialog-backdrop` / the format helpers, then add CSS and tests.

## Testing conventions

- **Worker (`worker/index.test.ts`)**: no mocking framework and no Miniflare. Pure helpers are unit-tested through the whitelisted `export const __test = {...}` at the bottom of `worker/index.ts` — add new helpers there to test them. Request-level tests use a hand-written `fakeDb()` stubbing `prepare/bind/first/all/run/batch`; `env` is just `{ DB: fakeDb() }`, so `ASSETS` and `VPS_AGENT` paths need extra stubs.
- **Dashboard (`src/App.test.tsx`)**: `vitest.config.ts` defaults to `environment: 'node'` — every DOM test file needs `// @vitest-environment jsdom` as its first line or `render()` fails confusingly. `installApiMock()` is a hand-rolled stateful fetch router; unmatched routes throw on purpose, so new endpoints must be registered there. Query by role/label, not test-ids. Polling tests must stub `document.visibilityState = 'visible'`.
- **Agent**: inline `#[cfg(test)] mod tests` per module, `tokio::test` + `tempfile`. No live Docker daemon in tests — `docker.rs` tests use synthetic JSON. `packaging/skywatch.test.sh` tests the bash CLI wrapper separately.

## Gotchas

- **Only one agent can use `transport: "vpc"`** — `wrangler.jsonc` has a single fixed `VPS_AGENT` service. Enforced by a unique D1 index, a runtime check in the Worker, and `vpcInUse` in `AgentConfigPanel`. All three must stay in sync. Extra nodes use `direct` HTTPS, where `validateAgentEndpoint` blocks RFC1918/loopback/link-local.
- **`agent/install.sh`'s `RELEASE_TAG` is hardcoded** and currently lags `agent/Cargo.toml`'s version. Bumping the crate version means updating the tag, `Cargo.toml`, and pushing a matching `agent-v*` tag — the release job hard-fails if the tag and `Cargo.toml` disagree.
- **`Config` and the deploy-source structs use `serde(deny_unknown_fields)`** — adding a field to the Worker's request payload without updating `agent/src/models.rs` breaks deploys outright rather than being ignored.
- **The systemd unit deliberately omits `ProcSubset=pid`** (host metrics need `/proc/stat`). A test in `metrics.rs` greps the unit file to assert this; "hardening" it breaks metrics.
- **`AppState.mutations` is a 1-permit semaphore** serializing *all* container actions and deployments on an agent. Background deploy tasks are not independent of container mutations.
- **Agent relative paths** (`key_file`, `deployments_dir`) resolve against the config file's directory, not CWD.
- **GitHub tokens must never be logged** — route any new shell-out through `run_step`'s `secret` redaction (`credentialed_url` / `redact` in `deployments.rs`).
- **Response signing buffers the whole body** (~2 MiB cap) — a new large-payload endpoint needs the cap raised or a different design.
- `window.confirm` is still used for a couple of destructive actions; prefer the in-app `ConfirmDialog` for new ones.

## Conventions for the change itself

- Match the surrounding code: no new dependencies, no new abstraction layers, no file splitting unless asked. The single-file Worker and single-file App are deliberate.
- Never commit real credentials, account IDs, or service IDs beyond what is already in `wrangler.jsonc`.
- Don't run `npm run deploy` or `wrangler deploy` — deployment is the maintainer's call. `wrangler deploy --dry-run` (part of `npm run check`) is the safe verification.
