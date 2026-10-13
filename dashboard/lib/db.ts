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
  `);

  // --- lightweight column migrations (idempotent) ---
  const pcols = d.prepare("PRAGMA table_info(personas)").all() as any[];
  const has = (c: string) => pcols.some((x) => x.name === c);
  if (!has("viral_cluster_slug"))
    d.exec("ALTER TABLE personas ADD COLUMN viral_cluster_slug TEXT");

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
}
