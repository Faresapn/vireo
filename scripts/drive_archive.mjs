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
 * Persona with drive_folder_id (Denvo): only the output goes to that folder, named
 *   <DD-MM-YYYY>_<persona name>_<n>.mp4, n = that persona's nth video archived that day.
 *   "/" can't be in a file name, so the date uses "-".
 *
 * Idempotent: rclone copyto overwrites same name. Logs a marker in DB (drive_synced).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { delegateToGo } from "./_go.mjs";

delegateToGo("drive-archive", process.argv.slice(2));

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const REMOTE = "gdrive:";
const BASE = "HiggsfieldStudio";

function driveCopy(localPath, remotePath, folderId = null) {
  const args = ["copyto", localPath, `${REMOTE}${remotePath}`];
  if (folderId) args.push("--drive-root-folder-id", folderId);
  execFileSync("rclone", args, { stdio: "pipe" });
}

function datedName(db, persona, v) {
  if (v.drive_name) return v.drive_name; // re-archive keeps its name
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const day = `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}`;
  // "(MP) KEPIN ANIMAL" -> "KEPIN ANIMAL"
  const label = String(persona.name || persona.id).replace(/^\(MP\)\s*/i, "").replace(/[\\/:*?"<>|]/g, "").trim();
  const prefix = `${day}_${label}_`;
  const used = db.prepare("SELECT drive_name FROM videos WHERE persona_id=? AND drive_name LIKE ?")
    .all(persona.id, prefix + "%")
    .map((r) => Number(r.drive_name.slice(prefix.length).replace(/\.mp4$/, "")) || 0);
  return `${prefix}${Math.max(0, ...used) + 1}.mp4`;
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

  if (persona.drive_folder_id) {
    const outRel = v.output_1080 || v.output_480;
    const local = outRel && path.join(PERSONAS_DIR, personaId, outRel);
    if (!local || !fs.existsSync(local)) { console.error("output file not found"); process.exit(1); }
    const name = datedName(db, persona, v);
    driveCopy(local, name, persona.drive_folder_id);
    db.prepare("UPDATE videos SET drive_synced=1, drive_name=?, updated_at=datetime('now') WHERE id=?").run(name, videoId);
    console.log(JSON.stringify({ ok: true, folder: persona.drive_folder_id, uploaded: [name] }));
    return;
  }

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
