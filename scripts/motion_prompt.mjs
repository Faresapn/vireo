#!/usr/bin/env node
/**
 * Motion Control — LLM-authored per-scene prompt from a reference video.
 *
 * Usage: node motion_prompt.mjs <job_id>
 * Prints the final prompt to stdout AND saves it to motion_jobs.prompt,
 * flipping stage draft/prompting -> ready.
 *
 * NOT tied to any persona or master_prompt. The LLM watches the whole video
 * (a frame every ~2s), counts characters, and writes a timeline prompt that
 * swaps each on-screen character with the uploaded reference images in order
 * (Image 1 = main character, Image 2..N = supporting), aiming for a result as
 * close to the reference motion as possible on wan-prime/seedance-2.5/genjutsu.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const MOTION_DIR = path.join(STUDIO_ROOT, "motion");
const LLM_URL = "http://localhost:20128/v1/chat/completions";
const LLM_MODEL = "cc/claude-opus-4-8";
const LLM_KEY = fs.readFileSync(path.join(os.homedir(), ".llm_vision_key"), "utf8").trim();

// Extract a frame every `stepSec` seconds (default 2s) for accurate timeline.
function extractFrames(refPath, stepSec = 2) {
  const dur = parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", refPath], { encoding: "utf8" }).trim()
  ) || 10;
  const marks = [];
  for (let t = 0; t < dur; t += stepSec) marks.push(Math.min(t, dur - 0.1));
  // cap at 16 frames to keep token cost sane (32s @2s)
  const capped = marks.slice(0, 16);
  const frames = [];
  capped.forEach((t, i) => {
    const out = path.join(os.tmpdir(), `mc_${Date.now()}_${i}.jpg`);
    execFileSync("ffmpeg", ["-y", "-ss", t.toFixed(2), "-i", refPath, "-frames:v", "1", "-vf", "scale=512:-1", out], { stdio: "pipe" });
    frames.push({ t: t.toFixed(1), path: out });
  });
  return { frames, dur };
}

async function visionPrompt(frames, dur, charImgs, mainChar, engine) {
  const images = frames.map((f) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f.path).toString("base64")}` },
  }));

  const n = charImgs.length;
  const imageList = charImgs
    .map((c, i) => `- Image ${i + 1}${i === 0 ? " (MAIN CHARACTER)" : ""}: ${c.label || (i === 0 ? mainChar || "main subject" : "a supporting subject")}`)
    .join("\n");

  const sys = `You are a prompt engineer for AI video MOTION-TRANSFER / reference-to-video (${engine}).
You are given an ORDERED sequence of frames sampled every ~2 seconds from ONE reference video, and ${n} reference character image(s). Write ONE final prompt that reproduces the reference video AS CLOSELY AS POSSIBLE, but with every on-screen character REPLACED by the provided reference images.

HARD RULES:
- Keep EXACTLY the same choreography: every movement, action, contact, fall, gesture, timing and camera movement of the reference. Do NOT add, invent, remove or reorder any movement or event.
- ONE single continuous shot unless the reference clearly cuts. No new scenes, no new characters, no extra celebrations.
- CHARACTER REPLACEMENT: map the on-screen characters to the reference images IN ORDER. Image 1 is the MAIN character (the most prominent subject across the frames). Assign Image 2..${n} to the other distinct characters you SEE, by prominence/appearance order. If the video has more characters than images, reuse the closest matching image. If fewer, ignore extra images. Refer to them in PLAIN ENGLISH as "the <subject> from Image 1/2/3" — NEVER use "@" tokens.
- Describe each replacement subject concretely from its image (species/appearance), and state it keeps the same look from start to end (no morphing).
- Build an explicit TIMELINE in seconds that matches what happens in the sampled frames (0-2s, 2-4s, …), describing the action at each step so the engine follows the reference beat-for-beat. Total duration ≈ ${Math.round(dur)}s.
- Preserve the reference setting UNLESS the main-character description implies otherwise; keep it realistic and consistent.
- End with STYLE (ultra-realistic, natural light, contact shadows, vertical 9:16) and an AVOID list (humans if replaced by animals, morphing, scene cuts, new characters, extra movements, text, watermark, logo, captions, usernames).
- NEVER copy on-screen TEXT/captions/watermark/logo/username from the reference.
- Output ONLY the final prompt text — no preamble, no markdown, no explanation.`;

  const userText = `REFERENCE VIDEO: ${Math.round(dur)}s, ${frames.length} frames sampled (every ~2s, in order).
MAIN CHARACTER (Image 1): ${mainChar || "(not specified — infer the most prominent subject)"}
REFERENCE IMAGES (ordered):
${imageList}

Watch the frames in order, count the distinct characters, map them to the images, and write the final motion-transfer prompt now.`;

  const payload = {
    model: LLM_MODEL,
    max_tokens: 2000,
    stream: false,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [{ type: "text", text: userText }, ...images] },
    ],
  };

  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = await res.text();
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    let content = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") break;
      try { const chunk = JSON.parse(p); content += chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || ""; } catch {}
    }
    return content.trim();
  }
  return j.choices?.[0]?.message?.content?.trim() || "";
}

async function main() {
  const [, , jobId] = process.argv;
  if (!jobId) { console.error("Usage: node motion_prompt.mjs <job_id>"); process.exit(2); }
  const db = new DatabaseSync(DB_PATH);
  const job = db.prepare("SELECT * FROM motion_jobs WHERE id=?").get(jobId);
  if (!job) { console.error("job not found"); process.exit(1); }
  if (!job.local_ref) { console.error("job has no reference video"); process.exit(1); }

  const refPath = path.join(MOTION_DIR, String(jobId), job.local_ref);
  if (!fs.existsSync(refPath)) { console.error("ref file missing:", refPath); process.exit(1); }

  const charImgs = db.prepare("SELECT rel_path, ord, label FROM motion_images WHERE job_id=? ORDER BY ord ASC, id ASC").all(jobId);
  if (!charImgs.length) { console.error("no character images uploaded"); process.exit(1); }

  db.prepare("UPDATE motion_jobs SET stage='prompting', updated_at=datetime('now') WHERE id=?").run(jobId);

  console.error(`Extracting frames (every 2s)…`);
  const { frames, dur } = extractFrames(refPath, 2);
  console.error(`Vision (${LLM_MODEL}) writing timeline prompt from ${frames.length} frames, ${charImgs.length} char images…`);
  const prompt = await visionPrompt(frames, dur, charImgs, job.main_char, job.engine || "wan-prime");
  frames.forEach((f) => { try { fs.unlinkSync(f.path); } catch {} });

  if (!prompt || prompt.length < 80) { console.error("prompt too short / empty"); process.exit(1); }

  db.prepare("UPDATE motion_jobs SET prompt=?, duration_s=?, stage='ready', updated_at=datetime('now') WHERE id=?")
    .run(prompt, Math.round(dur), jobId);
  console.log(prompt);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
