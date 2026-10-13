#!/usr/bin/env node
/**
 * Archive a finished video + its reference to Google Drive (rclone remote 'gdrive').
 *
 * Usage: node drive_archive.mjs <persona_id> <video_id>
 *
 * Uploads:
 *   output 1080p (or 480p fallback) -> GDrive/HiggsfieldStudio/<slug>/output/<res>/
 *   reference mp4                    -> GDrive/HiggsfieldStudio/<slug>/references/
 *
 * Idempotent: rclone copyto overwrites same name. Logs a marker in DB (drive_synced).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const REMOTE = "gdrive:";
const BASE = "HiggsfieldStudio";

function driveCopy(localPath, remotePath) {
  execFileSync("rclone", ["copyto", localPath, `${REMOTE}${remotePath}`], { stdio: "pipe" });
}

async function main() {
  const [, , personaId, videoId] = process.argv;
  if (!personaId || !videoId) {
    console.error("Usage: node drive_archive.mjs <persona_id> <video_id>");
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  const v = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!persona || !v) { console.error("persona/video not found"); process.exit(1); }

  const slug = persona.viral_cluster_slug || persona.id;
  let uploaded = [];

  // 1. output (prefer 1080p, else 480p)
  const outRel = v.output_1080 || v.output_480;
  if (outRel) {
    const local = path.join(PERSONAS_DIR, personaId, outRel);
    if (fs.existsSync(local)) {
      const res = v.output_1080 ? "1080p" : "480p";
      const name = path.basename(local);
      driveCopy(local, `${BASE}/${slug}/output/${res}/${name}`);
      uploaded.push(`output/${res}/${name}`);
    }
  }

  // 2. reference
  if (v.local_ref) {
    const refLocal = path.join(PERSONAS_DIR, personaId, v.local_ref);
    if (fs.existsSync(refLocal)) {
      const name = path.basename(refLocal);
      driveCopy(refLocal, `${BASE}/${slug}/references/${name}`);
      uploaded.push(`references/${name}`);
    }
  }

  // mark synced
  try {
    db.prepare("UPDATE videos SET drive_synced=1, updated_at=datetime('now') WHERE id=?").run(videoId);
  } catch {}

  console.log(JSON.stringify({ ok: true, slug, uploaded }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
