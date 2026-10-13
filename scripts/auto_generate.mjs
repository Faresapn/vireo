#!/usr/bin/env node
/**
 * AUTO orchestrator — one-button full pipeline, no human touch.
 *
 * Usage: node auto_generate.mjs <persona_id> [count]
 *
 * For each of `count` videos (default 1):
 *   1. ensure INBOX has refs (ingest from MCP if empty)
 *   2. pick best ref (velocity + RAG duration-fit score) from INBOX
 *   3. build prompt via opus-4.8 vision (build_prompt.mjs) + persona auto_instruction
 *   4. pick engine (rule: predator refs -> seedance; else RAG best_engine or seedance)
 *   5. generate (generate.mjs) at chosen resolution
 *   6. QC: if RAG says niche is proven (first_try OK >=95%, >=30 samples) -> auto-done,
 *          else leave in 'qc' for manual review
 *   7. archive to Drive on done
 *
 * Everything runs headless. Logs progress to stderr, final JSON to stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPTS = path.join(STUDIO_ROOT, "scripts");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");

function run(script, args, timeoutMs = 780000) {
  return execFileSync("node", [path.join(SCRIPTS, script), ...args], {
    encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "inherit"],
  });
}

// predator keywords -> force seedance (genjutsu NSFW-flags big predators)
const PREDATOR = /lion|tiger|singa|harimau|bear|beruang|wolf|serigala|leopard|cheetah|panther|jaguar/i;

function pickEngine(db, niche, caption) {
  if (PREDATOR.test(caption || "")) return "seedance";
  // RAG best engine for this niche
  const row = db.prepare(
    `SELECT engine, SUM(CASE WHEN verdict='ok' THEN 1 ELSE 0 END)*1.0/COUNT(*) AS rate, COUNT(*) n
     FROM decisions WHERE niche=? AND engine IS NOT NULL GROUP BY engine ORDER BY rate DESC, n DESC LIMIT 1`
  ).get(niche);
  return row?.engine || "seedance";
}

function pickRef(db, personaId, niche, tried = new Set()) {
  const inbox = db.prepare(
    "SELECT * FROM videos WHERE persona_id=? AND stage='inbox'"
  ).all(personaId).filter((v) => !tried.has(v.id));
  if (!inbox.length) return null;

  // Pre-screen candidates with vision (skip ones already screened).
  // Screen up to 15 top-velocity candidates to find a viable one.
  const byVel = inbox.slice().sort((a, b) => (b.views_per_hour || 0) - (a.views_per_hour || 0)).slice(0, 15);
  for (const v of byVel) {
    if (v.ref_score == null) {
      try {
        const out = execFileSync("node", [path.join(SCRIPTS, "screen_ref.mjs"), personaId, String(v.id)], { encoding: "utf8", timeout: 90000, stdio: ["ignore", "pipe", "inherit"] });
        const r = JSON.parse(out.trim());
        v.ref_score = r.score;
        console.error(`  screen ${v.shortcode}: ${r.score} (${r.verdict}) — ${r.reason}`);
      } catch (e) {
        v.ref_score = 50; // neutral fallback if vision fails
        console.error(`  screen ${v.shortcode}: failed, neutral 50`);
      }
    }
  }

  // RAG: avg duration of OK decisions in this niche
  const ok = db.prepare(
    "SELECT AVG(duration_s) avg_dur, COUNT(*) n FROM decisions WHERE niche=? AND verdict='ok' AND duration_s IS NOT NULL"
  ).get(niche);
  const avgDur = ok?.n >= 3 ? ok.avg_dur : 12;
  const maxVph = Math.max(...byVel.map((v) => v.views_per_hour || 0), 1);
  const score = (v) => {
    const refFit = (v.ref_score ?? 50) / 100;          // 0..1 vision suitability (DOMINANT)
    const vph = (v.views_per_hour || 0) / maxVph;      // 0..1 velocity
    const durPen = Math.min(Math.abs((v.duration_s || 12) - avgDur) / 15, 1);
    const durFit = 4 <= (v.duration_s || 0) && (v.duration_s || 0) <= 15 ? 1 : 0.5;
    return refFit * 0.55 + vph * 0.25 + (1 - durPen) * 0.1 + durFit * 0.1;
  };
  // only consider screened candidates with score >= 45 (avoid bad refs).
  // If NONE are viable, return null — do NOT force-pick a bad ref (wastes credits).
  const viable = byVel.filter((v) => (v.ref_score ?? 50) >= 45);
  if (!viable.length) return null;
  return viable.slice().sort((a, b) => score(b) - score(a))[0];
}

function ragAutoDone(db, niche) {
  const r = db.prepare(
    `SELECT SUM(CASE WHEN verdict='ok' AND first_try=1 THEN 1 ELSE 0 END) ok1,
            SUM(CASE WHEN first_try=1 THEN 1 ELSE 0 END) tries
     FROM decisions WHERE niche=?`
  ).get(niche);
  const rate = r?.tries ? r.ok1 / r.tries : 0;
  return { auto: r?.tries >= 30 && rate >= 0.95, rate, samples: r?.tries || 0 };
}

async function main() {
  const [, , personaId, countArg] = process.argv;
  const count = Math.max(1, parseInt(countArg || "1", 10));
  if (!personaId) { console.error("Usage: node auto_generate.mjs <persona_id> [count]"); process.exit(2); }

  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  if (!persona) { console.error("persona not found"); process.exit(1); }
  const niche = persona.niche;
  const results = [];

  for (let i = 0; i < count; i++) {
    console.error(`\n===== AUTO video ${i + 1}/${count} =====`);

    // 1. ensure inbox
    let inboxN = db.prepare("SELECT COUNT(*) n FROM videos WHERE persona_id=? AND stage='inbox'").get(personaId).n;
    if (inboxN === 0) {
      console.error("INBOX kosong, ingest dari MCP…");
      try { run("ingest_viral.mjs", [personaId, "8"], 300000); } catch (e) { console.error("ingest gagal:", e.message); }
    }

    // retry up to 3 different refs (refs get blocked by nsfw/copyright sometimes)
    let done = false;
    const tried = new Set();
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      // 2. pick ref (excluding already-tried ones this run)
      const ref = pickRef(db, personaId, niche, tried);
      if (!ref) { console.error("tidak ada ref viable di INBOX"); results.push({ ok: false, reason: "no ref" }); break; }
      tried.add(ref.id);
      console.error(`[attempt ${attempt + 1}] Ref: ${ref.shortcode} (${ref.duration_s?.toFixed(0)}s, score ${ref.ref_score}, ${Math.round(ref.views_per_hour || 0)}/h)`);
      db.prepare("UPDATE videos SET stage='shortlist', updated_at=datetime('now') WHERE id=?").run(ref.id);

      // 3. build prompt
      const instr = (persona.auto_instruction || "").trim();
      console.error("Build prompt (opus-4.8 vision)…");
      try { run("build_prompt.mjs", instr ? [personaId, String(ref.id), instr] : [personaId, String(ref.id)], 120000); }
      catch (e) { console.error("build_prompt gagal:", e.message); continue; }

      // 4. pick engine
      const engine = pickEngine(db, niche, ref.caption);
      console.error(`Engine: ${engine}`);

      // 5. resolution via RAG
      const rag = ragAutoDone(db, niche);
      const resolution = rag.auto ? "1080p" : "480p";
      console.error(`Resolution: ${resolution} (RAG first-try ${(rag.rate * 100).toFixed(0)}%, ${rag.samples} samples)`);

      // 6. generate
      try { run("generate.mjs", [personaId, String(ref.id), engine, resolution]); }
      catch (e) {
        console.error(`generate gagal (${ref.shortcode}), coba ref lain…`);
        // mark this ref so pickRef won't re-pick it (blocked)
        db.prepare("UPDATE videos SET stage='inbox', ref_score=20, updated_at=datetime('now') WHERE id=? AND COALESCE(ref_score,50)>20").run(ref.id);
        db.prepare("UPDATE videos SET stage='inbox', updated_at=datetime('now') WHERE id=?").run(ref.id);
        continue;
      }

      // 7. QC / auto-done
      if (rag.auto) {
        db.prepare("UPDATE videos SET stage='done', qc_status='ok', updated_at=datetime('now') WHERE id=?").run(ref.id);
        try { run("drive_archive.mjs", [personaId, String(ref.id)], 180000); } catch {}
        console.error("AUTO-DONE (RAG proven) + archived to Drive");
        results.push({ ok: true, shortcode: ref.shortcode, engine, resolution, stage: "done" });
      } else {
        console.error("Masuk QC (nunggu review manual)");
        results.push({ ok: true, shortcode: ref.shortcode, engine, resolution, stage: "qc" });
      }
      done = true;
    }
    if (!done) results.push({ ok: false, reason: "all refs blocked/failed after 3 tries" });
  }

  console.log(JSON.stringify({ ok: true, persona: personaId, count, results }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
