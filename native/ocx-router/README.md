# ocx-router

Loopback request router for the OpenCode provider family. Standalone binary — it is not
part of the `codex-tls` napi addon build.

## What it does

Node decides which upstream, protocol, credential and model to use; Rust executes:
header injection, one bounded retry, error taxonomy, SSE relay.

| Endpoint | Purpose |
|---|---|
| `POST /v1/responses` | Responses protocol |
| `POST /v1/chat/completions` | Chat Completions protocol |
| `POST /v1/messages` | Anthropic Messages protocol |
| `POST /internal/catalog` | Node pushes the model catalogue (Rust keeps no copy of its own) |
| `GET /v1/models` | The pushed catalogue |
| `GET /health` | Readiness + catalogue version |

Control headers set by Node (never by clients): `x-ocx-upstream` (`go` / `zen` / `zen-free`),
`x-ocx-protocol`, `x-ocx-model`, `x-ocx-session`, plus the `authorization` bearer of the
credential Node selected.

Environment: `OCX_ROUTER_PORT`, `OCX_ROUTER_TIMEOUT_SECS`, `OCX_UPSTREAM_GO`,
`OCX_UPSTREAM_ZEN`. CLI: `--port <port>`. Binds `127.0.0.1` only.

## Build

```powershell
cd native/ocx-router
cargo build --release
# → target/release/ocx-router(.exe)
```

`server.rust_routing.binary_path` may point elsewhere; otherwise the app probes
`native/ocx-router/target/{release,debug}/` and the directory holding the Node executable.

### Known environment issue: crates mirror 404

Some mirrors (e.g. `mirrors.hust.edu.cn`) return 404 for individual crates, which fails
the build with `failed to download from .../url-2.5.8.crate`. Build against crates.io with
an isolated `CARGO_HOME` instead of editing the user-level cargo config:

```powershell
$env:CARGO_HOME = Join-Path $env:TEMP 'ocx-cargo-home'
New-Item -ItemType Directory -Force $env:CARGO_HOME | Out-Null
Set-Content (Join-Path $env:CARGO_HOME 'config.toml') '# isolated: no mirror replacement'
cargo build --release
```

## Behaviour notes

- `5xx` from the upstream is rewritten to `502` so clients retry instead of blaming the
  request; `4xx` passes through unchanged; `retry-after` is forwarded.
- Error envelope: `{ "type": "error", "error": { "type", "code": "opencode_<class>", "message" } }`,
  with classes matching `src/opencode/errors.ts` (`free_limit`, `invalid_key`, `rate_limited`,
  `upstream_unavailable`, `timeout`, …).
- Retries: at most 3 attempts, only for `429` / `5xx`, honouring `retry-after` up to 30s and a
  240s total budget.
- If the binary is missing or unhealthy the Node side falls back to the TypeScript adapter and
  reports `rust_routing.router.state = "degraded"` on `/admin/opencode/status` — it never
  pretends to be routing through Rust.

## Tests

`tests/integration/opencode-rust-router.test.ts` spawns the real binary against a local mock
upstream (health, catalogue push, Responses forwarding, chat/messages endpoints, free-limit
mapping). It is reported as **skipped**, not passed, when the binary has not been built.
