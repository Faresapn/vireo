import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

// GET /api/personas/[id]/videos?stage=inbox
// Lists videos for a persona, optionally filtered by stage, ordered by velocity.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const stage = req.nextUrl.searchParams.get("stage");
  const where = stage ? "persona_id=? AND stage=?" : "persona_id=?";
  const args = stage ? [id, stage] : [id];
  const rows = db()
    .prepare(
      `SELECT id, stage, source_url, local_ref, duration_s, face_count, cut_count,
              ref_score, ref_notes, shortcode, views, views_per_hour, caption, creator,
              prompt_used, hf_request_id, output_480, output_1080, qc_status, qc_notes,
              gen_engine, gen_error, gen_started_at, created_at
       FROM videos WHERE ${where}
       ORDER BY COALESCE(views_per_hour,0) DESC, id DESC`
    )
    .all(...args);
  return NextResponse.json(rows);
}

// PATCH /api/personas/[id]/videos  { video_id, stage?, qc_status?, qc_notes? }
// Move a video between stages or set QC verdict.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const vid = body.video_id;
  if (!vid) return NextResponse.json({ error: "video_id wajib" }, { status: 400 });

  const allowed = ["stage", "qc_status", "qc_notes", "ref_score", "ref_notes"];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k}=?`);
      vals.push(body[k]);
    }
  }
  if (!sets.length)
    return NextResponse.json({ error: "no fields" }, { status: 400 });
  sets.push("updated_at=datetime('now')");
  vals.push(vid, id);
  db()
    .prepare(`UPDATE videos SET ${sets.join(", ")} WHERE id=? AND persona_id=?`)
    .run(...vals);
  const row = db().prepare("SELECT * FROM videos WHERE id=?").get(vid) as any;

  // RAG: log a decision when a QC verdict is cast.
  // Triggered when moving to 'done' (OK) or when qc_status is explicitly set.
  const verdict =
    body.qc_status ||
    (body.stage === "done" ? "ok" : body.stage === "inbox" ? "ulang" : null);
  if (verdict && ["ok", "revisi", "ulang"].includes(verdict) && row) {
    const persona = db().prepare("SELECT niche FROM personas WHERE id=?").get(id) as any;
    // first_try = 1 if this video has no prior decision rows
    const prior = db()
      .prepare("SELECT COUNT(*) AS n FROM decisions WHERE video_id=?")
      .get(vid) as any;
    db()
      .prepare(
        `INSERT INTO decisions
          (persona_id, niche, video_id, shortcode, engine, resolution,
           duration_s, views, views_per_hour, caption, creator, prompt,
           verdict, qc_notes, first_try)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        persona?.niche || "",
        row.id,
        row.shortcode || null,
        row.gen_engine || null,
        row.output_1080 ? "1080p" : "480p",
        row.duration_s || null,
        row.views || null,
        row.views_per_hour || null,
        (row.caption || "").slice(0, 300),
        row.creator || null,
        (row.prompt_used || "").slice(0, 2000),
        verdict,
        body.qc_notes || null,
        prior.n === 0 ? 1 : 0
      );
  }

  // Auto-archive to Drive when video reaches 'done' (fire-and-forget)
  if (body.stage === "done" && row) {
    const script = path.join(STUDIO_ROOT, "scripts", "drive_archive.mjs");
    if (fs.existsSync(script)) {
      const child = spawn("node", [script, id, String(vid)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  }

  return NextResponse.json(row);
}
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const vid = req.nextUrl.searchParams.get("video_id");
  if (!vid) return NextResponse.json({ error: "video_id wajib" }, { status: 400 });
  db().prepare("DELETE FROM videos WHERE id=? AND persona_id=?").run(vid, id);
  return NextResponse.json({ ok: true });
}
