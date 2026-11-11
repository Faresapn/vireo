import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";

export const dynamic = "force-dynamic";

// POST /api/personas/[id]/recover  { video_id }
// Re-polls a render that timed out on our side (hf_request_id) and downloads it.
// Does not submit a new render.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { video_id: videoId } = await req.json();
  const video = db().prepare("SELECT id, hf_request_id, stage FROM videos WHERE id=? AND persona_id=?").get(videoId, id) as any;
  if (!video) return NextResponse.json({ error: "video not found" }, { status: 404 });
  if (!video.hf_request_id) return NextResponse.json({ error: "request_id tidak tersimpan untuk video ini" }, { status: 400 });
  if (video.stage === "generating") return NextResponse.json({ error: "video masih generating" }, { status: 409 });

  db().prepare("UPDATE videos SET stage='generating', gen_error=NULL, updated_at=datetime('now') WHERE id=?").run(videoId);
  const logDir = path.join(STUDIO_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `recover_${id}_${videoId}_${Date.now()}.log`), "a");
  const child = spawn("node", [path.join(STUDIO_ROOT, "scripts", "recover_render.mjs"), id, String(videoId)], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return NextResponse.json({ ok: true, status: "recovering", video_id: videoId });
}
