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
import { delegateToGo } from "./_go.mjs";

delegateToGo("build-prompt", process.argv.slice(2));

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const LLM_URL = "http://localhost:20128/v1/chat/completions";
const LLM_MODEL = "cc/claude-opus-4-8";
const LLM_KEY = fs.readFileSync(path.join(os.homedir(), ".llm_vision_key"), "utf8").trim();

// Content-safety: Seedance/Higgsfield rejects prompts whose wording READS as
// sexual even when the clip is innocent (e.g. "poles pressed into his lap",
// "rolls onto his side with the poles beneath him"). Both LLM modes get this
// rule, and sanitizeSafe() rewrites the usual trigger words after the LLM.
const SAFE_RULE = `- CONTENT SAFETY (critical — the video engine auto-rejects anything that could read as sexual/NSFW): describe every action in plain, neutral, family-friendly sports/comedy language. Name props by their exact everyday name (e.g. "wooden baseball bats", not "poles", "shafts", "rods" or "sticks"). Never mention lap, crotch, groin, hips, thighs, chest contact, buttocks, between the legs, or a body lying on/over/under an object or person. Never use verbs like press into, rub, grind, thrust, straddle, mount, squeeze between, moan, writhe, caress, stroke, spread, lick, suck, wet, naked, undress, bed. For falls write "falls over sideways in a clumsy comedic way". Everyone stays fully clothed.`;

const SAFE_SWAPS = [
  [/\b(?:into|onto|on|in|across|over) (?:his|her|their) lap\b/gi, "toward the floor"],
  [/\b(?:his|her|their) lap\b/gi, "the floor"],
  [/\b(?:crotch|groin|between (?:his|her|their) legs|between the legs)\b/gi, "in front of the body"],
  [/\b(?:thighs?|buttocks?|butt|hips)\b/gi, "legs"],
  [/\bcurls? down over\b/gi, "leans down toward"],
  [/\b(?:pressed |held |clutch\w* )?(?:tight(?:ly)? )?against (?:(?:his|her|their) (?:chest|body|belly)|himself|herself|themselves)\b/gi, "upright in front of him"],
  [/\bpress(?:es|ing)? (?:them|it) (?:into|against)\b/gi, "pushes them toward"],
  [/\b(?:rubs?|rubbing|grinds?|grinding|thrusts?|thrusting|straddl\w*|strok\w*|caress\w*|writh\w*|moan\w*)\b/gi, "moves"],
  [/\brolls? onto (?:his|her|their) side\b/gi, "falls over sideways"],
  [/\bwith the ([\w\s-]{1,30}?) (?:beneath|under|underneath) (?:him|her|them)\b/gi, "and the $1 fall beside him"],
  [/\b(?:beneath|underneath) (?:him|her|them)\b/gi, "beside him"],
  [/\b(?:shafts?|rods?)\b/gi, "bats"],
];
function sanitizeSafe(text) {
  let out = text;
  for (const [re, rep] of SAFE_SWAPS) out = out.replace(re, rep);
  return out;
}

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

async function visionPrompt(frames, masterPrompt, niche, instruction, storyMode = false, opts = {}) {
  const { isDuo = false, voiceCount = 0 } = opts;
  const images = frames.map((f) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(f).toString("base64")}` },
  }));

  // Voice→character mapping clause (duo + reference voices present).
  // IMPORTANT: Seedance/Higgsfield does NOT understand "@audio1/@image1" tokens
  // (that's Dreamina/Vidu syntax). Must instruct in PLAIN ENGLISH to use the
  // provided reference audio, or the engine ignores it and invents a voice.
  let voiceClause = "";
  if (isDuo && voiceCount >= 2) {
    voiceClause = `\nVOICE (critical): the characters SPEAK USING THE PROVIDED REFERENCE AUDIO. Two distinct reference voices are supplied — the taller head character (LEFT) speaks with the FIRST reference voice, the other character (RIGHT) speaks with the SECOND reference voice; the two voices stay distinct and are never swapped. Each character's lip movements sync to their spoken lines. Do NOT invent new voices; match the provided reference audio. Write this in plain English — never use "@" tokens.`;
  } else if (voiceCount >= 1) {
    voiceClause = `\nVOICE (critical): the character SPEAKS USING THE PROVIDED REFERENCE AUDIO — match that reference voice's timbre/pitch/accent, lips synced to the lines. Do NOT invent a new voice. Plain English only, no "@" tokens.`;
  }

  const sys = storyMode ? `You are a prompt engineer for AI video motion-transfer (Seedance/Genjutsu).
You are given 3 frames (start/middle/end) of a VIRAL REFERENCE video, a MASTER PROMPT template for a locked character persona, and the niche.
Your job: write ONE final prompt that KEEPS the reference's motion/energy/pacing, but tells a NEW VARIATION of the story (different content/object/subject) instead of copying the reference exactly.
RULES:
- Keep the locked character description EXACTLY as in the master prompt (appearance, glasses, count of characters). Never change the character's appearance.
- Preserve the reference's MOTION and SEQUENCE OF ACTIONS (the body movement, timing, camera energy) — this is a motion-transfer, the movement must still match.
- But VARY the content/subject/object per the instruction (e.g. reference cooks chicken → make it cook duck; same motions, different food). Swap the secondary subject/object/setting to the new variation.
- If no explicit instruction is given, invent a tasteful, niche-appropriate variation that keeps the same motion.
- NEVER write "@" reference tokens (like @image1, @audio1) — the engine does not understand them. Refer to characters/voices in plain English (e.g. "the taller chef", "the first reference voice").
- NEVER copy any on-screen TEXT, captions, subtitles, watermarks, logos, usernames or overlays from the reference into the output. Output must be CLEAN: "no text, captions, watermark, logo or overlay anywhere in the frame."
- End with the locking clauses (9:16, no text overlay, character stays consistent, keep original timing/energy).
${SAFE_RULE}
- Output ONLY the final prompt text, no preamble, no explanation.` : `You are a SLOT-FILLER for an AI video motion-transfer prompt. You are given 3 frames (start/middle/end) of a reference video, a MASTER PROMPT that is the AUTHORITATIVE final prompt with a few [SLOTS] to fill, and the niche.
Your job: output the MASTER PROMPT VERBATIM, changing ONLY the [SLOT] placeholders. The master prompt is the boss — you fill its blanks, you do NOT rewrite, restructure, add, or remove anything else.
STRICT RULES:
- Reproduce the master prompt text EXACTLY. The ONLY edits allowed are replacing bracketed [SLOTS] (e.g. [EXPRESSION], [LOCATION], [POSITION_OR_POSE], [ACTION_1], [SUBJECT_2]) with short concrete phrases from what you SEE in the frames.
- Do NOT add new sentences, camera directions, zooms, moods, style notes, or any wording that is not already in the master prompt. If the master prompt doesn't mention it, you don't either.
- Keep the locked character description byte-for-byte as written in the master prompt. Never change appearance.
- For [SLOTS] about the main subject: the MAIN/most-centered person across all 3 frames IS the locked character, same person every frame; other people are background.
- If a [SLOT] has no clear value from the frames, use a minimal neutral fill (e.g. "a neutral expression") — never invent elaborate detail.
- Leave ZERO bracketed placeholders in the output (every [SLOT] must be filled).
- NEVER copy any on-screen TEXT, captions, subtitles, watermarks, logos, usernames or overlays that appear in the reference frames into the output. The master prompt already says "no text overlay or subtitles" — keep it that way, never add any text/caption/watermark description.
- NEVER write "@" reference tokens (like @image1, @audio1) — the engine does not understand them. Refer to characters/voices in plain English only.
- Exception to verbatim: if a master-prompt word itself breaks the CONTENT SAFETY rule below, use the safe wording instead.
${SAFE_RULE}
- Output ONLY the final filled prompt text, no preamble, no explanation.`;

  const userText = `NICHE: ${niche}

MASTER PROMPT TEMPLATE (${storyMode ? "keep character locked, motion same, VARY the content" : "AUTHORITATIVE — reproduce verbatim, fill ONLY the [SLOTS], add nothing"}):
"""
${masterPrompt}
"""
${instruction ? `\n${storyMode ? "STORY VARIATION" : "EXTRA INSTRUCTION"} (apply this): ${instruction}\n` : ""}${voiceClause}
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
  // Master prompt priority: video-scoped (freestyle per-ref) > persona-wide.
  let masterPrompt = (video.master_prompt || "").trim() || (persona.master_prompt || "").trim();
  if (!masterPrompt) { console.error("no master_prompt (video or persona)"); process.exit(1); }

  // RANDOM VARIANTS: any `{{opt A|opt B|opt C}}` token in the master is replaced by
  // ONE randomly-picked option per generate. Lets a persona vary e.g. wardrobe
  // ("{{a tight gray tank top|a plain white t-shirt}}") so every render differs.
  masterPrompt = masterPrompt.replace(/\{\{([^{}]+)\}\}/g, (_, body) => {
    const opts = body.split("|").map((s) => s.trim()).filter(Boolean);
    if (!opts.length) return "";
    const pick = opts[Math.floor(Math.random() * opts.length)];
    console.error(`[random] picked "${pick}" from ${opts.length} options`);
    return pick;
  });

  const refPath = path.join(PERSONAS_DIR, personaId, video.local_ref);
  if (!fs.existsSync(refPath)) { console.error("ref file missing"); process.exit(1); }

  // Duo + voice info: if persona is duo and has reference voices, tell the LLM to
  // assign voice 1 → character 1 (left), voice 2 → character 2 (right) explicitly.
  const isDuo = (persona.char_mode || "single") === "duo";
  let voiceCount = 0;
  if ((persona.audio_mode || "auto") === "ref" && persona.audio_ref) {
    try { const v = JSON.parse(persona.audio_ref); voiceCount = Array.isArray(v) ? v.length : 1; }
    catch { voiceCount = 1; }
  }

  console.error("Extracting frames…");
  const frames = extractFrames(refPath);
  console.error(`Vision (${LLM_MODEL}) building prompt${storyMode ? " [STORY mode]" : ""}${isDuo ? " [DUO]" : ""}${voiceCount ? ` [${voiceCount} voices]` : ""}${instruction ? " + instruction" : ""}…`);
  const rawPrompt = await visionPrompt(frames, masterPrompt, persona.niche, instruction, storyMode, { isDuo, voiceCount });
  frames.forEach((f) => { try { fs.unlinkSync(f); } catch {} });

  let prompt = sanitizeSafe(rawPrompt);
  if (prompt !== rawPrompt) console.error("[safe] rewrote risky wording for the content filter");
  if (!prompt || prompt.length < 50) { console.error("prompt too short / empty"); process.exit(1); }

  db.prepare("UPDATE videos SET prompt_used=?, updated_at=datetime('now') WHERE id=?").run(prompt, videoId);
  console.log(prompt);
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
