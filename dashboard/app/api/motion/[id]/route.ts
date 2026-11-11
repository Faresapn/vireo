import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const MOTION_DIR = path.join(STUDIO_ROOT, "motion");

// GET /api/motion/[id] -> job + its images
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id) as any;
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const images = db()
    .prepare("SELECT id, rel_path, ord, label, width, height FROM motion_images WHERE job_id=? ORDER BY ord ASC, id ASC")
    .all(id);
  return NextResponse.json({ ...job, images });
}

// PATCH /api/motion/[id] -> update editable fields
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const allowed = ["title", "main_char", "engine", "resolution", "prompt", "stage", "gen_audio", "saved_persona"];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      // validate enums
      if (k === "engine" && !["wan-prime", "seedance-2.5", "genjutsu"].includes(body[k])) continue;
      if (k === "resolution" && !["480p", "720p", "1080p"].includes(body[k])) continue;
      sets.push(`${k}=?`);
      vals.push(k === "gen_audio" ? (body[k] ? 1 : 0) : body[k]);
    }
  }
  if (!sets.length) return NextResponse.json({ error: "no fields" }, { status: 400 });
  sets.push("updated_at=datetime('now')");
  vals.push(id);
  db().prepare(`UPDATE motion_jobs SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  return NextResponse.json(db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id));
}

// DELETE /api/motion/[id] -> remove job + its files
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    fs.rmSync(path.join(MOTION_DIR, String(id)), { recursive: true, force: true });
  } catch {}
  db().prepare("DELETE FROM motion_jobs WHERE id=?").run(id); // cascade deletes images
  return NextResponse.json({ ok: true });
}
