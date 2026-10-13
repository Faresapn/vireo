#!/usr/bin/env node
/**
 * Unified generate pipeline (dashboard-callable).
 *
 * Usage: node generate.mjs <persona_id> <video_id> <engine> [resolution]
 *   engine: genjutsu | seedance
 *   resolution: 480p (default) | 720p | 1080p
 *
 * Reads prompt from videos.prompt_used if present, else builds a minimal one.
 * NOTE: vision-based prompt authoring is done by the agent and written to
 *       videos.prompt_used BEFORE calling this. If empty, falls back to a
 *       generic motion-transfer instruction.
 *
 * Steps: ensure h264 ref -> upload R2 -> submit engine -> poll -> download
 *        -> update DB (output_*, stage=qc) -> cleanup R2 -> log decision stub.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const HF_KEY = fs.readFileSync(path.join(os.homedir(), ".higgsfield_key"), "utf8").trim();

const ENGINES = {
  genjutsu: {
    endpoint: "https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_url: refUrl, image_urls: imageUrls, prompt, resolution,
    }),
  },
  seedance: {
    endpoint: "https://api.higgsfield.ai/bytedance/seedance-2.0/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt, resolution,
      aspect_ratio: "9:16", duration: dur,
    }),
  },
};

const R2 = { remote: "r2", bucket: process.env.R2_BUCKET || "media", prefix: process.env.R2_PREFIX || "higgsfield-transit", cdn: process.env.R2_CDN || "https://your-r2-cdn.example.com", flags: ["--s3-no-check-bucket"] };

function r2Upload(localPath, name) {
  execFileSync("rclone", ["copyto", localPath, `${R2.remote}:${R2.bucket}/${R2.prefix}/${name}`, ...R2.flags], { stdio: "pipe" });
  return `${R2.cdn}/${R2.prefix}/${name}`;
}
function r2Delete(name) {
  try { execFileSync("rclone", ["delete", `${R2.remote}:${R2.bucket}/${R2.prefix}/${name}`, ...R2.flags], { stdio: "pipe" }); } catch {}
}

function ensureH264(src) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", src], { encoding: "utf8" }));
    const vcodec = probe.streams?.find((s) => s.codec_type === "video")?.codec_name;
    const hasAudio = probe.streams?.some((s) => s.codec_type === "audio");
    if (vcodec === "h264" && hasAudio) return src;
    const tmp = src.replace(/\.mp4$/, "_h264tmp.mp4");
    execFileSync("ffmpeg", ["-y", "-i", src, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-map", "0:v", "-map", "1:a", tmp], { stdio: "pipe" });
    return tmp;
  } catch { return src; }
}

async function hfSubmit(endpoint, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Key ${HF_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
    body: JSON.stringify(body),
  });
  return res.json();
}
async function hfPoll(statusUrl, { tries = 150, delayMs = 5000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(statusUrl, { headers: { Authorization: `Key ${HF_KEY}` } });
    const j = await r.json();
    const st = j.status;
    process.stderr.write(`\rpoll ${i + 1}: ${st}        `);
    if (st === "completed") { process.stderr.write("\n"); return j; }
    if (["failed", "canceled", "error", "nsfw", "rejected", "content_moderation"].includes(st)) {
      process.stderr.write("\n");
      throw new Error(`${st}: ${(j.error || "").slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("poll timeout");
}

async function main() {
  const [, , personaId, videoId, engine = "seedance", resolution = "480p"] = process.argv;
  if (!personaId || !videoId || !ENGINES[engine]) {
    console.error("Usage: node generate.mjs <persona_id> <video_id> <genjutsu|seedance> [resolution]");
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  const video = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!persona || !video) { console.error("persona/video not found"); process.exit(1); }

  const prompt = (video.prompt_used || "").trim()
    || "The scene follows the exact same sequence as the reference video, matching every movement frame-for-frame, replacing the main person with the reference character while keeping the original motion, setting, timing and energy unchanged.";

  const chars = db.prepare("SELECT rel_path FROM character_images WHERE persona_id=? ORDER BY ord ASC, id ASC").all(personaId);
  if (!chars.length) { console.error("no character images"); process.exit(1); }

  const stamp = Date.now().toString(36);
  const refRaw = path.join(PERSONAS_DIR, personaId, video.local_ref);
  const refH264 = ensureH264(refRaw);
  const uploaded = [];

  console.error(`[${engine}] uploading ref + ${chars.length} chars…`);
  const refName = `${personaId}_${video.shortcode}_ref_${stamp}.mp4`;
  const refUrl = r2Upload(refH264, refName); uploaded.push(refName);
  const imageUrls = [];
  chars.forEach((c, i) => {
    const cl = path.join(PERSONAS_DIR, personaId, c.rel_path);
    if (!fs.existsSync(cl)) return;
    const rn = `${personaId}_char${i + 1}_${stamp}${path.extname(cl)}`;
    imageUrls.push(r2Upload(cl, rn)); uploaded.push(rn);
  });

  const dur = Math.min(Math.max(Math.round(video.duration_s || 5), 4), 15);
  console.error(`[${engine}] submit ${resolution}${engine === "seedance" ? ` 9:16 ${dur}s` : ""}…`);
  const sub = await hfSubmit(ENGINES[engine].endpoint, ENGINES[engine].body(refUrl, imageUrls, prompt, resolution, dur));
  if (!sub.request_id) { console.error("submit failed:", JSON.stringify(sub).slice(0, 200)); uploaded.forEach(r2Delete); process.exit(1); }

  let result;
  try { result = await hfPoll(sub.status_url); }
  catch (e) {
    console.error("FAILED:", e.message);
    uploaded.forEach(r2Delete);
    if (refH264 !== refRaw) { try { fs.unlinkSync(refH264); } catch {} }
    db.prepare("UPDATE videos SET stage='shortlist', gen_error=?, updated_at=datetime('now') WHERE id=?")
      .run(e.message.slice(0, 200), videoId);
    process.exit(1);
  }

  const outUrl = result.video?.url;
  if (!outUrl) {
    console.error("no output url");
    uploaded.forEach(r2Delete);
    db.prepare("UPDATE videos SET stage='shortlist', gen_error=? , updated_at=datetime('now') WHERE id=?")
      .run("no output url", videoId);
    process.exit(1);
  }
  const outDir = path.join(PERSONAS_DIR, personaId, "output", resolution);
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `${persona.viral_cluster_slug}_${video.shortcode}_${resolution}.mp4`;
  const buf = Buffer.from(await (await fetch(outUrl)).arrayBuffer());
  fs.writeFileSync(path.join(outDir, outName), buf);

  const col = resolution === "1080p" ? "output_1080" : "output_480";
  db.prepare(`UPDATE videos SET ${col}=?, prompt_used=?, hf_request_id=?, stage='qc', updated_at=datetime('now') WHERE id=?`)
    .run(path.join("output", resolution, outName), prompt, sub.request_id, videoId);

  uploaded.forEach(r2Delete);
  if (refH264 !== refRaw) { try { fs.unlinkSync(refH264); } catch {} }

  console.log(JSON.stringify({ ok: true, engine, request_id: sub.request_id, output: path.join("output", resolution, outName), size_mb: (buf.length / 1048576).toFixed(2) }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
