# Architecture Deep-Dive

This document explains how **Vireo** works under the hood — the data model, the
automation scripts, the decision logic, and the lessons that shaped the design.

---

## 1. Persona-centric model

A **persona** is the unit of work:

```
1 persona = 1 niche = 1 trend feed = 1 locked character = 1 folder
```

Personas are never mixed — each has its own character identity, its own trend
source, and its own learning history. Adding a new automated account = adding
one persona row + one folder; the same scripts run every persona.

Each persona carries:
- `master_prompt` — a fill-in template (see §4)
- `character_images` — 1–8 locked reference photos of the character
- `viral_cluster_slug` — which trend-feed cluster to pull from
- `auto_instruction` — optional standing instruction for auto-mode
- `auto_mode` — manual vs. full-auto toggle

---

## 2. The videos table = a stage machine

Every candidate/clip is a row in `videos` moving through stages:

```
inbox → shortlist → generating → qc → done
```

- `GET  /api/personas/[id]/videos?stage=` — list a column
- `PATCH {video_id, stage}` — move a card (this is also the QC signal)
- `DELETE ?video_id=` — drop a card

The dashboard's 5-column Kanban is a direct view of this table. The two human
gates (pick ref at `inbox→shortlist`, verdict at `qc→done`) are just stage moves.

Key columns: `shortcode` (stable IG identity — the anti-duplicate key),
`ref_score` (vision fitness), `prompt_used`, `gen_engine`, `gen_error`,
`output_480` / `output_1080`, `drive_synced`.

---

## 3. Reference identity = shortcode, never a sequence number

Files are named `<niche-slug>_<shortcode>.mp4`. The shortcode is the platform's
permanent per-post ID, so:
- Ingestion is **idempotent** — re-running skips already-seen shortcodes.
- Outputs share the shortcode (`<slug>_<shortcode>_480p.mp4`), so a clip is
  traceable reference → draft → final.
- Sequence numbers are deliberately avoided (delete-then-reingest could collide).

---

## 4. Master prompt = fill-in template

The master prompt is **not** free text — it's a template with `[SLOT]`
placeholders and a hard-coded character description:

```
A young [character description — FIXED] ...
Sequence of events: [ACTION_1]. Then [ACTION_2]. Then [ACTION_3] ...
Setting: [LOCATION_DETAILS]. [KEY_PROPS]. Lighting is [LIGHTING].
[aspect / no-text / character-consistency lock tail — FIXED]
```

The automation fills **only** the `[SLOT]`s from the reference; the character
text is never touched. The uploaded character photos must match the hard-coded
description or text/image clash produces bad output.

---

## 5. Vision pre-screen (the credit-saver)

`screen_ref.mjs` extracts 3 frames (start/mid/end), sends them to a vision
model, and returns:

```json
{ "score": 0-100, "verdict": "good|weak|bad", "reason": "..." }
```

**Rubric:**
- **70–100** — the *same* clear single human is the main subject across all 3
  frames, visible, doing one continuous action, stable scene.
- **40–69** — person partial, shares focus with an animal, minor cuts.
- **0–39** — reject: scene/subject changes between frames (compilation/meme),
  UI overlays (story bars, music stickers), big caption text, POV/hands-only,
  crowd, abstract, chaotic cuts.

> **Why this matters:** a character-transfer pipeline needs a clear human to
> replace. High view-count ≠ transfer-fit. Most viral clusters are dominated by
> meme/compilation reels — screening rejects them *before* paying for a render
> the QC would reject anyway.

Selection ranks survivors by `refScore*0.55 + velocity*0.25 + durationFit*0.20`.
If nothing clears the bar, the run **stops cleanly spending nothing** — the
correct outcome, not a failure.

---

## 6. Auto prompt authoring

`build_prompt.mjs` extracts 3 frames, sends them + the master template + the
niche + any instruction to the vision model, and gets back a finished prompt
that recreates the reference's motion with the locked character swapped in.

An optional instruction (e.g. *"replace the animal with a white tiger"*) is
applied as a directive — the character stays locked, only the specified object
changes.

---

## 7. Dual-engine routing

Two motion-transfer engines are supported. Routing logic:
1. **Rule first** — predator content (lion/tiger/bear/…) → force the more
   permissive engine (the stricter one's moderation flags predator contact).
2. **Else RAG** — the engine with the best historical OK-rate for the niche.
3. **Else default.**

Engine request shapes differ (one takes a single `video_url`, the other a
`video_urls` array + explicit `aspect_ratio` + `duration`), abstracted behind an
`ENGINES` map.

---

## 8. Async generation (no request timeouts)

Renders take minutes, so generation is **fire-and-forget**:
- The API route `spawn`s the generate script `detached` + `unref()`, logs to a
  file, marks the video `generating`, and returns in ~0.25s.
- The script owns the terminal state: on success → `qc` + output path; on
  failure → revert to `shortlist` + write `gen_error`.
- The dashboard polls every 5s *only while something is rendering*, and surfaces
  errors as a red banner.

---

## 9. Resilience: blocks & retries

Generation engines can reject a job for two distinct reasons (both surface as a
terminal poll status — handled immediately, never polled to timeout):
- **Content safety** — soften prompt / swap ref / try the other engine.
- **Copyright** — the reference itself is tainted (music/brand/watermark); the
  only fix is a different reference. Pre-screen can't detect hidden copyright,
  so a fraction of refs will block → the orchestrator **auto-retries** the next
  best reference (up to 3), excluding already-tried ones.

---

## 10. RAG decision-memory

A local SQLite `decisions` table logs every verdict with the reference's
features, the prompt, the engine, and `first_try`. The insights API computes:
- verdict tally + OK-rate
- **first-try OK-rate + sample count** (gates auto-finalize)
- per-engine win-rate → `best_engine`
- average winning reference duration → feeds ingest re-ranking
- a reusable library of winning prompts

**QC fades gradually, by data — not by a switch:**
- Phase 1 (<10 samples): draft → human QC → final
- Phase 2 (≥10 samples, ≥90% first-try): skip draft, still human QC
- Phase 3 (≥30 samples, ≥95% first-try): auto-finalize, no QC

---

## 11. Storage: transit vs. archive

- **Transit (S3-compatible):** a short-lived relay. A file lives here only for
  the minutes a render runs, then is **deleted** after archiving. Never fills.
  Provides the public URLs the generation APIs require.
- **Archive (Google Drive):** permanent, per-niche folders
  (`characters/`, `references/`, `output/{480p,1080p}/`), auto-created on persona
  creation, auto-populated on completion.

On deploy to a VPS with a public domain, the box can serve files itself and the
transit host becomes optional — the architecture doesn't change, only the
source-URL host.

---

## 12. Design lessons (baked into the code)

1. **Velocity ≠ transfer-fit** — always pre-screen with vision.
2. **Compilation/meme reels are the norm** in viral feeds — the screen rubric
   must judge across frames and reject scene changes + UI overlays.
3. **Normalize every reference to a standard codec** before submitting — some
   feeds serve VP9/no-audio, which crashes one engine with a generic
   "could not process body" error.
4. **Stop clean on no viable ref** — never force-pick a bad reference; a $0 run
   is the right outcome on a thin pool.
5. **Credentials via files, never in code or chat** — treat any exposed secret
   as compromised; rotate it.
