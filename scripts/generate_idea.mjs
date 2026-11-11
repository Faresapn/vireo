#!/usr/bin/env node
/**
 * Idea-only: invent ONE fresh prompt idea for a persona that has NO viral cluster.
 *
 * The persona's master_prompt is the authoritative template (it already states
 * what MUST be generated and what may / may not change). This script asks the
 * LLM to develop ONE new concrete idea from that template, keeping the locked
 * character, then guarantees the idea is NOT a near-duplicate of any previous
 * idea for THIS persona (cosine similarity via the local embedding daemon).
 *
 * Usage: node generate_idea.mjs <persona_id>
 * Prints JSON: { ok, video_id, summary, prompt }  (the draft is NOT generated —
 * it lands in stage='shortlist' so the UI can show it editable before gas).
 *
 * Dedup is STRICTLY per-persona: candidate vectors are filtered by persona_id,
 * so another persona's ideas never collide here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { delegateToGo } from "./_go.mjs";

delegateToGo("idea", process.argv.slice(2));

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const LLM_URL = "http://localhost:20128/v1/chat/completions";
const LLM_MODEL = "cc/claude-opus-4-8";
const LLM_KEY = fs.readFileSync(path.join(os.homedir(), ".llm_vision_key"), "utf8").trim();
const EMBED_URL = "http://127.0.0.1:4330/embed";

const SIM_THRESHOLD = 0.93; // >= this vs any existing idea => too similar, retry.
const MAX_TRIES = 4;

async function embed(text) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!res.ok) throw new Error(`embed daemon ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const j = await res.json();
  return j.vectors[0];
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// One chat call to the local LLM; returns the reply text.
async function llmChat(sys, userText, maxTokens = 2000) {
  const payload = {
    model: LLM_MODEL,
    max_tokens: maxTokens,
    stream: false,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userText },
    ],
  };
  // Per-call timeout: if the local LLM hangs, abort THIS call (don't stall forever)
  // so the retry loop can try again or the fallback can kick in.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 55000);
  let res;
  try {
    res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const raw = await res.text();
  try {
    return JSON.parse(raw).choices?.[0]?.message?.content?.trim() || "";
  } catch {
    // SSE fallback
    let acc = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const p = t.slice(5).trim();
      if (p === "[DONE]") break;
      try { const c = JSON.parse(p); acc += c.choices?.[0]?.delta?.content || c.choices?.[0]?.message?.content || ""; } catch {}
    }
    return acc.trim();
  }
}

function avoidClauseFor(avoidList) {
  return avoidList.length
    ? `\nIDEAS ALREADY USED FOR THIS PERSONA (you MUST invent something clearly DIFFERENT — do NOT rephrase any of these, and do not reuse their main subject):\n${avoidList.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`
    : "\n(No previous ideas yet — this is the first.)\n";
}

async function llmIdea(masterPrompt, niche, avoidList) {
  const sys = `You are a creative video-prompt engineer for a LOCKED-CHARACTER persona.
You are given the persona's MASTER PROMPT (the authoritative template: it states the locked character, and which parts are fixed vs. which parts you may vary), and the niche.
Your job: invent ONE fresh, concrete video idea that OBEYS the master prompt — keep every locked element EXACTLY (character appearance, count, any "do not change" rules), and only vary what the master prompt allows to vary.
Make it scroll-stopping: surprising, funny, a little absurd, never the obvious or default choice. Do not reuse the master prompt's default example. If the master prompt has a creative-ideas section (e.g. "IDE KREATIF"), follow it closely.
This generates a video from a single character photo (no reference motion video). Describe the full action/scene/motion the character performs, start to finish, vivid and filmable.
HARD RULES:
- Keep the locked character description byte-for-byte faithful to the master prompt. Never alter appearance.
- Only change the elements the master prompt marks as variable. If the master prompt forbids something, never do it.
- NEVER add on-screen text, captions, subtitles, watermarks, logos, or usernames. Output must be clean.
- NEVER use "@" tokens (like @image1). Plain English only.
- The idea MUST be clearly distinct from every already-used idea listed.
- Output EXACTLY in this format, nothing else (no JSON, no markdown, no preamble):
SUMMARY: <one short line, <=120 chars, describing the idea concept>
PROMPT:
<the full final video prompt, ready to send to the engine, can be multiple lines>`;

  const userText = `NICHE: ${niche || "(none)"}

MASTER PROMPT (authoritative — obey its fixed/variable rules):
"""
${masterPrompt}
"""
${avoidClauseFor(avoidList)}
Invent ONE new idea now. Output EXACTLY with "SUMMARY:" then "PROMPT:" as instructed.`;

  const content = await llmChat(sys, userText);
  // Parse SUMMARY: / PROMPT: delimited output (robust vs quotes/newlines in prompt).
  const sm = content.match(/SUMMARY:\s*(.+?)\s*(?:\n\s*PROMPT:)/is);
  const pm = content.match(/PROMPT:\s*([\s\S]+)$/i);
  if (!sm || !pm) throw new Error("LLM output missing SUMMARY/PROMPT: " + content.slice(0, 160));
  // First line only: the model sometimes thinks out loud after the summary.
  const summary = sm[1].trim().split("\n")[0].trim();
  const prompt = pm[1].trim().replace(/^```[a-z]*\n?|```$/gi, "").trim();
  if (!summary || prompt.length < 40) throw new Error("summary/prompt too short");
  return { summary, prompt };
}

// SLOT-TEMPLATE personas (mp-kepin-animal): the master holds a long fixed prompt
// after a "=== PROMPT SIAP KIRIM ===" line with {{MAIN_ANIMAL}} / {{SUB_ANIMAL}}
// slots. Rewriting ~11k chars through the LLM drops beats, so the LLM only writes
// the two animal designs (following the guide above the marker) and the script
// fills them into the fixed template.
const PROMPT_MARKER = "=== PROMPT SIAP KIRIM ===";

async function llmAnimals(guide, niche, avoidList) {
  const sys = `You design the two animals for one episode of a fixed video template.
You are given the persona's GUIDE (rules and the creative-ideas section). Follow it closely.
Invent ONE new pair: a big MAIN animal (the chaser) and a small SUB animal (the one being chased).
Make them funny and scroll-stopping, but cute — never scary, gory or aggressive. How unusual they may be is set by the GUIDE: if it says only colors/markings are unusual, keep the species' real body shape and add no extra or fantasy body parts.
HARD RULES:
- Plain English. No brand names, logos, text, numbers or letters on the animals or anything they wear or ride.
- Each design is ONE paragraph (50–90 words) describing exactly what the animal looks like: base species, size, body shape, colors, markings, eyes, ears, and each unusual feature, so a video model can draw it the same in every frame.
- The pair must be clearly different from every already-used idea listed (different base species and different colors/features).
- Output EXACTLY this, nothing else:
SUMMARY: <one short line, <=120 chars, in Indonesian, naming both animals>
MAIN: <paragraph>
SUB: <paragraph>`;
  const userText = `NICHE: ${niche || "(none)"}

GUIDE:
"""
${guide}
"""
${avoidClauseFor(avoidList)}
Design ONE new pair now.`;
  const content = await llmChat(sys, userText, 1200);
  const sm = content.match(/SUMMARY:\s*(.+)/i);
  const mm = content.match(/MAIN:\s*([\s\S]+?)\n\s*SUB:/i);
  const um = content.match(/SUB:\s*([\s\S]+)$/i);
  if (!sm || !mm || !um) throw new Error("LLM output missing SUMMARY/MAIN/SUB: " + content.slice(0, 160));
  const clean = (s) => s.trim().replace(/\s*\n\s*/g, " ").replace(/^["']|["']$/g, "").trim();
  const summary = sm[1].trim().split("\n")[0].trim();
  const main = clean(mm[1]);
  const sub = clean(um[1]);
  if (!summary || main.length < 40 || sub.length < 40) throw new Error("animal designs too short");
  return { summary, main, sub };
}

// Runs make() up to MAX_TRIES times until its idea is not a near-duplicate of any
// prior idea of this persona. Falls back to the least-similar attempt.
async function novelIdea(make, embedText, priorVecs, avoidList) {
  let best = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    console.error(`idea attempt ${attempt}/${MAX_TRIES}…`);
    let idea;
    try {
      idea = await make(avoidList);
    } catch (e) {
      // LLM hiccup/timeout for this attempt — log and retry, don't abort the run.
      console.error(`  attempt ${attempt} failed: ${String(e.message || e).slice(0, 80)}`);
      continue;
    }
    const vec = await embed(embedText(idea));
    let maxSim = 0;
    for (const pv of priorVecs) { const s = cosine(vec, pv); if (s > maxSim) maxSim = s; }
    console.error(`  max cosine vs ${priorVecs.length} prior: ${maxSim.toFixed(4)}`);
    if (!best || maxSim < best.sim) best = { ...idea, vec, sim: maxSim };
    if (maxSim < SIM_THRESHOLD) return { ...idea, vec, sim: maxSim };
    // too similar: add to avoid-list so next attempt steers away, retry.
    avoidList.unshift(idea.summary);
  }
  // Never hard-fail: better a slightly-close idea than none.
  if (best) console.error(`no attempt under ${SIM_THRESHOLD}; using least-similar (sim ${best.sim.toFixed(4)})`);
  return best;
}

async function main() {
  const personaId = process.argv[2];
  if (!personaId) { console.error("Usage: node generate_idea.mjs <persona_id>"); process.exit(2); }
  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  if (!persona) { console.error("persona not found"); process.exit(1); }
  const masterPrompt = (persona.master_prompt || "").trim();
  if (!masterPrompt) { console.error("persona has no master_prompt — isi master prompt dulu"); process.exit(1); }

  // Existing ideas for THIS persona only (isolation via persona_id).
  const prior = db.prepare("SELECT summary, vector FROM idea_vectors WHERE persona_id=? ORDER BY created_at DESC").all(personaId);
  const priorVecs = prior.map((r) => { try { return JSON.parse(r.vector); } catch { return null; } }).filter(Boolean);
  // Cap avoid-list sent to LLM to the most recent 40 summaries (bounded context);
  // the cosine check still runs against ALL prior vectors for true dedup.
  const avoidList = prior.slice(0, 40).map((r) => r.summary);

  let chosen;
  if (masterPrompt.includes("{{MAIN_ANIMAL}}")) {
    const at = masterPrompt.lastIndexOf(PROMPT_MARKER);
    if (at < 0) { console.error(`master prompt punya {{MAIN_ANIMAL}} tapi tidak ada baris "${PROMPT_MARKER}"`); process.exit(1); }
    const guide = masterPrompt.slice(0, at).replace(/^AUTO_DURATION:.*$/m, "").trim();
    const template = masterPrompt.slice(at + PROMPT_MARKER.length).trim();
    const pair = await novelIdea(
      (avoid) => llmAnimals(guide, persona.niche, avoid),
      (p) => `${p.summary}\nMAIN: ${p.main}\nSUB: ${p.sub}`,
      priorVecs, avoidList,
    );
    if (pair) {
      chosen = {
        ...pair,
        prompt: template.split("{{MAIN_ANIMAL}}").join(pair.main).split("{{SUB_ANIMAL}}").join(pair.sub),
      };
      console.error(`[slot-template] MAIN: ${pair.main.slice(0, 80)}… | SUB: ${pair.sub.slice(0, 80)}…`);
    }
  } else {
    chosen = await novelIdea(
      (avoid) => llmIdea(masterPrompt, persona.niche, avoid),
      (i) => i.summary + "\n" + i.prompt,
      priorVecs, avoidList,
    );
  }
  if (!chosen) {
    console.error(`could not produce any idea after ${MAX_TRIES} tries`);
    process.exit(3);
  }

  // Create a draft videos row in stage='shortlist' (editable before generate).
  const shortcode = `idea${Date.now().toString(36)}`;
  const info = db.prepare(
    "INSERT INTO videos (persona_id, shortcode, stage, prompt_used, idea_summary, created_at, updated_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))"
  ).run(personaId, shortcode, "shortlist", chosen.prompt, chosen.summary);
  const videoId = Number(info.lastInsertRowid);

  // Persist the embedding for future dedup (isolated by persona_id).
  db.prepare(
    "INSERT INTO idea_vectors (persona_id, video_id, summary, vector, created_at) VALUES (?,?,?,?,datetime('now'))"
  ).run(personaId, videoId, chosen.summary, JSON.stringify(chosen.vec));

  console.log(JSON.stringify({ ok: true, video_id: videoId, summary: chosen.summary, prompt: chosen.prompt, sim: Number(chosen.sim.toFixed(4)) }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
