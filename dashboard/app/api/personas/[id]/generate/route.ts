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
  const VALID_ENGINES = ["genjutsu", "genjutsu-light", "seedance", "seedance-2.5", "wan", "wan-prime"];
  const engine = VALID_ENGINES.includes(body.engine) ? body.engine : "seedance";
  // Resolution comes from the persona (render_res, e.g. 480p for Denvo/Kaylee), default 720p,
  // whatever the client sends.
  const personaRes = (db().prepare("SELECT render_res FROM personas WHERE id=?").get(id) as any)?.render_res;
  const resolution = personaRes === "480p" ? "480p" : "720p";
  const story = !!body.story;                        // story-variation mode
  const variation = (body.variation || "").toString().trim(); // optional text (e.g. "ayam jadi bebek")

  if (!videoId) return NextResponse.json({ error: "video_id wajib" }, { status: 400 });
  const video = db().prepare("SELECT * FROM videos WHERE id=? AND persona_id=?").get(videoId, id) as any;
  if (!video) return NextResponse.json({ error: "video not found" }, { status: 404 });
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id) as any;

  // Prompt handling (REVERTED to pre-story logic for Ikut Ref — that was perfect):
  //  - story: clear prompt_used, build_prompt --story rewrites it (vary content)
  //  - else (Ikut Ref / custom): save custom prompt if given, else leave prompt_used
  //    as-is; generate.mjs uses video.prompt_used || master_prompt. NO build_prompt
  //    chaining here — matches the original working Animal flow.
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
  // Idea-only persona (NO viral cluster): reference-to-video WITHOUT a motion ref
  // video — just the character image + the user-edited idea prompt + forced 9:16.
  // No build_prompt chaining. generate_i2v.mjs handles it. Fixed Seedance 2.5.
  const isIdeaOnly = !persona?.viral_cluster_slug;
  if (isIdeaOnly) {
    const i2vScript = path.join(STUDIO_ROOT, "scripts", "generate_i2v.mjs");
    const picked = Number(body.duration);
    // Some idea-only personas have a FIXED-timeline master prompt (e.g.
    // mp-kepin-animal's chase→mock needs the SNAP at second 13 + hold 13–15s).
    // For those, lock the duration so a short pick can't clip the ending.
    const FIXED_DUR: Record<string, number> = { "mp-kepin-animal": 15 };
    const i2vDur = FIXED_DUR[id] ?? ([4, 5, 10, 15, 20, 25, 30].includes(picked) ? picked : 5);
    const cmd = `node ${JSON.stringify(i2vScript)} ${JSON.stringify(id)} ${JSON.stringify(String(videoId))} ${JSON.stringify(resolution)} ${JSON.stringify(String(i2vDur))}`;
    child = spawn("bash", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
  } else if (story) {
    // Story mode: duration = user pick if valid, else RANDOM 12-18s.
    const picked = Number(body.duration);
    const storyDur = [5, 10, 15, 20, 25, 30].includes(picked) ? picked : (12 + Math.floor(Math.random() * 7)); // 12..18
    // chain: build_prompt --story [variation]  &&  generate.mjs ... <duration>
    const args = [promptScript, id, String(videoId), "--story"];
    if (variation) args.push(variation);
    const cmd = `node ${args.map((a) => JSON.stringify(a)).join(" ")} && node ${JSON.stringify(genScript)} ${JSON.stringify(id)} ${JSON.stringify(String(videoId))} ${JSON.stringify(engine)} ${JSON.stringify(resolution)} ${JSON.stringify(String(storyDur))}`;
    child = spawn("bash", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
  } else {
    // Ikut Ref: build_prompt (plain, vision fills the master [SLOTS]) THEN generate.
    // This is how Animal got a matured prompt — raw master template alone fails transfer.
    const cmd = `node ${JSON.stringify(promptScript)} ${JSON.stringify(id)} ${JSON.stringify(String(videoId))} && node ${JSON.stringify(genScript)} ${JSON.stringify(id)} ${JSON.stringify(String(videoId))} ${JSON.stringify(engine)} ${JSON.stringify(resolution)}`;
    child = spawn("bash", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
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
