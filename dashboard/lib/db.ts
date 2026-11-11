import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

// Studio root = parent of dashboard/
export const STUDIO_ROOT = path.resolve(process.cwd(), "..");
export const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
export const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
export const SHARED_DIR = path.join(STUDIO_ROOT, "shared");

let _db: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA foreign_keys = ON;");
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: DatabaseSync) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      niche         TEXT NOT NULL,
      platform      TEXT NOT NULL DEFAULT 'instagram',
      master_prompt TEXT,
      character_img TEXT,
      aspect        TEXT DEFAULT '9:16',
      viral_source  TEXT,
      viral_cluster_slug TEXT,
      archived      INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    -- multiple character reference images per persona (Genjutsu image_urls accepts 1-8)
    CREATE TABLE IF NOT EXISTS character_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,            -- relative to personas/<id>/
      width      INTEGER,
      height     INTEGER,
      ord        INTEGER DEFAULT 0,        -- display/order index
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_charimg_persona ON character_images(persona_id, ord);

    CREATE TABLE IF NOT EXISTS videos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id    TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      stage         TEXT NOT NULL DEFAULT 'inbox',
      source_url    TEXT,
      local_ref     TEXT,
      duration_s    REAL,
      face_count    INTEGER,
      cut_count     INTEGER,
      ref_score     INTEGER,
      ref_notes     TEXT,
      prompt_used   TEXT,
      hf_request_id TEXT,
      output_480    TEXT,
      output_1080   TEXT,
      qc_status     TEXT,
      qc_notes      TEXT,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_videos_persona_stage ON videos(persona_id, stage);

    CREATE TABLE IF NOT EXISTS prompt_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      video_id   INTEGER,
      prompt     TEXT NOT NULL,
      result     TEXT,
      note       TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- RAG: decision memory — one row per QC verdict, grouped by niche.
    -- Lets the system learn Branko's taste per niche over time.
    CREATE TABLE IF NOT EXISTS decisions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id     TEXT NOT NULL,
      niche          TEXT NOT NULL,
      video_id       INTEGER,
      shortcode      TEXT,
      engine         TEXT,                 -- seedance / genjutsu
      resolution     TEXT,
      -- ref features (what the ref looked like)
      duration_s     REAL,
      views          INTEGER,
      views_per_hour REAL,
      caption        TEXT,
      creator        TEXT,
      -- the prompt used
      prompt         TEXT,
      -- the verdict
      verdict        TEXT NOT NULL,        -- ok / revisi / ulang
      qc_notes       TEXT,
      first_try      INTEGER DEFAULT 1,    -- 1 if OK on first generate
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_niche ON decisions(niche, verdict);
    CREATE INDEX IF NOT EXISTS idx_decisions_persona ON decisions(persona_id, created_at);

    -- Motion Control: standalone jobs, NOT tied to any persona/master_prompt.
    -- Ref video (from viral or manual upload) + N character images -> LLM writes
    -- a per-scene timeline prompt -> generate on wan-prime/seedance-2.5/genjutsu.
    CREATE TABLE IF NOT EXISTS motion_jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT,
      stage         TEXT NOT NULL DEFAULT 'draft',   -- draft|prompting|ready|generating|qc|done
      ref_source    TEXT,                            -- 'viral' | 'manual'
      ref_cluster   TEXT,                            -- cluster slug if from viral
      ref_shortcode TEXT,
      local_ref     TEXT,                            -- relative path under motion/<id>/
      duration_s    REAL,
      main_char     TEXT,                            -- user's "main character" label
      prompt        TEXT,                            -- LLM-authored, user-editable
      engine        TEXT,                            -- wan-prime|seedance-2.5|genjutsu
      resolution    TEXT DEFAULT '720p',
      gen_audio     INTEGER DEFAULT 0,
      output_path   TEXT,
      hf_request_id TEXT,
      gen_error     TEXT,
      saved_persona TEXT,                            -- on OK, which persona it was filed to
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS motion_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id     INTEGER NOT NULL REFERENCES motion_jobs(id) ON DELETE CASCADE,
      rel_path   TEXT NOT NULL,                      -- relative to motion/<job_id>/
      ord        INTEGER DEFAULT 0,                  -- 0 = Image 1 (main char)
      label      TEXT,                               -- optional user hint
      width      INTEGER,
      height     INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_motion_images_job ON motion_images(job_id, ord);

    -- Idea-only mode (persona with NO viral cluster): LLM invents fresh prompt
    -- ideas from the master_prompt alone (no ref video). Each generated idea's
    -- embedding is stored here so the next idea can be checked for near-duplicate
    -- (cosine) and rejected. STRICTLY isolated per persona via persona_id — one
    -- persona never sees another's vectors even if same niche.
    CREATE TABLE IF NOT EXISTS idea_vectors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id  TEXT NOT NULL,
      video_id    INTEGER,                         -- the videos row this idea became
      summary     TEXT NOT NULL,                   -- 1-line idea summary (human-readable)
      vector      TEXT NOT NULL,                   -- JSON array of 384 floats (bge-small)
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_idea_vectors_persona ON idea_vectors(persona_id, created_at);
  `);

  // --- lightweight column migrations (idempotent) ---
  const pcols = d.prepare("PRAGMA table_info(personas)").all() as any[];
  const has = (c: string) => pcols.some((x) => x.name === c);
  if (!has("viral_cluster_slug"))
    d.exec("ALTER TABLE personas ADD COLUMN viral_cluster_slug TEXT");
  // Per-persona render resolution (NULL = 720p) and skip_qc (finished renders go straight to 'done').
  if (!has("render_res")) d.exec("ALTER TABLE personas ADD COLUMN render_res TEXT");
  if (!has("skip_qc")) d.exec("ALTER TABLE personas ADD COLUMN skip_qc INTEGER DEFAULT 0");
  // Google Drive folder id for finished videos (scripts/drive_archive.mjs); NULL = HiggsfieldStudio/<slug>.
  if (!has("drive_folder_id")) d.exec("ALTER TABLE personas ADD COLUMN drive_folder_id TEXT");
  // Daily 11:00 auto-generate toggle (scripts/daily_auto.mjs).
  if (!has("daily_auto")) d.exec("ALTER TABLE personas ADD COLUMN daily_auto INTEGER DEFAULT 0");
  if (!has("daily_auto_last")) d.exec("ALTER TABLE personas ADD COLUMN daily_auto_last TEXT");
  if (!has("daily_auto_status")) d.exec("ALTER TABLE personas ADD COLUMN daily_auto_status TEXT");

  const vcols = d.prepare("PRAGMA table_info(videos)").all() as any[];
  const vhas = (c: string) => vcols.some((x) => x.name === c);
  if (!vhas("shortcode")) d.exec("ALTER TABLE videos ADD COLUMN shortcode TEXT");
  if (!vhas("views")) d.exec("ALTER TABLE videos ADD COLUMN views INTEGER");
  if (!vhas("views_per_hour"))
    d.exec("ALTER TABLE videos ADD COLUMN views_per_hour REAL");
  if (!vhas("caption")) d.exec("ALTER TABLE videos ADD COLUMN caption TEXT");
  if (!vhas("creator")) d.exec("ALTER TABLE videos ADD COLUMN creator TEXT");
  if (!vhas("gen_engine")) d.exec("ALTER TABLE videos ADD COLUMN gen_engine TEXT");
  if (!vhas("gen_error")) d.exec("ALTER TABLE videos ADD COLUMN gen_error TEXT");
  if (!vhas("gen_started_at")) d.exec("ALTER TABLE videos ADD COLUMN gen_started_at TEXT");
  if (!vhas("drive_synced")) d.exec("ALTER TABLE videos ADD COLUMN drive_synced INTEGER DEFAULT 0");
  // Name the video got in the persona's own Drive folder (e.g. 10-11-2026_Denvo_1.mp4).
  if (!vhas("drive_name")) d.exec("ALTER TABLE videos ADD COLUMN drive_name TEXT");
  // Freestyle persona: per-video master prompt template (overrides persona.master_prompt).
  if (!vhas("master_prompt")) d.exec("ALTER TABLE videos ADD COLUMN master_prompt TEXT");
  // Idea-only mode: 1-line summary of the LLM-invented idea (for dedup ledger + UI).
  if (!vhas("idea_summary")) d.exec("ALTER TABLE videos ADD COLUMN idea_summary TEXT");
  // Which ViralEngine sort this ref was pulled with ('velocity'=paling rame | 'date'=paling baru).
  // Lets the "Pilih Ref" INBOX show only refs matching the active sort toggle.
  // NULL = pulled before this feature (shown under both toggles so nothing hides).
  if (!vhas("ingest_order")) d.exec("ALTER TABLE videos ADD COLUMN ingest_order TEXT");

  // Freestyle persona: character images can be scoped to a single video.
  // video_id NULL = persona-wide (normal behavior, untouched). video_id set =
  // that ref's own character set.
  const ccols = d.prepare("PRAGMA table_info(character_images)").all() as any[];
  if (!ccols.some((x) => x.name === "video_id"))
    d.exec("ALTER TABLE character_images ADD COLUMN video_id INTEGER");
  if (!ccols.some((x) => x.name === "char_group"))
    d.exec("ALTER TABLE character_images ADD COLUMN char_group INTEGER DEFAULT 1");
}
