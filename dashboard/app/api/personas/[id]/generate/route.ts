import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";

export const dynamic = "force-dynamic";

// POST /api/personas/[id]/generate  { video_id, engine?, resolution?, prompt? }
// Fire-and-forget: spawns generate.mjs detached, returns immediately.
// The script updates videos.stage to 'qc' on success (or we revert via marker).
// Dashboard polls /videos to see stage change.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const videoId = body.video_id;
  const VALID_ENGINES = ["genjutsu", "seedance", "seedance-2.5", "wan", "wan-prime"];
  const engine = VALID_ENGINES.includes(body.engine) ? body.engine : "seedance";
  const resolution = ["480p", "720p", "1080p"].includes(body.resolution) ? body.resolution : "480p";

  if (!videoId) return NextResponse.json({ error: "video_id wajib" }, { status: 400 });
  const video = db().prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, id) as any;
  if (!video) return NextResponse.json({ error: "video not found" }, { status: 404 });

  // save prompt (optional) + mark generating + clear any prior error
  if (body.prompt && body.prompt.trim()) {
    db().prepare("UPDATE videos SET prompt_used=?, stage='generating', gen_engine=?, gen_error=NULL, gen_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(body.prompt.trim(), engine, videoId);
  } else {
    db().prepare("UPDATE videos SET stage='generating', gen_engine=?, gen_error=NULL, gen_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(engine, videoId);
  }

  // spawn detached — do NOT await. Script writes result to DB + a log file.
  const script = path.join(STUDIO_ROOT, "scripts", "generate.mjs");
  const logDir = path.join(STUDIO_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `gen_${id}_${videoId}_${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");

  const child = spawn("node", [script, id, String(videoId), engine, resolution], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  return NextResponse.json({
    ok: true,
    status: "started",
    video_id: videoId,
    engine,
    resolution,
    message: "Generate jalan di background. Pantau stage di dashboard.",
  });
}
