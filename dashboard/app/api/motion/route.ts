import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/motion -> list all motion jobs (newest first)
export async function GET() {
  const rows = db()
    .prepare(
      `SELECT j.*, (SELECT COUNT(*) FROM motion_images WHERE job_id=j.id) AS img_count
       FROM motion_jobs j ORDER BY j.created_at DESC, j.id DESC`
    )
    .all();
  return NextResponse.json({ jobs: rows });
}

// POST /api/motion -> create a new draft job
//   { title?, main_char?, engine?, resolution? }
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const engine = ["wan-prime", "seedance-2.5", "genjutsu"].includes(body.engine) ? body.engine : "wan-prime";
  const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "720p";
  const r = db()
    .prepare(
      `INSERT INTO motion_jobs (title, main_char, engine, resolution, stage)
       VALUES (?,?,?,?, 'draft')`
    )
    .run(body.title || "Motion job", body.main_char || null, engine, resolution);
  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(r.lastInsertRowid);
  return NextResponse.json(job);
}
