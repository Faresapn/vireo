#!/usr/bin/env node
/**
 * Daily auto-generate for idea-only (MP) personas whose toggle is ON.
 * Triggered at 11:00 by launchd (~/Library/LaunchAgents/ai.vireo.daily-auto.plist).
 *
 * Idea-only persona: generate_idea.mjs -> generate_i2v.mjs.
 * Cluster persona: auto_generate.mjs pulls the newest refs, picks the hottest
 * screened ref of at most CLUSTER_MAX_REF_S, and renders it with the
 * persona's locked engine (auto_engine).
 * Resolution: personas.render_res (480p for Denvo/Kaylee), else 720p.
 * Finished videos land in stage='qc', or 'done' when personas.skip_qc=1. Nothing is published.
 *
 * Usage: node daily_auto.mjs [--dry-run]
 *   --dry-run: list what would run; no LLM call, no render.
 *
 * Duration comes from an "AUTO_DURATION: <seconds>" line in the persona's master
 * prompt. A persona without that line is skipped, so nothing renders at a guessed length.
 *
 * Eligible: daily_auto=1, not archived, not freestyle.
 * daily_auto_last (local date) guards against a second run on the same day,
 * e.g. launchd firing on wake after a sleep that covered 11:00.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { delegateToGo } from "./_go.mjs";

delegateToGo("daily-auto", process.argv.slice(2), { paid: true });

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPTS = path.join(STUDIO_ROOT, "scripts");
const LOG_DIR = path.join(STUDIO_ROOT, "logs");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");

const RESOLUTION = "720p";
const resOf = (persona) => (persona.render_res === "480p" ? "480p" : RESOLUTION);
// A block is refunded and depends on the idea, so one fresh idea gets one more try.
const MAX_ATTEMPTS = 2;
const IDEA_TIMEOUT_MS = 6 * 60 * 1000;
const RENDER_TIMEOUT_MS = 45 * 60 * 1000; // generate_i2v polls for up to 40 min
// User's call (Nov 2026): refs of 15s or less are too rare in these clusters.
// Known risk: on Wan 3.0 Prime every ref of 23-30s so far returned "Generation failed"
// (kaylee, kepin-anatoly), while every ref of 15s or less rendered.
const CLUSTER_MAX_REF_S = 27;
// ingest + up to 3 refs x (screen + prompt + render)
const CLUSTER_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function masterDuration(persona) {
  const m = (persona.master_prompt || "").match(/^AUTO_DURATION:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d = new Date()) {
  return `${localDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const log = (msg) => console.error(`[${localTime()}] ${msg}`);

function ensureColumns(db) {
  const cols = db.prepare("PRAGMA table_info(personas)").all().map((c) => c.name);
  if (!cols.includes("daily_auto")) db.exec("ALTER TABLE personas ADD COLUMN daily_auto INTEGER DEFAULT 0");
  if (!cols.includes("daily_auto_last")) db.exec("ALTER TABLE personas ADD COLUMN daily_auto_last TEXT");
  if (!cols.includes("daily_auto_status")) db.exec("ALTER TABLE personas ADD COLUMN daily_auto_status TEXT");
}

function createIdea(personaId) {
  const r = spawnSync("node", [path.join(SCRIPTS, "generate_idea.mjs"), personaId], {
    encoding: "utf8",
    timeout: IDEA_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout.trim().split("\n").pop());
    return j.ok && j.video_id ? j : null;
  } catch {
    return null;
  }
}

function render(db, personaId, videoId, duration, res) {
  db.prepare("UPDATE videos SET stage='generating', gen_engine='seedance-2.5', gen_error=NULL, gen_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
    .run(videoId);
  const logFile = path.join(LOG_DIR, `gen_${personaId}_${videoId}_${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");
  const r = spawnSync("node", [path.join(SCRIPTS, "generate_i2v.mjs"), personaId, String(videoId), res, String(duration)], {
    timeout: RENDER_TIMEOUT_MS,
    stdio: ["ignore", out, out],
  });
  fs.closeSync(out);
  if (r.status === 0) return { ok: true };
  // Some generate_i2v exit paths and a timeout leave stage='generating'.
  db.prepare("UPDATE videos SET stage='shortlist', gen_error=COALESCE(gen_error, ?), updated_at=datetime('now') WHERE id=? AND stage='generating'")
    .run(`auto: generate gagal, lihat ${path.basename(logFile)}`, videoId);
  const row = db.prepare("SELECT gen_error FROM videos WHERE id=?").get(videoId);
  return { ok: false, error: row?.gen_error || "generate gagal" };
}

function runClusterPersona(db, persona, today, setStatus) {
  db.prepare("UPDATE personas SET daily_auto_last=? WHERE id=?").run(today, persona.id);
  const r = spawnSync("node", [path.join(SCRIPTS, "auto_generate.mjs"), persona.id, "1",
    "--res", resOf(persona), "--order", "date", "--fresh", "--max-dur", String(CLUSTER_MAX_REF_S)], {
    encoding: "utf8",
    timeout: CLUSTER_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let res = null;
  try { res = JSON.parse(r.stdout.trim().split("\n").pop()).results?.[0]; } catch {}
  if (r.status === 0 && res?.ok) setStatus(`OK, ref ${res.shortcode} (${res.engine}) masuk ${res.stage.toUpperCase()}`);
  else setStatus(`gagal: ${res?.reason || (r.error ? r.error.message : `exit ${r.status}`)}`);
}

function runPersona(db, persona, today) {
  const setStatus = (text) => {
    db.prepare("UPDATE personas SET daily_auto_status=? WHERE id=?").run(`${localTime()} ${text}`, persona.id);
    log(`${persona.id}: ${text}`);
  };
  if (persona.viral_cluster_slug) return runClusterPersona(db, persona, today, setStatus);

  const duration = masterDuration(persona);
  if (!duration) {
    setStatus("dilewati: master prompt belum ada baris AUTO_DURATION");
    return;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const idea = createIdea(persona.id);
    if (!idea) {
      setStatus("gagal bikin ide");
      return;
    }
    // Marked only once an idea exists, so a dead LLM doesn't burn today's slot.
    db.prepare("UPDATE personas SET daily_auto_last=? WHERE id=?").run(today, persona.id);
    log(`${persona.id}: ide ${idea.video_id} (percobaan ${attempt}/${MAX_ATTEMPTS}): ${idea.summary}`);

    const result = render(db, persona.id, idea.video_id, duration, resOf(persona));
    if (result.ok) {
      setStatus(`OK, video ${idea.video_id} masuk ${persona.skip_qc ? "HASIL" : "QC"}`);
      return;
    }
    const retryable = /safety/i.test(result.error) && attempt < MAX_ATTEMPTS;
    log(`${persona.id}: video ${idea.video_id} gagal: ${result.error}`);
    if (!retryable) {
      setStatus(`gagal video ${idea.video_id}: ${result.error.slice(0, 120)}`);
      return;
    }
  }
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA busy_timeout=5000");
  ensureColumns(db);
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const today = localDate();
  const personas = db.prepare(
    `SELECT * FROM personas
     WHERE daily_auto=1 AND COALESCE(archived,0)=0
       AND COALESCE(niche,'')!='freestyle'
       AND COALESCE(master_prompt,'')!=''
     ORDER BY id`
  ).all();
  const due = personas.filter((p) => p.daily_auto_last !== today);
  log(`${due.length} persona jalan hari ini (${personas.length} ON)`);

  if (dryRun) {
    for (const p of due) console.log(p.viral_cluster_slug
      ? `${p.id} cluster=${p.viral_cluster_slug} engine=${p.auto_engine || "auto"} ${resOf(p)} ref<=${CLUSTER_MAX_REF_S}s newest+velocity`
      : `${p.id} idea ${resOf(p)} ${masterDuration(p) ?? "NO AUTO_DURATION"}s`);
    return;
  }
  for (const p of due) runPersona(db, p, today);
  log("selesai");
}

main();
