#!/usr/bin/env node
/**
 * refresh_inbox.mjs — keep INBOX fresh for all set-up personas.
 *
 * For every persona that has a viral_cluster_slug (i.e. is wired to MCP):
 *   1. DELETE inbox items older than TTL hours (by ingested_at) + their ref files.
 *      ONLY stage='inbox' is touched — shortlist/generating/qc/done are NEVER deleted.
 *   2. Re-ingest fresh refs from MCP via ingest_viral.mjs.
 *
 * Designed to run from cron with NO LLM (no_agent). Prints a short summary.
 *
 * Usage: node refresh_inbox.mjs [ttl_hours]   (default 12)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const TTL_HOURS = parseInt(process.argv[2] || "12", 10);
const INGEST_LIMIT = 8;

const db = new DatabaseSync(DB_PATH);

// Personas wired to MCP (have a cluster) and not archived.
const personas = db.prepare(
  "SELECT id, name, viral_cluster_slug FROM personas WHERE viral_cluster_slug IS NOT NULL AND viral_cluster_slug != '' AND COALESCE(archived,0)=0"
).all();

let totalDeleted = 0, totalAdded = 0;
const lines = [];

for (const p of personas) {
  // 1. Find stale INBOX items (by ingested_at). ONLY inbox — never touch picked refs.
  const stale = db.prepare(
    `SELECT id, local_ref FROM videos
     WHERE persona_id=? AND stage='inbox'
       AND ingested_at IS NOT NULL
       AND ingested_at <= datetime('now', ?)`
  ).all(p.id, `-${TTL_HOURS} hours`);

  for (const v of stale) {
    if (v.local_ref) {
      const f = path.join(PERSONAS_DIR, p.id, v.local_ref);
      try { fs.unlinkSync(f); } catch {}
    }
    db.prepare("DELETE FROM videos WHERE id=?").run(v.id);
  }
  totalDeleted += stale.length;

  // 2. Re-ingest fresh from MCP (ingest_viral handles dedup + auto-offset).
  let added = 0;
  try {
    const out = execFileSync("node", [path.join(STUDIO_ROOT, "scripts", "ingest_viral.mjs"), p.id, String(INGEST_LIMIT)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240000,
    });
    const last = out.trim().split("\n").pop() || "{}";
    try { added = (JSON.parse(last).added) || 0; } catch {}
  } catch (e) {
    lines.push(`${p.name}: ingest error ${(e.message || "").slice(0, 60)}`);
    continue;
  }
  totalAdded += added;
  if (stale.length || added) lines.push(`${p.name}: -${stale.length} stale, +${added} fresh`);
}

// Quiet when nothing happened (so a cron with delivery stays silent on no-op).
if (totalDeleted === 0 && totalAdded === 0) {
  process.exit(0);
}
console.log(`INBOX refresh (TTL ${TTL_HOURS}h): ${personas.length} persona, -${totalDeleted} basi, +${totalAdded} fresh`);
for (const l of lines) console.log("  " + l);
