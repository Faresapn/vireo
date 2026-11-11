import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const MOTION_DIR = path.join(STUDIO_ROOT, "motion");

// POST /api/motion/[id]/save  { persona_id }
// On QC OK: copy the generated output into the chosen persona's videos as a
// finished (stage=done) entry, so it shows up in that persona + global QC/HASIL.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const personaId = (body.persona_id || "").toString().trim();
  if (!personaId) return NextResponse.json({ error: "persona_id wajib" }, { status: 400 });

  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id) as any;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (!job.output_path) return NextResponse.json({ error: "job belum ada output" }, { status: 400 });

  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(personaId) as any;
  if (!persona) return NextResponse.json({ error: "persona not found" }, { status: 404 });

  const src = path.join(MOTION_DIR, String(id), job.output_path);
  if (!fs.existsSync(src)) return NextResponse.json({ error: "output file missing" }, { status: 404 });

  // copy into personas/<persona>/output/<res>/
  const res = job.resolution || "720p";
  const outDir = path.join(PERSONAS_DIR, personaId, "output", res);
  fs.mkdirSync(outDir, { recursive: true });
  const outName = `motion_${id}_${res}.mp4`;
  fs.copyFileSync(src, path.join(outDir, outName));
  const relOut = path.join("output", res, outName);
  const col = res === "480p" ? "output_480" : "output_1080";

  const r = db().prepare(
    `INSERT INTO videos (persona_id, stage, shortcode, prompt_used, gen_engine, duration_s, ${col}, gen_started_at)
     VALUES (?, 'done', ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    personaId,
    job.ref_shortcode || `motion${id}`,
    (job.prompt || "").slice(0, 2000),
    job.engine,
    job.duration_s || null,
    relOut
  );

  db().prepare("UPDATE motion_jobs SET stage='done', saved_persona=?, updated_at=datetime('now') WHERE id=?")
    .run(personaId, id);

  return NextResponse.json({ ok: true, persona_id: personaId, video_id: r.lastInsertRowid });
}
