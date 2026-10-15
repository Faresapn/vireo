#!/usr/bin/env node
/**
 * Pre-screen a reference video for motion-transfer suitability using opus-4.8 vision.
 *
 * Usage: node screen_ref.mjs <persona_id> <video_id>
 * Prints JSON { score, verdict, reason } and saves score to videos.ref_score + ref_notes.
 *
 * A GOOD ref for character motion-transfer has:
 *   - a CLEAR human performing visible actions (face/body on screen)
 *   - stable framing, not chaotic cuts
 *   - the person is the main subject (so we can swap in the locked character)
 * A BAD ref:
 *   - POV / hands-only / tiny-animal-only (no clear person to replace)
 *   - rapid scene changes, text-heavy, collage
 *   - subject that would make the model hallucinate (abstract, crowd)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const LLM_URL = "http://localhost:20128/v1/chat/completions";
const LLM_MODEL = "cc/claude-opus-4-8";
const LLM_KEY = fs.readFileSync(path.join(os.homedir(), ".llm_vision_key"), "utf8").trim();

function frames(refPath) {
  const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", refPath], { encoding: "utf8" }).trim()) || 10;
  const out = [];
  [0.1, 0.5, 0.9].forEach((p, i) => {
    const f = path.join(os.tmpdir(), `sr_${Date.now()}_${i}.jpg`);
    execFileSync("ffmpeg", ["-y", "-ss", String((dur * p).toFixed(2)), "-i", refPath, "-frames:v", "1", "-vf", "scale=480:-1", f], { stdio: "pipe" });
    out.push(f);
  });
  return out;
}

async function call(imgs) {
  const images = imgs.map((f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` } }));
  const sys = `You rate how suitable a reference video is for AI character MOTION-TRANSFER (swapping the main person with a locked character).
Return STRICT JSON only: {"score": <0-100>, "verdict": "<good|weak|bad>", "reason": "<short>"}

HIGH score (70-100): the SAME clear single human is the main subject in ALL 3 frames, visible face/body, doing one continuous recognizable action, stable consistent setting. Easy to replace the person with our character.
MEDIUM (40-69): person present but partially (far, side, some POV), or shares focus with animal, minor cuts but same scene.
LOW (0-39): reject these —
  - the 3 frames show DIFFERENT scenes/subjects (compilation / meme / montage) — e.g. frame1 person, frame2 food, frame3 landscape
  - visible UI overlays (Instagram/TikTok story bars, music stickers, comment fields, close buttons)
  - large overlay TEXT / captions / meme text
  - POV / hands-only / tiny-animal-only / crowd / abstract
  - chaotic rapid cuts, no single consistent subject
A compilation or meme-format clip is ALWAYS bad (score < 30) even if one frame has a person, because the subject is not consistent and the transfer will hallucinate.
Judge across ALL 3 frames (start/mid/end): if the main subject or scene CHANGES between frames, score LOW. Output JSON only, no prose.`;
  const payload = {
    model: LLM_MODEL, max_tokens: 200, stream: false,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: [{ type: "text", text: "Rate this reference (3 frames: start/mid/end):" }, ...images] },
    ],
  };
  const res = await fetch(LLM_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const raw = await res.text();
  let content;
  try { content = JSON.parse(raw).choices[0].message.content; }
  catch {
    content = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t.startsWith("data:")) { try { content += JSON.parse(t.slice(5).trim()).choices?.[0]?.delta?.content || ""; } catch {} }
    }
  }
  // extract JSON object from content
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in LLM reply: " + content.slice(0, 120));
  return JSON.parse(m[0]);
}

async function main() {
  const [, , personaId, videoId] = process.argv;
  if (!personaId || !videoId) { console.error("Usage: node screen_ref.mjs <persona_id> <video_id>"); process.exit(2); }
  const db = new DatabaseSync(DB_PATH);
  const v = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!v) { console.error("not found"); process.exit(1); }
  const refPath = path.join(PERSONAS_DIR, personaId, v.local_ref);
  if (!fs.existsSync(refPath)) { console.error("ref missing"); process.exit(1); }

  // Hard duration gate: refs >30s can't fit any engine (Genjutsu trims to 30,
  // Seedance 2.5 max 30) — reject before spending a vision call.
  const durS = parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", refPath], { encoding: "utf8" }).trim()
  ) || 0;
  if (durS > 30) {
    const result = { score: 0, verdict: "bad", reason: `Too long (${durS.toFixed(0)}s > 30s engine limit)` };
    db.prepare("UPDATE videos SET ref_score=?, ref_notes=?, updated_at=datetime('now') WHERE id=?")
      .run(result.score, `${result.verdict}: ${result.reason}`, videoId);
    console.log(JSON.stringify(result));
    return;
  }

  const fr = frames(refPath);
  let result;
  try { result = await call(fr); } finally { fr.forEach((f) => { try { fs.unlinkSync(f); } catch {} }); }

  db.prepare("UPDATE videos SET ref_score=?, ref_notes=?, updated_at=datetime('now') WHERE id=?")
    .run(result.score, `${result.verdict}: ${result.reason}`, videoId);

  console.log(JSON.stringify(result));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
