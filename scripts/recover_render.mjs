#!/usr/bin/env node
/**
 * Recover a render whose poll gave up (e.g. "poll timeout") while Higgsfield
 * kept rendering. Re-polls videos.hf_request_id and downloads the result.
 * No new render is submitted, so nothing is charged again.
 *
 * Usage: node recover_render.mjs <persona_id> <video_id>
 * On success: output saved, stage='qc' ('done' for skip_qc personas), gen_error cleared.
 * Still running after RECOVER_TRIES polls: stage='shortlist' with a note, so it can be retried.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { delegateToGo } from "./_go.mjs";

delegateToGo("recover", process.argv.slice(2), { paid: true });

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const POLL_MS = 5000;
const RECOVER_TRIES = 480; // 40 min
const FAILED = ["failed", "canceled", "error", "nsfw", "rejected", "content_moderation"];

const readKey = (f) => { try { return fs.readFileSync(path.join(os.homedir(), f), "utf8").trim(); } catch { return ""; } };
// Seedance runs on key 2, Wan/Genjutsu-light on key 1; try both.
const KEYS = [readKey(".higgsfield_key2"), readKey(".higgsfield_key")].filter(Boolean);

async function status(requestId, key) {
  const r = await fetch(`https://api.higgsfield.ai/requests/${requestId}/status`, { headers: { Authorization: `Key ${key}` } });
  const j = await r.json().catch(() => ({}));
  return j.status && !j.detail ? j : null;
}

async function main() {
  const [, , personaId, videoId] = process.argv;
  if (!personaId || !videoId) { console.error("Usage: node recover_render.mjs <persona_id> <video_id>"); process.exit(2); }
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  const video = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!persona || !video) { console.error("persona/video not found"); process.exit(1); }
  const fail = (msg) => {
    console.error("FAILED:", msg);
    db.prepare("UPDATE videos SET stage='shortlist', gen_error=?, updated_at=datetime('now') WHERE id=?").run(msg.slice(0, 200), videoId);
    process.exit(1);
  };
  if (!video.hf_request_id) fail("recover: request_id tidak tersimpan, cek hasil di web Higgsfield");

  // Find which account owns the request.
  let key = null;
  for (const k of KEYS) {
    try { if (await status(video.hf_request_id, k)) { key = k; break; } } catch {}
  }
  if (!key) fail(`recover: request ${video.hf_request_id} tidak ditemukan`);
  console.error(`recover ${video.hf_request_id}`);

  let result = null;
  for (let i = 0; i < RECOVER_TRIES && !result; i++) {
    let j = null;
    try { j = await status(video.hf_request_id, key); } catch {}
    const st = j?.status;
    process.stderr.write(`\rpoll ${i + 1}: ${st || "net-retry"}        `);
    if (st === "completed") result = j;
    else if (FAILED.includes(st)) fail(`${st}: ${String(j.error || j.message || "").slice(0, 180)}`);
    else await new Promise((r) => setTimeout(r, POLL_MS));
  }
  process.stderr.write("\n");
  if (!result) fail("poll timeout (render masih jalan, klik Cek Ulang lagi nanti)");
  const outUrl = result.video?.url;
  if (!outUrl) fail("recover: completed tapi tanpa url video");

  // Same file naming and resolution as the script that submitted it.
  const resolution = persona.render_res === "480p" ? "480p" : "720p";
  const outName = video.local_ref
    ? `${persona.viral_cluster_slug}_${video.shortcode}_${resolution}.mp4` // generate.mjs
    : `idea_${video.shortcode || video.id}_${resolution}.mp4`;             // generate_i2v.mjs
  const outDir = path.join(PERSONAS_DIR, personaId, "output", resolution);
  fs.mkdirSync(outDir, { recursive: true });
  let buf = null;
  for (let a = 1; a <= 5 && !buf; a++) {
    try {
      const r = await fetch(outUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      console.error(`download retry ${a}/5 (${e.message})`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  if (!buf) fail("recover: download gagal, klik Cek Ulang lagi");
  fs.writeFileSync(path.join(outDir, outName), buf);
  const col = resolution === "480p" ? "output_480" : "output_1080";
  const finalStage = persona.skip_qc ? "done" : "qc";
  db.prepare(`UPDATE videos SET ${col}=?, stage=?, qc_status=?, gen_error=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(path.join("output", resolution, outName), finalStage, finalStage === "done" ? "ok" : null, videoId);
  // skip_qc persona: the render goes straight to HASIL, archived like a QC OK.
  if (finalStage === "done") {
    try { execFileSync("node", [path.join(import.meta.dirname, "drive_archive.mjs"), personaId, String(videoId)], { stdio: "ignore", timeout: 180000 }); } catch {}
  }
  console.log(JSON.stringify({ ok: true, recovered: video.hf_request_id, output: path.join("output", resolution, outName), size_mb: (buf.length / 1048576).toFixed(2) }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
