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
  const story = !!body.story;                        // story-variation mode
  const variation = (body.variation || "").toString().trim(); // optional text (e.g. "ayam jadi bebek")

  if (!videoId) return NextResponse.json({ error: "video_id wajib" }, { status: 400 });
  const video = db().prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, id) as any;
  if (!video) return NextResponse.json({ error: "video not found" }, { status: 404 });

  // Story mode rebuilds the prompt (vary content, keep motion) before generating,
  // so clear any saved prompt_used and let build_prompt --story regenerate it.
  if (story) {
    db().prepare("UPDATE videos SET prompt_used=NULL, stage='generating', gen_engine=?, gen_error=NULL, gen_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(engine, videoId);
  } else if (body.prompt && body.prompt.trim()) {
    db().prepare("UPDATE videos SET prompt_used=?, stage='generating', gen_engine=?, gen_error=NULL, gen_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(body.prompt.trim(), engine, videoId);
  } else {
    db().prepare("UPDATE videos SET stage='generating', gen_engine=?, gen_error=NULL, gen_started_at=datetime('now'), updated_at=datetime('now') WHERE id=?")
      .run(engine, videoId);
  }

  const genScript = path.join(STUDIO_ROOT, "scripts", "generate.mjs");
  const promptScript = path.join(STUDIO_ROOT, "scripts", "build_prompt.mjs");
  const logDir = path.join(STUDIO_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `gen_${id}_${videoId}_${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");

  let child;
  if (story) {
    // chain: build_prompt --story [variation]  &&  generate.mjs
    const args = [promptScript, id, String(videoId), "--story"];
    if (variation) args.push(variation);
    const cmd = `node ${args.map((a) => JSON.stringify(a)).join(" ")} && node ${JSON.stringify(genScript)} ${JSON.stringify(id)} ${JSON.stringify(String(videoId))} ${JSON.stringify(engine)} ${JSON.stringify(resolution)}`;
    child = spawn("bash", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
  } else {
    child = spawn("node", [genScript, id, String(videoId), engine, resolution], {
      detached: true,
      stdio: ["ignore", out, out],
    });
  }
  child.unref();

  return NextResponse.json({
    ok: true,
    status: "started",
    video_id: videoId,
    engine,
    resolution,
    mode: story ? "story" : "ikut-ref",
    message: "Generate jalan di background. Pantau stage di dashboard.",
  });
}
