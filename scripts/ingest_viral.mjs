#!/usr/bin/env node
/**
 * Ingest viral videos from ViralEngine MCP into the studio pipeline (INBOX).
 *
 * Usage:
 *   node ingest_viral.mjs <persona_id> [limit]
 *
 * Steps:
 *   1. read persona + its viral_cluster_slug from studio.db
 *   2. MCP list_instagram_signals(cluster=slug, order=velocity)
 *   3. for each item not already in DB: yt-dlp download -> personas/<id>/refs/
 *   4. ffprobe duration/resolution
 *   5. INSERT into videos (stage=inbox) with metrics
 *
 * Read-only toward MCP (no write tools). Safe to re-run (skips existing shortcodes).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const STUDIO_ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(STUDIO_ROOT, "db", "studio.db");
const PERSONAS_DIR = path.join(STUDIO_ROOT, "personas");
const MCP_URL = "https://backend-production-226f.up.railway.app/mcp/";
const TOKEN_FILE = path.join(os.homedir(), ".viralengine_token");

function token() {
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

let _id = 0;
async function mcpPost(body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token()}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id") || sessionId;
  const ctype = res.headers.get("content-type") || "";
  const raw = await res.text();
  let data = raw;
  if (ctype.includes("text/event-stream")) {
    const lines = raw.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    data = lines.map((l) => l.slice(5).trim()).filter(Boolean).pop() || raw;
  }
  try {
    return { sid, parsed: JSON.parse(data) };
  } catch {
    return { sid, parsed: { _raw: data } };
  }
}

async function mcpCall(tool, args) {
  const init = await mcpPost({
    jsonrpc: "2.0",
    id: ++_id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "higgsfield-ingest", version: "0.1.0" },
    },
  });
  const sid = init.sid;
  await mcpPost({ jsonrpc: "2.0", id: ++_id, method: "notifications/initialized", params: {} }, sid).catch(() => {});
  const r = await mcpPost({ jsonrpc: "2.0", id: ++_id, method: "tools/call", params: { name: tool, arguments: args } }, sid);
  return r.parsed;
}

function structured(parsed) {
  const res = parsed?.result;
  if (!res) return null;
  if (res.structuredContent) return res.structuredContent;
  // fallback: parse text content
  const txt = res.content?.find((c) => c.type === "text")?.text;
  if (txt) { try { return JSON.parse(txt); } catch {} }
  return res;
}

function ffprobe(file) {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0",
       "-show_entries", "stream=width,height",
       "-show_entries", "format=duration",
       "-of", "json", file],
      { encoding: "utf8" }
    );
    const j = JSON.parse(out);
    const s = j.streams?.[0] || {};
    const dur = parseFloat(j.format?.duration || "0");
    return { width: s.width || 0, height: s.height || 0, duration: dur };
  } catch {
    return { width: 0, height: 0, duration: 0 };
  }
}

async function main() {
  const personaId = process.argv[2];
  const limit = parseInt(process.argv[3] || "10", 10);
  if (!personaId) {
    console.error("Usage: node ingest_viral.mjs <persona_id> [limit]");
    process.exit(2);
  }

  const db = new DatabaseSync(DB_PATH);
  const persona = db.prepare("SELECT * FROM personas WHERE id=?").get(personaId);
  if (!persona) {
    console.error(`Persona '${personaId}' not found`);
    process.exit(1);
  }
  const slug = persona.viral_cluster_slug;
  if (!slug) {
    console.error(`Persona '${personaId}' belum punya viral_cluster_slug`);
    process.exit(1);
  }

  console.error(`Persona: ${persona.name} | cluster: ${slug} | limit: ${limit}`);
  const parsed = await mcpCall("list_instagram_signals", {
    cluster: slug,
    order: "velocity",
    limit,
  });
  const sc = structured(parsed);
  const cluster = sc?.clusters?.[0];
  if (!cluster) {
    console.error("No cluster data:", JSON.stringify(sc).slice(0, 300));
    process.exit(1);
  }
  const items = cluster.items || [];
  console.error(`Got ${items.length} items from cluster (total=${cluster.total})\n`);

  // RAG: learn from past OK decisions in this niche to rank incoming refs.
  // Refs with duration closer to the avg winning duration get prioritized.
  const persona2 = db.prepare("SELECT niche FROM personas WHERE id=?").get(personaId);
  const okStats = db.prepare(
    `SELECT AVG(duration_s) AS avg_dur, COUNT(*) AS n
     FROM decisions WHERE niche=? AND verdict='ok' AND duration_s IS NOT NULL`
  ).get(persona2?.niche || "");
  const avgOkDur = okStats?.n >= 3 ? okStats.avg_dur : null; // need >=3 samples
  if (avgOkDur) {
    console.error(`RAG: niche '${persona2.niche}' prefers ~${avgOkDur.toFixed(0)}s refs (from ${okStats.n} OK). Re-ranking.\n`);
    const maxVph = Math.max(...items.map((it) => it.views_per_hour || 0), 1);
    const score = (it) => {
      const vphNorm = (it.views_per_hour || 0) / maxVph; // 0..1 velocity
      const durDist = Math.abs((it.duration_s || it.duration || 15) - avgOkDur);
      const durPenalty = Math.min(durDist / 15, 1); // 0..1, closer=better
      return vphNorm * 0.6 + (1 - durPenalty) * 0.4; // weighted blend
    };
    items.sort((a, b) => score(b) - score(a));
  }

  const refsDir = path.join(PERSONAS_DIR, personaId, "refs");
  fs.mkdirSync(refsDir, { recursive: true });

  const existing = new Set(
    db.prepare("SELECT shortcode FROM videos WHERE persona_id=? AND shortcode IS NOT NULL")
      .all(personaId).map((r) => r.shortcode)
  );

  const ins = db.prepare(`
    INSERT INTO videos
      (persona_id, stage, source_url, local_ref, duration_s, shortcode, views, views_per_hour, caption, creator)
    VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let added = 0, skipped = 0, failed = 0;
  for (const it of items) {
    const sc2 = it.shortcode;
    if (!sc2 || existing.has(sc2)) { skipped++; continue; }
    const url = it.url;
    const dest = path.join(refsDir, `${slug}_${sc2}.mp4`);
    try {
      execFileSync("yt-dlp", ["--no-playlist", "-f", "b[ext=mp4]/mp4/best",
        "-o", dest, url], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      console.error(`  ✗ ${sc2} download gagal (private/blocked)`);
      failed++;
      continue;
    }
    if (!fs.existsSync(dest)) { failed++; continue; }

    // normalize: if not h264 or no audio, transcode to h264+aac (Seedance/Genjutsu safe)
    try {
      const probe = JSON.parse(execFileSync("ffprobe", [
        "-v", "error", "-show_entries", "stream=codec_type,codec_name",
        "-of", "json", dest,
      ], { encoding: "utf8" }));
      const vcodec = probe.streams?.find((s) => s.codec_type === "video")?.codec_name;
      const hasAudio = probe.streams?.some((s) => s.codec_type === "audio");
      if (vcodec !== "h264" || !hasAudio) {
        const tmp = dest.replace(/\.mp4$/, "_h264.mp4");
        execFileSync("ffmpeg", [
          "-y", "-i", dest,
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
          "-map", "0:v", "-map", "1:a",
          tmp,
        ], { stdio: "pipe" });
        fs.renameSync(tmp, dest);
        console.error(`  ↻ ${sc2} transcoded ${vcodec}→h264`);
      }
    } catch (e) {
      console.error(`  ⚠ ${sc2} transcode gagal, pakai asli: ${e.message.slice(0, 80)}`);
    }

    const pr = ffprobe(dest);
    const relRef = path.join("refs", `${slug}_${sc2}.mp4`);
    ins.run(personaId, url, relRef, pr.duration, sc2,
      it.views || null, it.views_per_hour || null,
      (it.caption || "").slice(0, 500), it.creator || null);
    added++;
    console.error(`  ✓ ${sc2} ${pr.width}x${pr.height} ${pr.duration.toFixed(1)}s views=${it.views}`);
  }

  console.error(`\nDone: +${added} added, ${skipped} skipped (dup), ${failed} failed.`);
  console.log(JSON.stringify({ persona: personaId, cluster: slug, added, skipped, failed }));
}

main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
