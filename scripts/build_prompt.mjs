#!/usr/bin/env node
/**
 * Build a Genjutsu/Seedance prompt from a reference video, automatically,
 * using the local opus-4.8 vision model (localhost:20128).
 *
 * Usage: node build_prompt.mjs <persona_id> <video_id> [extra_instruction]
 * Prints the final prompt to stdout AND saves it to videos.prompt_used.
 *
 * Steps:
 *   1. extract 3 frames (start/mid/end) from the ref via ffmpeg
 *   2. send frames + master_prompt template + niche + optional instruction
 *      to opus-4.8 vision -> it fills the [SLOTS] describing the ref's motion,
 *      keeping the locked character, applying any extra instruction (e.g.
 *      "replace the animal with a white tiger").
 *   3. save + print the final prompt.
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

function extractFrames(refPath) {
  const dur = parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", refPath], { encoding: "utf8" }).trim()
  ) || 10;
  const marks = [0.05, 0.45, 0.9].map((p) => (dur * p).toFixed(2));
  const frames = [];
  marks.forEach((t, i) => {
    const out = path.join(os.tmpdir(), `bp_${Date.now()}_${i}.jpg`);
    execFileSync("ffmpeg", ["-y", "-ss", String(t), "-i", refPath, "-frames:v", "1", "-vf", "scale=512:-1", out], { stdio: "pipe" });
    frames.push(out);
  });
  return frames;
}

async function visionPrompt(frames, masterPrompt, niche, instruction, storyMode = false) {
  const images = frames.map((f) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` },
  }));

  const sys = storyMode ? `You are a prompt engineer for AI video motion-transfer (Seedance/Genjutsu).
You are given 3 frames (start/middle/end) of a VIRAL REFERENCE video, a MASTER PROMPT template for a locked character persona, and the niche.
Your job: write ONE final prompt that KEEPS the reference's motion/energy/pacing, but tells a NEW VARIATION of the story (different content/object/subject) instead of copying the reference exactly.
RULES:
- Keep the locked character description EXACTLY as in the master prompt (appearance, glasses, count of characters). Never change the character's appearance.
- Preserve the reference's MOTION and SEQUENCE OF ACTIONS (the body movement, timing, camera energy) — this is a motion-transfer, the movement must still match.
- But VARY the content/subject/object per the instruction (e.g. reference cooks chicken → make it cook duck; same motions, different food). Swap the secondary subject/object/setting to the new variation.
- If no explicit instruction is given, invent a tasteful, niche-appropriate variation that keeps the same motion.
- End with the locking clauses (9:16, no text overlay, character stays consistent, keep original timing/energy).
- Output ONLY the final prompt text, no preamble, no explanation.` : `You are a prompt engineer for AI video motion-transfer (Genjutsu/Seedance).
You are given 3 frames (start/middle/end) of a VIRAL REFERENCE video, a MASTER PROMPT template for a locked character persona, and the niche.
Your job: write ONE final prompt that makes the AI recreate the reference's EXACT motion/sequence, but with the locked character replacing the main person.
RULES:
- Keep the locked character description EXACTLY as in the master prompt (glasses, white t-shirt, etc). Never change the character's appearance.
- Fill the [SLOTS] (actions, location, secondary subject/animal, lighting, props) based on what you SEE in the frames.
- Describe the action as a clear "Sequence of events: ... Then ... Then ..." matching the frames.
- End with the locking clauses (9:16, no text overlay, character stays consistent, keep original timing).
- Output ONLY the final prompt text, no preamble, no explanation.`;

  const userText = `NICHE: ${niche}

MASTER PROMPT TEMPLATE (keep character locked${storyMode ? ", motion same, VARY the content" : ", fill the [SLOTS]"}):
"""
${masterPrompt}
"""
${instruction ? `\n${storyMode ? "STORY VARIATION" : "EXTRA INSTRUCTION"} (apply this): ${instruction}\n` : ""}
Here are the 3 reference frames (start, middle, end). Write the final prompt now.`;

  const payload = {
    model: LLM_MODEL,
    max_tokens: 1200,
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
  // handle both plain JSON and SSE (data: {...}) responses
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    // SSE: concatenate content deltas
    let content = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payloadStr = t.slice(5).trim();
      if (payloadStr === "[DONE]") break;
      try {
        const chunk = JSON.parse(payloadStr);
        content += chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.message?.content || "";
      } catch {}
    }
    return content.trim();
  }
  return j.choices?.[0]?.message?.content?.trim() || "";
}

async function main() {
  const [, , personaId, videoId, ...rest] = process.argv;
  // --story flag => variation mode (keep motion, vary content/story). Rest = extra instruction.
  const storyMode = rest.includes("--story");
  const instruction = rest.filter((x) => x !== "--story").join(" ").trim();
  if (!personaId || !videoId) {
    console.error("Usage: node build_prompt.mjs <persona_id> <video_id> [--story] [extra_instruction]");
    process.exit(2);
  }
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  const video = db.prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, personaId);
  if (!persona || !video) { console.error("not found"); process.exit(1); }
  if (!persona.master_prompt) { console.error("persona has no master_prompt"); process.exit(1); }

  const refPath = path.join(PERSONAS_DIR, personaId, video.local_ref);
  if (!fs.existsSync(refPath)) { console.error("ref file missing"); process.exit(1); }

  console.error("Extracting frames…");
  const frames = extractFrames(refPath);
  console.error(`Vision (${LLM_MODEL}) building prompt${storyMode ? " [STORY mode]" : ""}${instruction ? " + instruction" : ""}…`);
  const prompt = await visionPrompt(frames, persona.master_prompt, persona.niche, instruction, storyMode);
  frames.forEach((f) => { try { fs.unlinkSync(f); } catch {} });

  if (!prompt || prompt.length < 50) { console.error("prompt too short / empty"); process.exit(1); }

  db.prepare("UPDATE videos SET prompt_used=?, updated_at=datetime('now') WHERE id=?").run(prompt, videoId);
  console.log(prompt);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
