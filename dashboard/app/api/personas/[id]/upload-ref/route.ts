import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/personas/[id]/upload-ref  (multipart: file=<video mp4/mov>)
// Manual reference upload — lets you drop your OWN video into INBOX instead of
// pulling from ViralEngine. Only for personas WITH a cluster (not idea-only).
// Saves to personas/<id>/refs/, probes duration, inserts a videos row (stage=inbox).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id) as any;
  if (!persona)
    return NextResponse.json({ error: "persona not found" }, { status: 404 });
  // Idea-only personas (no cluster) don't use ref videos — block upload there.
  if (!persona.viral_cluster_slug)
    return NextResponse.json(
      { error: "persona mode ide murni — gak pakai reference video" },
      { status: 400 }
    );

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  const ext = (path.extname(file.name || "").toLowerCase() || ".mp4").replace(/[^a-z0-9.]/g, "");
  const safeExt = [".mp4", ".mov", ".webm", ".m4v"].includes(ext) ? ext : ".mp4";
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length < 1000)
    return NextResponse.json({ error: "file terlalu kecil / rusak" }, { status: 400 });

  // Unique shortcode so it never collides with MCP-pulled ones.
  const shortcode = `up${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const relPath = path.join("refs", `${persona.viral_cluster_slug || id}_${shortcode}${safeExt}`);
  const refsDir = path.join(PERSONAS_DIR, id, "refs");
  fs.mkdirSync(refsDir, { recursive: true });
  const dest = path.join(PERSONAS_DIR, id, relPath);
  fs.writeFileSync(dest, buf);

  // Probe duration (best-effort).
  let duration = 0;
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dest],
      { encoding: "utf8" }
    ).trim();
    duration = parseFloat(out) || 0;
  } catch {}

  const info = db()
    .prepare(
      `INSERT INTO videos
        (persona_id, stage, source_url, local_ref, duration_s, shortcode, caption, creator, ingested_at)
       VALUES (?, 'inbox', ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(id, "manual-upload", relPath, duration, shortcode, "(upload manual)", "manual");

  return NextResponse.json({
    ok: true,
    video_id: Number(info.lastInsertRowid),
    shortcode,
    duration_s: duration,
    local_ref: relPath,
  });
}
