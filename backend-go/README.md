# Vireo backend (Go)

Go service behind the Vireo studio dashboard — an autonomous pipeline that turns
viral reference videos into AI-rendered shorts for several personas. The Next.js
dashboard proxies part of its API here; Node scripts keep doing the renders, and
both sides share one SQLite database.

This is the first slice of a gradual migration from Node to Go.

## What it serves

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/personas` | All personas with per-stage video counts |
| GET | `/api/personas/{id}/videos?stage=&order=` | A persona's videos, fastest-growing first |
| GET | `/api/settings/keys?check=1` | The two Higgsfield API keys, masked, optionally verified live |
| POST | `/api/settings/keys` | Replace a key: format check → live check → atomic write with backup |
| GET | `/healthz` | Liveness |

## The `vireo` worker CLI

Every Node worker script now has a Go subcommand with the same arguments,
stdout JSON and exit codes (Cobra, one binary):

| Command | Replaces | Paid |
| --- | --- | --- |
| `ingest <persona> [limit] [offset] [cluster] [order]` | `ingest_viral.mjs` | |
| `refresh-inbox [ttl_hours]` | `refresh_inbox.mjs` | |
| `mcp list` / `mcp call <tool> [json]` | `mcp_client.mjs` | |
| `screen-ref <persona> <video>` | `screen_ref.mjs` | |
| `build-prompt <persona> <video> [--story] [instruction]` | `build_prompt.mjs` | |
| `idea <persona>` | `generate_idea.mjs` | |
| `drive-archive [--dry-run] <persona> <video>` | `drive_archive.mjs` | |
| `generate <persona> <video> <engine> [res] [dur]` | `generate.mjs` | yes |
| `generate-i2v <persona> <video> [res] [dur]` | `generate_i2v.mjs` | yes |
| `recover <persona> <video>` | `recover_render.mjs` | no new charge |
| `auto <persona> [count] [--res] [--order] [--fresh] [--max-dur]` | `auto_generate.mjs` | yes |
| `daily-auto [--dry-run]` | `daily_auto.mjs` | yes |

Each `.mjs` calls `scripts/_go.mjs` first and hands its argv to `vireo`; the
Node code stays as a fallback. Free steps run on Go by default; paid steps
stay on Node until `VIREO_GO_RENDER=on` (after a hand-run test render).
`VIREO_GO=off` puts everything back on Node.

Render rules carried over from production incidents: one idempotency key per
submit (retries never double-charge), the request id is stored before polling
(a timeout stays recoverable), Seedance durations stay strictly below the
reference length, references are normalized to a 720px short edge and ≤29s,
and prompts are sanitized for the content filter.

## Architecture

Clean architecture with manual constructor injection; dependencies point inward.

```
cmd/server/                   HTTP API wiring: adapters → use cases → handlers
cmd/vireo/                    worker CLI (Cobra), one file per command group + wire.go
internal/
  entity/                     domain types and rules (no imports from this module)
  persona/                    read use cases + the Repository port they need
  apikey/                     settings use cases + Store / Checker ports
  archive/                    Drive archive use case + Repository / Uploader / Files ports
  ingest/ screen/ prompt/     ref ingest, vision screening, prompt writing (prompts embedded)
  idea/                       idea generation with embedding de-duplication
  render/                     paid renders: motion transfer, image-only, recover
  autopilot/                  auto pipeline + daily 11:00 run
  adapter/
    repository/               SQLite implementation of persona.Repository
    keystore/                 key files in $HOME (atomic rename, 0600, .bak)
    gateway/                  Higgsfield key check (free 404/401 probe)
    uploader/                 rclone copyto (Drive)
    osfs/                     local file checks
    llm/ viralengine/         local vision LLM, ViralEngine MCP client
    embedding/ higgsfield/    embedding daemon, Higgsfield submit/poll/download
    media/ transit/           ffmpeg/ffprobe/yt-dlp, R2 transit uploads
    steps/                    runs autopilot steps as child vireo processes
    handler/                  HTTP ↔ use case translation, error → status mapping
  infrastructure/             env config, read-only SQLite pool, router, request log
```

Design notes:

- **Shared database, read-only side.** The Node app owns the schema and writes
  the WAL-mode file; Go opens it with `mode=ro`, `query_only` and a busy timeout,
  so it can never block or corrupt a render.
- **Safe fallback.** `dashboard/lib/goBackend.ts` proxies to this service and
  falls back to the original Node handler if Go is unreachable.
- **Secrets stay secret.** `entity.APIKey` implements `String()` as a masked
  value, so a key cannot leak through logs or `fmt`; a test enforces it.
- **No cgo.** `modernc.org/sqlite` keeps the build a single static binary.
- **Standard library first.** Go 1.22+ `ServeMux` patterns, `log/slog`, `sync.WaitGroup.Go`.

## Run

```sh
make test     # race detector on
make lint     # golangci-lint
make run      # 127.0.0.1:4320, reads ../db/studio.db
```

Config (environment): `VIREO_GO_ADDR` (default `127.0.0.1:4320`), `VIREO_DB`
(default `../db/studio.db`), `VIREO_KEY_DIR` (default `$HOME`).
The service binds to loopback only; authentication happens in the Next.js layer.

In production it runs under launchd as `ai.vireo.backend-go`.

## Tests

Table-driven, parallel, no network: fakes for ports, `httptest` for the
Higgsfield probe and the router, a temporary SQLite file for the repository,
and `t.TempDir` for the key store.

## Migration status

- [x] Read API + key settings (`server`)
- [x] Drive archive (`drive-archive`)
- [x] Worker CLI: ingest, screening, prompt, ideas (live on Go)
- [x] Renders + autopilot ported and unit-tested against a fake Higgsfield (gated off)
- [ ] Turn on `VIREO_GO_RENDER` after a hand-run test render
- [ ] Remaining dashboard write routes and Motion Control
