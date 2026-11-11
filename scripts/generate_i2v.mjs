#!/usr/bin/env node
/**
 * Idea-only generate pipeline: Seedance 2.5 REFERENCE-TO-VIDEO (no motion ref).
 *
 * Used by personas with NO viral cluster (idea-only). Unlike the normal
 * reference-to-video flow (which transfers motion from a ref video), here we send
 * ONLY the character image + the idea prompt + a forced 9:16 aspect ratio, with
 * NO video_urls. The reference-to-video endpoint honors aspect_ratio (the
 * image-to-video endpoint does NOT), so output is always vertical 9:16 regardless
 * of the source photo's dimensions.
 *
 * Usage: node generate_i2v.mjs <persona_id> <video_id> [resolution] [duration]
 *   resolution: 480p | 720p (default) | 1080p
 *   duration:   4..30 (default 5)
 *
 * Reads prompt from videos.prompt_used (the LLM-authored, user-edited idea).
 * Character image = persona-wide character_images (ord ASC) — first = main char.
 *
 * Endpoint: POST https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video
 *   body: { image_urls:[...], prompt, duration, resolution, aspect_ratio:"9:16" }
 *   (video_urls intentionally omitted — character + prompt drive the whole video.)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { delegateToGo } from "./_go.mjs";

delegateToGo("generate-i2v", process.argv.slice(2), { paid: true });

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const HF_KEY = fs.readFileSync(path.join(os.homedir(), ".higgsfield_key"), "utf8").trim();
// Seedance runs on Key B (same as reference-to-video seedance in generate.mjs).
function readKey2() { try { return fs.readFileSync(path.join(os.homedir(), ".higgsfield_key2"), "utf8").trim(); } catch { return ""; } }
const HF_KEY_B = readKey2() || HF_KEY;

const ENDPOINT = "https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video";

// Load .env.local for R2 transit host (same as generate.mjs).
try {
  const envPath = path.join(STUDIO_ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch {}

const R2 = { remote: "r2", bucket: process.env.R2_BUCKET || "media", prefix: process.env.R2_PREFIX || "higgsfield-transit", cdn: process.env.R2_CDN || "https://your-r2-cdn.example.com", flags: ["--s3-no-check-bucket"] };
function r2Upload(localPath, name) {
  execFileSync("rclone", ["copyto", localPath, `${R2.remote}:${R2.bucket}/${R2.prefix}/${name}`, ...R2.flags], { stdio: "pipe" });
  return `${R2.cdn}/${R2.prefix}/${name}`;
}
function r2Delete(name) {
  try { execFileSync("rclone", ["delete", `${R2.remote}:${R2.bucket}/${R2.prefix}/${name}`, ...R2.flags], { stdio: "pipe" }); } catch {}
}

async function hfSubmit(endpoint, body, key) {
  // One idempotency key for all retries of THIS submit: a transient network blip
  // won't create a duplicate render — Higgsfield dedups by this key.
  const idemKey = `i2v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", "Idempotency-Key": idemKey },
        body: JSON.stringify(body),
      });
      return res.json();
    } catch (e) {
      lastErr = e;
      process.stderr.write(`submit net-retry ${attempt}/4 (${String(e.message || e).slice(0, 40)})\n`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`submit network failed: ${String(lastErr?.message || lastErr).slice(0, 120)}`);
}
// Download the finished video with retries. The render is ALREADY paid for at this
// point — a transient blip must not lose it. Retry up to 5x before giving up.
async function downloadRetry(url, { tries = 5, delayMs = 4000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      lastErr = e;
      process.stderr.write(`download net-retry ${attempt}/${tries} (${String(e.message || e).slice(0, 40)})\n`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`download failed: ${String(lastErr?.message || lastErr).slice(0, 120)}`);
}
// 40 min: Seedance queues can run past 12 min; giving up early loses a paid render.
async function hfPoll(statusUrl, key, { tries = 480, delayMs = 5000 } = {}) {
  let netFails = 0; // consecutive network/transient failures
  for (let i = 0; i < tries; i++) {
    let j;
    try {
      const r = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
      j = await r.json();
      netFails = 0; // reset on any successful poll
    } catch (e) {
      // Transient network blip (DNS/conn reset) — do NOT give up. The render keeps
      // running on Higgsfield's side. Retry; only bail after many in a row.
      netFails++;
      process.stderr.write(`\rpoll ${i + 1}: net-retry ${netFails}/6 (${String(e.message || e).slice(0, 40)})   `);
      if (netFails >= 6) throw new Error(`poll network failed ${netFails}x in a row: ${String(e.message || e).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    const st = j.status;
    process.stderr.write(`\rpoll ${i + 1}: ${st}        `);
    if (st === "completed") { process.stderr.write("\n"); return j; }
    if (["failed", "canceled", "error", "nsfw", "rejected", "content_moderation"].includes(st)) {
      process.stderr.write("\n");
      console.error("FULL STATUS RESPONSE → " + JSON.stringify(j, null, 2).slice(0, 800));
      const reason = j.error || j.message || j.detail || j.failure_reason || j.reason || (j.data && (j.data.error || j.data.message)) || "";
      throw new Error(`${st}: ${String(reason).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("poll timeout");
}

async function main() {
  const [, , personaId, videoId, resolution = "720p", durArg] = process.argv;
  if (!personaId || !videoId) {
    console.error("Usage: node generate_i2v.mjs <persona_id> <video_id> [resolution] [duration]");
    process.exit(2);
  }
  const res = ["480p", "720p", "1080p"].includes(resolution) ? resolution : "720p";
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  const video = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!persona || !video) { console.error("persona/video not found"); process.exit(1); }

  // Prompt: LLM-authored idea (prompt_used) > video.master_prompt > persona.master_prompt.
  let prompt = (video.prompt_used || "").trim()
    || (video.master_prompt || "").trim()
    || (persona.master_prompt || "").trim();
  if (!prompt) { console.error("no prompt (prompt_used/master_prompt all empty)"); process.exit(1); }

  // Character images: send the FULL persona-wide set in ord order. For a
  // reference-sheet persona (e.g. mp-kepin-animal) this is image_1=person,
  // image_2=chaser sheet, image_3=chased sheet — the prompt's <<<image_N>>>
  // tokens map to this exact order, so ALL must be uploaded (not just the first).
  let chars = db.prepare("SELECT rel_path FROM character_images WHERE persona_id=? AND video_id IS NULL ORDER BY ord ASC, id ASC").all(personaId);
  if (!chars.length) { console.error("no character image"); process.exit(1); }

  const stamp = Date.now().toString(36);
  const uploaded = [];
  console.error(`[seedance-ref] uploading ${chars.length} reference image(s)…`);
  const imageUrls = [];
  chars.forEach((c, i) => {
    const cl = path.join(PERSONAS_DIR, personaId, c.rel_path);
    if (!fs.existsSync(cl)) { console.error(`  skip missing: ${c.rel_path}`); return; }
    const rn = `${personaId}_i2v_img${i + 1}_${stamp}${path.extname(cl)}`;
    imageUrls.push(r2Upload(cl, rn)); uploaded.push(rn);
  });
  if (!imageUrls.length) { console.error("no reference image files on disk"); process.exit(1); }

  // NOTE: random PICK (the 2 animal names) is chosen at IDEA time in
  // generate_idea.mjs (with anti-dup vs the last pair). We intentionally do NOT
  // re-randomize here — the draft's prompt_used already carries the chosen pair, so
  // what the user previews in the UI is exactly what gets rendered. Re-randomizing
  // here would override the draft and break the anti-dup guarantee.

  // Duration: user pick or default 5 (clamp 4..30), forced EVEN (odd durations
  // trigger Seedance "parameters not supported").
  const wantDur = durArg ? parseInt(durArg, 10) : 5;
  let dur = Math.min(Math.max(wantDur || 5, 4), 30);
  if (dur % 2 !== 0) dur -= 1;
  if (dur < 4) dur = 4;

  // Reference-to-video WITHOUT a motion ref video — character image + prompt +
  // forced 9:16. Mirror the fields the Higgsfield web app sends on a successful
  // job (generate_audio + bitrate_mode) — omitting them can trigger
  // "parameters not supported".
  const body = {
    image_urls: imageUrls,
    prompt,
    duration: dur,
    resolution: res,
    aspect_ratio: "9:16",
    generate_audio: true,
    bitrate_mode: "high",
  };

  console.error(`[seedance-ref] submit ${res} ${dur}s 9:16…`);
  console.error("REQUEST BODY → " + JSON.stringify({ ...body, prompt: `[${prompt.length} chars]` }, null, 2));
  const sub = await hfSubmit(ENDPOINT, body, HF_KEY_B);
  if (!sub.request_id) { console.error("submit failed:", JSON.stringify(sub).slice(0, 200)); uploaded.forEach(r2Delete); process.exit(1); }
  // Save the handle right away so a poll timeout can be recovered (scripts/recover_render.mjs).
  console.error(`SUBMITTED request_id=${sub.request_id} status_url=${sub.status_url}`);
  try { db.prepare("UPDATE videos SET hf_request_id=?, updated_at=datetime('now') WHERE id=?").run(sub.request_id, videoId); } catch {}

  let result;
  try { result = await hfPoll(sub.status_url, HF_KEY_B); }
  catch (e) {
    console.error("FAILED:", e.message);
    uploaded.forEach(r2Delete);
    db.prepare("UPDATE videos SET stage='shortlist', gen_error=?, updated_at=datetime('now') WHERE id=?")
      .run(e.message.slice(0, 200), videoId);
    process.exit(1);
  }

  const outUrl = result.video?.url;
  if (!outUrl) {
    console.error("no output url");
    uploaded.forEach(r2Delete);
    db.prepare("UPDATE videos SET stage='shortlist', gen_error=?, updated_at=datetime('now') WHERE id=?")
      .run("no output url", videoId);
    process.exit(1);
  }
  const outDir = path.join(PERSONAS_DIR, personaId, "output", res);
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `idea_${video.shortcode || video.id}_${res}.mp4`;
  const buf = await downloadRetry(outUrl);
  fs.writeFileSync(path.join(outDir, outName), buf);

  const col = res === "480p" ? "output_480" : "output_1080";
  const finalStage = persona.skip_qc ? "done" : "qc";
  db.prepare(`UPDATE videos SET ${col}=?, prompt_used=?, hf_request_id=?, stage=?, qc_status=?, updated_at=datetime('now') WHERE id=?`)
    .run(path.join("output", res, outName), prompt, sub.request_id, finalStage, finalStage === "done" ? "ok" : null, videoId);
  // skip_qc persona: the render goes straight to HASIL, archived like a QC OK.
  if (finalStage === "done") {
    try { execFileSync("node", [path.join(import.meta.dirname, "drive_archive.mjs"), personaId, String(videoId)], { stdio: "ignore", timeout: 180000 }); } catch {}
  }

  uploaded.forEach(r2Delete);
  console.log(JSON.stringify({ ok: true, engine: "seedance-i2v", request_id: sub.request_id, output: path.join("output", res, outName), size_mb: (buf.length / 1048576).toFixed(2) }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
