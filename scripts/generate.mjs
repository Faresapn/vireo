#!/usr/bin/env node
/**
 * Unified generate pipeline (dashboard-callable).
 *
 * Usage: node generate.mjs <persona_id> <video_id> <engine> [resolution]
 *   engine: genjutsu | seedance
 *   resolution: 720p (default) | 480p | 1080p
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
import { delegateToGo } from "./_go.mjs";

delegateToGo("generate", process.argv.slice(2), { paid: true });

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const HF_KEY = fs.readFileSync(path.join(os.homedir(), ".higgsfield_key"), "utf8").trim();
// Second Higgsfield account (separate billing/credit). Explicit per-engine map:
//   Key A -> wan-prime, genjutsu-light   |   Key B -> genjutsu, seedance(-2.5)
// (genjutsu vs genjutsu-light share a prefix -> must be explicit, not prefix.)
function readKey2() { try { return fs.readFileSync(path.join(os.homedir(), ".higgsfield_key2"), "utf8").trim(); } catch { return ""; } }
const HF_KEY_B = readKey2() || HF_KEY;
const ENGINE_KEY = {
  "wan-prime": HF_KEY, "wan": HF_KEY, "genjutsu-light": HF_KEY,
  "genjutsu": HF_KEY_B, "seedance-2.5": HF_KEY_B, "seedance": HF_KEY_B,
};
function keyForEngine(engine) { return ENGINE_KEY[engine] || HF_KEY; }

// Load local, git-ignored config (.env.local) for the R2 transit host etc.
// The repo ships only placeholder values; real CDN/bucket live here, never committed.
try {
  const envPath = path.join(STUDIO_ROOT, ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch {}

// Seedance accepts only EVEN durations (odd values trigger "parameters not
// supported"). For reference-to-video the duration must also be <= the ref clip's
// length — sending a duration LONGER than the ref makes Seedance reject it as
// "interpreted as video editing...must follow the input video". So we round DOWN to
// the nearest even (floor-to-even): 15→14, 16→16, 9→8. Proven from working jobs:
// ref 16.04→dur16 OK, ref 9.17→dur8 OK; a ref 15.0→dur16 (UP) FAILED with editing.
function evenDur(d) {
  let n = Math.floor(Number(d) || 4);
  if (n % 2 !== 0) n -= 1; // floor to even (never exceed the source length)
  return Math.max(4, n);
}

const ENGINES = {
  genjutsu: {
    endpoint: "https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_url: refUrl, image_urls: imageUrls, prompt, resolution,
    }),
  },
  // Genjutsu Light — same motion-transfer, 6x cheaper (480p $0.05/s vs $0.318/s),
  // max 15s. Great budget default for ≤15s refs. Same body shape as genjutsu.
  "genjutsu-light": {
    endpoint: "https://api.higgsfield.ai/higgsfield/genjutsu-light/motion-transfer/v1.0",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_url: refUrl, image_urls: imageUrls, prompt, resolution,
    }),
  },
  seedance: {
    endpoint: "https://api.higgsfield.ai/bytedance/seedance-2.0/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt, resolution,
      aspect_ratio: "9:16", duration: Math.min(dur, 15),
      generate_audio: true, bitrate_mode: "high",
    }),
  },
  "seedance-2.5": {
    endpoint: "https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt, resolution,
      aspect_ratio: "9:16", duration: Math.min(dur, 30),
      generate_audio: true, bitrate_mode: "high",
    }),
  },
  // Wan 3.0 — cheaper, and (unlike 2.6) DOES support image_urls for character lock.
  // reference-to-video: video_urls (motion ref) + image_urls (char photos) + prompt.
  // duration 2-30s, resolution 480/720/1080 (we lock 720p). Good cheap 3rd option.
  wan: {
    endpoint: "https://api.higgsfield.ai/alibaba/wan-3.0/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt,
      resolution: resolution === "480p" ? "480p" : "720p",
      aspect_ratio: "9:16", duration: Math.min(Math.max(dur, 2), 30),
    }),
  },
  // Wan 3.0 Prime — higher quality than base Wan 3.0 (less slop), still cheaper
  // than Seedance/Genjutsu. Same schema (image_urls char-lock, 2-30s, 480/720/1080).
  "wan-prime": {
    endpoint: "https://api.higgsfield.ai/alibaba/wan-3.0-prime/reference-to-video",
    body: (refUrl, imageUrls, prompt, resolution, dur) => ({
      video_urls: [refUrl], image_urls: imageUrls, prompt,
      resolution: resolution === "480p" ? "480p" : "720p",
      aspect_ratio: "9:16", duration: Math.min(Math.max(dur, 2), 30),
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

// Max reference-video length accepted by Higgsfield engines (Seedance 2.5 &
// Wan Prime both reject ref clips > 30s — "normalized to at most 30 seconds" /
// "clips must be 1-30 seconds"). We trim to 29s (safe margin; 30.0 exact has
// failed too) so long viral refs don't get rejected mid-generation.
const REF_MAX_S = 29;

// Higgsfield/Seedance silently rejects over-large assets with the misleading
// "parameters not supported" error (seen with 5504px/22MB char PNGs and 4K refs,
// while ≤3080px chars and ≤720x1280 refs always passed). We downscale both before
// upload. Image long-edge cap, ref long-edge cap:
const IMG_MAX_PX = 2048;
// Personas sent like the successful Higgsfield web request: original-size char sheets,
// in reverse order (turnaround sheet first). Testing against "interpreted as video editing".
const WEB_STYLE_SHEETS = new Set(["mc-asthon-hall", "mc-kepin-extreme-1lvi"]);
// Seedance silently rejects a ref video whose SHORT edge != 720 with the
// misleading "parameters not supported" error. Every OK job had a 720-short-edge
// ref (720x1280, 720x738); the two FAILs were 480x854 (too small) and 2160x3840
// (too big). We normalize the ref's short edge to exactly 720 (scale up or down).
const REF_SHORT_PX = 720;

// Downscale a character image if its long edge exceeds IMG_MAX_PX. Returns a path
// to the (possibly new) file; caller must clean up temps where path !== original.
function downscaleImage(src, maxPx = IMG_MAX_PX) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", src], { encoding: "utf8" }));
    const w = probe.streams?.[0]?.width || 0;
    const h = probe.streams?.[0]?.height || 0;
    if (!w || !h || (w <= maxPx && h <= maxPx)) return src;
    const ext = path.extname(src).toLowerCase();
    const outExt = ext === ".png" ? ".png" : ".jpg";
    const tmp = src.slice(0, src.length - path.extname(src).length) + `_ds${outExt}`;
    console.error(`char ${w}x${h} > ${maxPx}px — downscaling`);
    execFileSync("ffmpeg", ["-y", "-i", src, "-vf", `scale='min(${maxPx},iw)':'min(${maxPx},ih)':force_original_aspect_ratio=decrease`, tmp], { stdio: "pipe" });
    return fs.existsSync(tmp) ? tmp : src;
  } catch { return src; }
}

// Length of the first video stream in seconds; 0 if it can't be read.
function videoStreamSeconds(src) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration", "-of", "json", src], { encoding: "utf8" }));
    return parseFloat(probe.streams?.[0]?.duration) || parseFloat(probe.format?.duration) || 0;
  } catch { return 0; }
}

function ensureH264(src) {
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", "-show_entries", "format=duration", src], { encoding: "utf8" }));
    const vstream = probe.streams?.find((s) => s.codec_type === "video");
    const vcodec = vstream?.codec_name;
    const vw = vstream?.width || 0, vh = vstream?.height || 0;
    const hasAudio = probe.streams?.some((s) => s.codec_type === "audio");
    const refDur = parseFloat(probe.format?.duration) || 0;
    const tooLong = refDur > 30;
    const shortEdge = Math.min(vw, vh);
    const wrongSize = shortEdge > 0 && shortEdge !== REF_SHORT_PX;
    if (tooLong) console.error(`ref is ${refDur.toFixed(1)}s (>30s engine limit) — trimming to ${REF_MAX_S}s`);
    if (wrongSize) console.error(`ref short-edge is ${shortEdge}px (need ${REF_SHORT_PX}) — normalizing`);
    // No work needed only if already h264+audio AND within the 30s limit AND short-edge 720.
    if (vcodec === "h264" && hasAudio && !tooLong && !wrongSize) return src;
    const tmp = src.replace(/\.mp4$/, "_h264tmp.mp4");
    const trimArgs = tooLong ? ["-t", String(REF_MAX_S)] : [];
    // Normalize short edge to exactly REF_SHORT_PX (scale up or down), keep aspect, even dims.
    const scaleArgs = wrongSize ? ["-vf", `scale='if(lt(iw,ih),${REF_SHORT_PX},-2)':'if(lt(iw,ih),-2,${REF_SHORT_PX})',scale=trunc(iw/2)*2:trunc(ih/2)*2`] : [];
    // PRESERVE the ref's ORIGINAL audio when it has one — genjutsu carries the
    // source video's audio into the output, so stripping it (injecting a silent
    // anullsrc track) is exactly why our genjutsu renders came out mute while a
    // raw-ref genjutsu job kept its sound. Only inject a silent track when the ref
    // genuinely has NO audio (some engines need an audio track present).
    let audioArgs;
    if (hasAudio) {
      // keep original audio, re-encode to aac, trim handled by -t on output
      audioArgs = { inputs: ["-i", src], maps: ["-map", "0:v", "-map", "0:a"], acodec: ["-c:a", "aac"] };
    } else {
      audioArgs = { inputs: ["-i", src, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"], maps: ["-map", "0:v", "-map", "1:a"], acodec: ["-c:a", "aac", "-shortest"] };
    }
    execFileSync("ffmpeg", ["-y", ...audioArgs.inputs, ...trimArgs, ...scaleArgs, "-c:v", "libx264", "-pix_fmt", "yuv420p", ...audioArgs.acodec, ...audioArgs.maps, tmp], { stdio: "pipe" });
    return fs.existsSync(tmp) ? tmp : src;
  } catch { return src; }
}

async function hfSubmit(endpoint, body, key = HF_KEY) {
  // Single idempotency key across retries: a network blip won't double-submit.
  const idemKey = `gen-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
// Download the finished video with retries — render is already paid for, a blip
// must not lose it.
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
// 40 min: Seedance queues can run past 20 min; giving up early loses a paid render.
async function hfPoll(statusUrl, key = HF_KEY, { tries = 480, delayMs = 5000 } = {}) {
  let netFails = 0; // consecutive network/transient failures
  for (let i = 0; i < tries; i++) {
    let j;
    try {
      const r = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` } });
      j = await r.json();
      netFails = 0;
    } catch (e) {
      // Transient network blip — render keeps running on Higgsfield. Retry a few
      // times instead of giving up on the whole generation.
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
  const [, , personaId, videoId, engine = "seedance", resolution = "720p", durArg] = process.argv;
  if (!personaId || !videoId || !ENGINES[engine]) {
    console.error("Usage: node generate.mjs <persona_id> <video_id> <engine> [resolution] [duration]");
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  const video = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!persona || !video) { console.error("persona/video not found"); process.exit(1); }

  // Prompt priority: a REAL vision-authored prompt > persona.master_prompt
  // (locked character template) > generic fallback. We treat a previously-saved
  // GENERIC fallback in prompt_used as empty, so it never shadows master_prompt
  // (that bug made a manual generate keep producing a generic character).
  const GENERIC = "The scene follows the exact same sequence as the reference video, matching every movement frame-for-frame, replacing the main person with the reference character while keeping the original motion, setting, timing and energy unchanged.";
  const savedPrompt = (video.prompt_used || "").trim();
  // Prompt priority: vision-authored prompt_used > video.master_prompt (freestyle
  // per-ref template) > persona.master_prompt > generic.
  const prompt = (savedPrompt && savedPrompt !== GENERIC ? savedPrompt : "")
    || (video.master_prompt || "").trim()
    || (persona.master_prompt || "").trim()
    || GENERIC;

  // Character images: prefer this video's OWN set (freestyle per-ref). If the
  // video has none, fall back to the persona-wide set (normal personas).
  let chars = db.prepare("SELECT rel_path FROM character_images WHERE video_id=? ORDER BY ord ASC, id ASC").all(video.id);
  if (!chars.length) {
    chars = db.prepare("SELECT rel_path FROM character_images WHERE persona_id=? AND video_id IS NULL ORDER BY ord ASC, id ASC").all(personaId);
  }
  if (!chars.length) { console.error("no character images"); process.exit(1); }

  // RANDOM ANIMAL POOL: if the persona has an `animals/` folder with image files,
  // pick ONE at random and append it as an extra reference image. This lets
  // kepin-animal vary the creature per generate (locked human char + a random
  // animal photo). Personas without the folder are untouched.
  const animalsDir = path.join(PERSONAS_DIR, personaId, "animals");
  if (fs.existsSync(animalsDir)) {
    const pool = fs.readdirSync(animalsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
    if (pool.length) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      console.error(`[random-animal] picked "${pick}" from ${pool.length} in animals/`);
      chars.push({ rel_path: path.join("animals", pick) });
    }
  }

  if (WEB_STYLE_SHEETS.has(personaId)) chars.reverse();

  const stamp = Date.now().toString(36);
  const refRaw = path.join(PERSONAS_DIR, personaId, video.local_ref);
  const refH264 = ensureH264(refRaw);
  const uploaded = [];

  console.error(`[${engine}] uploading ref + ${chars.length} chars…`);
  const refName = `${personaId}_${video.shortcode}_ref_${stamp}.mp4`;
  const refUrl = r2Upload(refH264, refName); uploaded.push(refName);
  const imageUrls = [];
  const charTmps = [];
  chars.forEach((c, i) => {
    const cl = path.join(PERSONAS_DIR, personaId, c.rel_path);
    if (!fs.existsSync(cl)) return;
    const clDs = WEB_STYLE_SHEETS.has(personaId) ? cl : downscaleImage(cl);
    if (clDs !== cl) charTmps.push(clDs);
    const rn = `${personaId}_char${i + 1}_${stamp}${path.extname(clDs)}`;
    imageUrls.push(r2Upload(clDs, rn)); uploaded.push(rn);
  });

  // Reference audio — ONLY for personas that explicitly set audio_mode="ref".
  // This NEVER touches personas on "auto"/"off" (they stay exactly like the original
  // working flow — no audio fields at all). audio_ref is a JSON array of rel paths.
  const audioMode = persona.audio_mode || "auto";
  const audioUrls = [];
  if (audioMode === "ref" && persona.audio_ref) {
    let refs = [];
    try { const v = JSON.parse(persona.audio_ref); refs = Array.isArray(v) ? v : [persona.audio_ref]; }
    catch { refs = [persona.audio_ref]; }
    refs.forEach((rel, i) => {
      const af = path.join(PERSONAS_DIR, personaId, rel);
      if (fs.existsSync(af)) {
        const an = `${personaId}_voice${i + 1}_${stamp}${path.extname(af)}`;
        audioUrls.push(r2Upload(af, an)); uploaded.push(an);
      }
    });
  }

  // Duration: for reference-to-video, Seedance requires the requested duration to be
  // STRICTLY LESS THAN the source clip length. If duration >= source, it rejects as
  // "interpreted as video editing...must follow the input video". Proven by the web
  // app (source 8s → duration 7) and our logs (ref 8.0/dur 8 = FAIL, ref 9.2/dur 8 =
  // OK, ref 16.04/dur 16 = OK). So: take ceil of the source and subtract 1 to stay
  // just under it (works whether the source is 8.0 or 8.7). NOT forced even — odd
  // durations (7) are fine; the real constraint is strictly-below-source.
  // Measure the VIDEO stream of the file we actually upload: videos.duration_s is the
  // container length, which trailing audio can push past the video (ref 2873: container
  // 6.08s, video 5.93s, so duration 6 was still rejected).
  const srcLen = videoStreamSeconds(refH264) || video.duration_s || 5;
  const refDur = Math.max(4, Math.ceil(srcLen) - 1); // strictly below source length
  const wantDur = durArg ? parseInt(durArg, 10) : refDur;
  const dur = Math.min(Math.max(wantDur || refDur, 4), 30);

  // Engine resolution: "seedance" ALWAYS uses 2.5 (2.0 is low quality — restyles
  // the scene + weak character lock). 2.0 is never used.
  let effEngine = engine;
  if (engine === "seedance") effEngine = "seedance-2.5";
  // audio_mode="ref" needs Seedance 2.5 (only engine that takes audio_urls).
  if (audioMode === "ref" && audioUrls.length && effEngine !== "seedance-2.5") effEngine = "seedance-2.5";
  const isSeedance = effEngine === "seedance" || effEngine === "seedance-2.5";
  const hfKey = keyForEngine(effEngine); // Key B for seedance/genjutsu, Key A otherwise

  // Build request body. Default = NO audio fields (original working flow, every
  // non-ref persona). ONLY audio_mode="ref" with voices adds generate_audio+audio_urls
  // on Seedance 2.5 — this is the double-voice chef flow that already worked.
  const body = ENGINES[effEngine].body(refUrl, imageUrls, prompt, resolution, dur);
  if (effEngine === "seedance-2.5" && audioMode === "ref" && audioUrls.length) {
    body.generate_audio = true;
    body.audio_urls = audioUrls;
  }

  console.error(`[${effEngine}] submit ${resolution}${isSeedance || effEngine.startsWith("wan") ? ` 9:16 ${dur}s` : ""}…`);
  // DEBUG: dump the exact body sent to Higgsfield (prompt trimmed) so we can see
  // whether audio_urls actually attaches.
  console.error("REQUEST BODY → " + JSON.stringify({ ...body, prompt: `[${(body.prompt||"").length} chars]` }, null, 2));
  const sub = await hfSubmit(ENGINES[effEngine].endpoint, body, hfKey);
  if (!sub.request_id) { console.error("submit failed:", JSON.stringify(sub).slice(0, 200)); uploaded.forEach(r2Delete); process.exit(1); }
  // Log the request handle immediately so a later poll-timeout can still be
  // recovered (the render keeps running server-side even if our poll gives up).
  console.error(`SUBMITTED request_id=${sub.request_id} status_url=${sub.status_url}`);
  // Stash the request_id on the row right away (not only on success) so a timeout
  // leaves a handle we can re-poll instead of paying for a fresh render.
  try { db.prepare("UPDATE videos SET hf_request_id=?, updated_at=datetime('now') WHERE id=?").run(sub.request_id, videoId); } catch {}

  let result;
  try { result = await hfPoll(sub.status_url, hfKey); }
  catch (e) {
    console.error("FAILED:", e.message);
    uploaded.forEach(r2Delete);
    if (refH264 !== refRaw) { try { fs.unlinkSync(refH264); } catch {} }
    charTmps.forEach((t) => { try { fs.unlinkSync(t); } catch {} });
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
  const buf = await downloadRetry(outUrl);
  fs.writeFileSync(path.join(outDir, outName), buf);

  // 480p → output_480; anything higher (720p/1080p) → output_1080 slot (the hi-res pointer).
  const col = resolution === "480p" ? "output_480" : "output_1080";
  const finalStage = persona.skip_qc ? "done" : "qc";
  db.prepare(`UPDATE videos SET ${col}=?, prompt_used=?, hf_request_id=?, stage=?, qc_status=?, updated_at=datetime('now') WHERE id=?`)
    .run(path.join("output", resolution, outName), prompt, sub.request_id, finalStage, finalStage === "done" ? "ok" : null, videoId);
  // skip_qc persona: the render goes straight to HASIL, archived like a QC OK.
  if (finalStage === "done") {
    try { execFileSync("node", [path.join(import.meta.dirname, "drive_archive.mjs"), personaId, String(videoId)], { stdio: "ignore", timeout: 180000 }); } catch {}
  }

  uploaded.forEach(r2Delete);
  if (refH264 !== refRaw) { try { fs.unlinkSync(refH264); } catch {} }
  charTmps.forEach((t) => { try { fs.unlinkSync(t); } catch {} });

  console.log(JSON.stringify({ ok: true, engine, request_id: sub.request_id, output: path.join("output", resolution, outName), size_mb: (buf.length / 1048576).toFixed(2) }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
