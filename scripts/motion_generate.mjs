#!/usr/bin/env node
/**
 * Motion Control — generate a reference-to-video from a motion_jobs row.
 *
 * Usage: node motion_generate.mjs <job_id>
 * Reads engine/resolution/prompt/gen_audio from the job + its motion_images,
 * uploads ref + images to R2 (ordered: Image 1 = main char), submits to the
 * chosen engine, polls, downloads output under motion/<job_id>/output/.
 *
 * Standalone: NOT tied to personas. Engines: wan-prime | seedance-2.5 | genjutsu.
 * Supports 1080p and enable_thinking (Wan), unlike the persona generate.mjs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const MOTION_DIR = path.join(STUDIO_ROOT, "motion");

// Two separate Higgsfield accounts (separate billing + credit balance):
//   Key A (~/.higgsfield_key)  -> wan-prime, genjutsu-light
//   Key B (~/.higgsfield_key2) -> genjutsu, seedance-2.5
// NOTE: explicit per-engine map — genjutsu(B) vs genjutsu-light(A) share a
// prefix, so prefix matching would misroute. Key B falls back to A if absent.
function readKey(file) { try { return fs.readFileSync(path.join(os.homedir(), file), "utf8").trim(); } catch { return ""; } }
const KEY_A = readKey(".higgsfield_key");
const KEY_B = readKey(".higgsfield_key2") || KEY_A;
const ENGINE_KEY = {
  "wan-prime": KEY_A,
  "wan": KEY_A,
  "genjutsu-light": KEY_A,
  "genjutsu": KEY_B,
  "seedance-2.5": KEY_B,
  "seedance": KEY_B,
};
// submit AND poll must use the SAME key (request status is per-account).
function keyForEngine(engine) { return ENGINE_KEY[engine] || KEY_A; }

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

const REF_MAX_S = 29;
function ensureH264(src) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", "-show_entries", "format=duration", src], { encoding: "utf8" }));
    const vcodec = probe.streams?.find((s) => s.codec_type === "video")?.codec_name;
    const hasAudio = probe.streams?.some((s) => s.codec_type === "audio");
    const refDur = parseFloat(probe.format?.duration) || 0;
    const tooLong = refDur > 30;
    if (tooLong) console.error(`ref is ${refDur.toFixed(1)}s (>30s engine limit) — trimming to ${REF_MAX_S}s`);
    if (vcodec === "h264" && hasAudio && !tooLong) return src;
    const tmp = src.replace(/\.mp4$/, "_h264tmp.mp4");
    const trimArgs = tooLong ? ["-t", String(REF_MAX_S)] : [];
    execFileSync("ffmpeg", ["-y", "-i", src, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", ...trimArgs, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-map", "0:v", "-map", "1:a", tmp], { stdio: "pipe" });
    return tmp;
  } catch { return src; }
}

// Motion-control engines. duration capped per engine docs. 1080p allowed.
const ENGINES = {
  "wan-prime": {
    endpoint: "https://api.higgsfield.ai/alibaba/wan-3.0-prime/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur, audio) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt,
      resolution, aspect_ratio: "9:16", duration: Math.min(Math.max(dur, 2), 30),
      enable_thinking: true,
      // only send generate_audio when ON; omit to use engine default (avoids
      // "parameters not supported" rejections on some ref-to-video configs)
      ...(audio ? { generate_audio: true } : {}),
    }),
  },
  "seedance-2.5": {
    endpoint: "https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur, audio) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt,
      resolution, aspect_ratio: "9:16", duration: Math.min(dur, 30),
      ...(audio ? { generate_audio: true } : {}),
    }),
  },
  genjutsu: {
    endpoint: "https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0",
    body: (refUrl, imageUrls, prompt, resolution) => ({
      video_url: refUrl, image_urls: imageUrls, prompt, resolution,
    }),
  },
};

async function hfSubmit(endpoint, body, key) {
  // Single idempotency key across retries: a network blip won't double-submit.
  const idemKey = `mc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
// Download finished video with retries — render already paid for, blip mustn't lose it.
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
async function hfPoll(statusUrl, key, { tries = 240, delayMs = 5000 } = {}) {
  let netErrs = 0;
  for (let i = 0; i < tries; i++) {
    let j;
    try {
      const r = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
      j = await r.json();
      netErrs = 0;
    } catch (e) {
      // transient network hiccup — do NOT abort the render, just retry.
      netErrs++;
      process.stderr.write(`\rpoll ${i + 1}: net-retry(${netErrs})    `);
      if (netErrs > 20) throw new Error("too many consecutive network errors");
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    const st = j.status;
    process.stderr.write(`\rpoll ${i + 1}: ${st}        `);
    if (st === "completed") { process.stderr.write("\n"); return j; }
    if (["failed", "canceled", "error", "nsfw", "rejected", "content_moderation"].includes(st)) {
      process.stderr.write("\n");
      const reason = j.error || j.message || j.detail || j.failure_reason || j.reason || "";
      throw new Error(`${st}: ${String(reason).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error("poll timeout");
}

async function main() {
  const [, , jobId] = process.argv;
  if (!jobId) { console.error("Usage: node motion_generate.mjs <job_id>"); process.exit(2); }
  const db = new DatabaseSync(DB_PATH);
  const job = db.prepare("SELECT * FROM motion_jobs WHERE id=?").get(jobId);
  if (!job) { console.error("job not found"); process.exit(1); }

  const engine = ENGINES[job.engine] ? job.engine : "wan-prime";
  const hfKey = keyForEngine(engine);
  const resolution = ["480p", "720p", "1080p"].includes(job.resolution) ? job.resolution : "720p";
  const prompt = (job.prompt || "").trim();
  if (!prompt || prompt.length < 50) { console.error("job has no prompt (run motion_prompt first)"); process.exit(1); }
  if (!job.local_ref) { console.error("job has no reference video"); process.exit(1); }

  const jobDir = path.join(MOTION_DIR, String(jobId));
  const refRaw = path.join(jobDir, job.local_ref);
  if (!fs.existsSync(refRaw)) { console.error("ref missing"); process.exit(1); }

  const imgs = db.prepare("SELECT rel_path FROM motion_images WHERE job_id=? ORDER BY ord ASC, id ASC").all(jobId);
  if (!imgs.length) { console.error("no character images"); process.exit(1); }

  db.prepare("UPDATE motion_jobs SET stage='generating', gen_error=NULL, updated_at=datetime('now') WHERE id=?").run(jobId);

  const stamp = Date.now().toString(36);
  const refH264 = ensureH264(refRaw);
  const uploaded = [];
  console.error(`[${engine}] uploading ref + ${imgs.length} images…`);
  const refName = `mc_${jobId}_ref_${stamp}.mp4`;
  const refUrl = r2Upload(refH264, refName); uploaded.push(refName);
  const imageUrls = [];
  imgs.forEach((c, i) => {
    const cl = path.join(jobDir, c.rel_path);
    if (!fs.existsSync(cl)) return;
    const rn = `mc_${jobId}_img${i + 1}_${stamp}${path.extname(cl)}`;
    imageUrls.push(r2Upload(cl, rn)); uploaded.push(rn);
  });

  const refDur = Math.round(job.duration_s || 10);
  const body = ENGINES[engine].body(refUrl, imageUrls, prompt, resolution, refDur, !!job.gen_audio);
  console.error(`[${engine}] submit ${resolution} ${refDur}s…`);
  console.error("REQUEST BODY → " + JSON.stringify({ ...body, prompt: `[${prompt.length} chars]` }, null, 2));

  const sub = await hfSubmit(ENGINES[engine].endpoint, body, hfKey);
  if (!sub.request_id) {
    console.error("submit failed:", JSON.stringify(sub).slice(0, 200));
    uploaded.forEach(r2Delete);
    db.prepare("UPDATE motion_jobs SET stage='ready', gen_error=? , updated_at=datetime('now') WHERE id=?").run(JSON.stringify(sub).slice(0, 200), jobId);
    process.exit(1);
  }
  // Persist request_id IMMEDIATELY so a later crash/network drop never loses the
  // render handle (we can resume polling via the stored id instead of paying again).
  db.prepare("UPDATE motion_jobs SET hf_request_id=?, updated_at=datetime('now') WHERE id=?").run(sub.request_id, jobId);
  console.error("request_id:", sub.request_id, "| status_url:", sub.status_url);

  let result;
  try { result = await hfPoll(sub.status_url, hfKey); }
  catch (e) {
    console.error("FAILED:", e.message);
    // Keep R2 files + request_id on failure so the render can still be polled
    // manually (it may still be running server-side). Only clean temp h264.
    if (refH264 !== refRaw) { try { fs.unlinkSync(refH264); } catch {} }
    db.prepare("UPDATE motion_jobs SET stage='ready', gen_error=?, updated_at=datetime('now') WHERE id=?").run(e.message.slice(0, 200), jobId);
    process.exit(1);
  }

  const outUrl = result.video?.url;
  if (!outUrl) {
    uploaded.forEach(r2Delete);
    db.prepare("UPDATE motion_jobs SET stage='ready', gen_error=?, updated_at=datetime('now') WHERE id=?").run("no output url", jobId);
    process.exit(1);
  }
  const outDir = path.join(jobDir, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `mc_${jobId}_${resolution}_${stamp}.mp4`;
  const buf = await downloadRetry(outUrl);
  fs.writeFileSync(path.join(outDir, outName), buf);

  db.prepare("UPDATE motion_jobs SET output_path=?, hf_request_id=?, stage='qc', updated_at=datetime('now') WHERE id=?")
    .run(path.join("output", outName), sub.request_id, jobId);

  uploaded.forEach(r2Delete);
  if (refH264 !== refRaw) { try { fs.unlinkSync(refH264); } catch {} }
  console.log(JSON.stringify({ ok: true, engine, request_id: sub.request_id, output: path.join("output", outName), size_mb: (buf.length / 1048576).toFixed(2) }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
