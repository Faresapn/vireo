# 🎬 Vireo — Autonomous Viral Video Studio

> **AI-driven pipeline that clones the motion of a viral reference video onto a locked brand character — fully automated, from trend discovery to publish-ready render.**

Vireo turns a single viral reference clip into an on-brand short-form video (9:16, Reels/TikTok/Shorts) featuring a **consistent recurring character**, with zero manual editing. It discovers trending content per niche, intelligently screens references for suitability, auto-writes the generation prompt by *watching* the reference with a vision model, renders through a motion-transfer engine, and learns your taste over time.

Built as a per-persona **content factory**: one character identity, one niche, one viral feed — scalable to hundreds of automated accounts.

---

## ✨ Highlights

- **🤖 One-button full automation** — `⚡ Generate Auto Video`: ingest → screen → prompt → render → QC → archive, no human in the loop.
- **👁️ Vision-driven reference screening** — a multimodal model scores every candidate for *motion-transfer fitness* (clear human subject, consistent scene) and rejects meme/compilation/POV junk **before** spending a render credit.
- **✍️ Auto prompt authoring** — the model extracts 3 frames from the reference, *watches* them, and fills a master-prompt template (actions, location, lighting, secondary subject) while keeping the brand character locked.
- **🔁 Dual engine with smart routing** — routes between two motion-transfer engines automatically (e.g. predator content → the more permissive engine), with per-video manual override.
- **🧠 Taste-learning RAG** — every QC verdict is logged per-niche; the system learns which references, prompts, and engines win, then recommends when it's safe to skip the draft stage and go straight to final quality.
- **🛡️ Resilient orchestration** — auto-retries alternate references on content/copyright blocks, stops cleanly (spending nothing) when no suitable reference exists.
- **📊 Live dashboard** — a 5-stage Kanban pipeline with inline video preview, per-stage controls, a RAG insights tab, and an API-spend monitor.

---

## 🏗️ Architecture

```
                        ┌─────────────────────────────────────────┐
                        │              DASHBOARD (Next.js)          │
                        │   Setup · Pipeline · Insights · Credits   │
                        └───────────────────┬─────────────────────┘
                                            │ REST
                        ┌───────────────────▼─────────────────────┐
                        │            ORCHESTRATOR (Node)            │
                        └───────────────────┬─────────────────────┘
          ┌──────────────┬──────────────────┼──────────────┬───────────────┐
          ▼              ▼                   ▼              ▼               ▼
   ┌────────────┐ ┌────────────┐     ┌────────────┐ ┌────────────┐ ┌────────────┐
   │ 1. INGEST  │ │ 2. SCREEN  │     │ 3. PROMPT  │ │ 4. RENDER  │ │ 5. ARCHIVE │
   │ trend feed │ │ vision     │     │ vision     │ │ motion-    │ │ cloud      │
   │ + download │ │ fitness    │     │ template   │ │ transfer   │ │ backup     │
   │ + transcode│ │ score 0-100│     │ fill       │ │ engine     │ │ + cleanup  │
   └────────────┘ └────────────┘     └────────────┘ └────────────┘ └────────────┘
                                            │
                        ┌───────────────────▼─────────────────────┐
                        │   RAG decision-memory (per-niche SQLite)  │
                        │   learns taste → ranks refs, picks engine │
                        └───────────────────────────────────────────┘
```

### The pipeline, stage by stage

| # | Stage | What happens |
|---|-------|--------------|
| 0 | **Prep** (once/persona) | Upload master-prompt template + 1–8 character photos; set the niche's trend source. |
| 1 | **Ingest** | Pull trending videos for the niche, download, normalize to a safe codec. |
| 2 | **Screen** | Vision model scores each reference 0–100 for transfer-fitness; rejects compilations, POV, overlays, crowd shots. |
| 3 | **Prompt** | Vision model watches 3 frames and fills the master-prompt `[SLOTS]`; character stays locked. Optional per-video instruction (e.g. *"swap the animal for a white tiger"*). |
| 4 | **Render** | Upload reference + character photos to a transit host → submit to the motion-transfer engine → poll → download. |
| 5 | **QC** | Draft reviewed (human, or auto once the niche's track record is proven). |
| 6 | **Finalize** | Approved → final-resolution render → permanent cloud archive → transit cleanup → RAG logs the verdict. |

Two human gates only — *pick the reference* and *judge the result* — and both fade to fully automatic once the RAG has enough winning history for a niche.

---

## 🧠 How the "learning" actually works

> The third-party generation engines are **frozen** — they never learn. What learns is the **RAG decision-memory**: a local SQLite log of every QC verdict, grouped by niche.

- Each `OK / Revise / Redo` verdict records the reference's features, the prompt used, the engine, and the outcome.
- An insights layer computes per-niche **OK-rate**, **first-try success rate**, **best engine**, and the **average winning reference duration**.
- Ingestion re-ranks incoming references toward the shape that historically wins.
- When a niche hits a high, well-sampled first-try success rate, the system recommends skipping the cheap draft and going straight to final quality — a **data-gated** decision, never a guess.

Each niche builds its own "recipe book" because taste differs (warm & affectionate vs. dark & tense vs. calm & outdoor). Niches are never mixed.

---

## 🖥️ Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Dashboard | **Next.js 15** (App Router) + **Tailwind** | Fast, modern, hand-rolled dark UI |
| Database | **`node:sqlite`** (built-in) | Zero native deps, no build step |
| Vision / prompt brain | Local multimodal LLM (OpenAI-compatible endpoint) | Script-callable, runs headless in automation |
| Media | **ffmpeg / ffprobe**, **yt-dlp** | Frame extraction, transcode, download |
| Transit host | **S3-compatible object storage** (via rclone) | Public URLs for the generation APIs |
| Archive | **Google Drive** (via rclone) | Permanent per-niche backup |

---

## 📂 Project structure

```
vireo/
├── dashboard/            # Next.js app (UI + API routes)
│   ├── app/
│   │   ├── page.tsx      # Sidebar, pipeline board, insights, credits widget
│   │   └── api/          # personas, videos, ingest, generate, auto, insights, credits
│   └── lib/db.ts         # node:sqlite schema + migrations
├── scripts/              # Headless pipeline (CLI + cron callable)
│   ├── mcp_client.mjs    # Trend-feed client (JSON-RPC over HTTP)
│   ├── ingest_viral.mjs  # Feed → download → transcode → INBOX
│   ├── screen_ref.mjs    # Vision pre-screen (transfer-fitness score)
│   ├── build_prompt.mjs  # Vision → fill master-prompt template
│   ├── generate.mjs      # Upload → engine submit → poll → download
│   ├── auto_generate.mjs # One-button orchestrator
│   ├── drive_archive.mjs # Cloud backup on completion
│   └── drive_init_niche.sh
├── shared/               # Master-prompt templates (per niche)
└── .gitignore            # Excludes data, secrets, media, node_modules
```

> **Note:** `personas/` (downloaded reference videos, character photos, rendered outputs) and `db/` (operational data) are intentionally **git-ignored** — this repo ships the *system*, not the content or credentials.

---

## 🚀 Getting started

### Prerequisites
- Node.js 22+ (for built-in `node:sqlite`)
- `ffmpeg`, `yt-dlp`, `rclone`
- A motion-transfer video API account
- A vision-capable LLM endpoint (OpenAI-compatible)
- S3-compatible storage + Google Drive (both via rclone remotes)

### Setup

```bash
# 1. Install dashboard deps
cd dashboard && npm install

# 2. Configure credentials (see Configuration below) — via files, never committed

# 3. Run the dashboard
npm run dev          # → http://localhost:4319
```

### Configuration

All secrets are read from **files outside the repo** (never hard-coded, never committed):

| Secret | Location |
|--------|----------|
| Video API key | `~/.<service>_key` (chmod 600) |
| Trend-feed token | `~/.<service>_token` (chmod 600) |
| Vision LLM key | `~/.llm_vision_key` (chmod 600) |
| Storage / Drive | `rclone` remotes (`rclone config`) |
| Transit host URL | `R2_CDN` / `R2_BUCKET` env vars |

---

## 🔒 Security & privacy

This repository contains **only source code**. Deliberately excluded via `.gitignore`:

- ❌ API keys, tokens, credentials (all loaded from external files at runtime)
- ❌ Downloaded third-party reference videos (copyright)
- ❌ Character photos and rendered outputs
- ❌ The operational database (captions, metrics, prompts, spend ledger)
- ❌ `node_modules`, logs, temp files
- ❌ Personal domains / infrastructure endpoints (parameterized to env vars)

---

## 📜 License

MIT — see [LICENSE](LICENSE).

---

## 🗺️ Roadmap

- [ ] Per-persona Manual/Auto toggle wired to scheduled runs
- [ ] In-UI per-video instruction field (plumbing ready)
- [ ] One-click final-resolution re-render button
- [ ] Multi-platform publish targets
- [ ] Seamless >15s videos via continuation/extend

---

<p align="center"><em>Built as a study in agentic media automation — vision-driven selection, self-authoring prompts, and taste-learning feedback loops.</em></p>
