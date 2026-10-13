import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import { spawn } from "child_process";
import fs from "fs";

export const dynamic = "force-dynamic";

// POST /api/personas/[id]/auto  { count? }
// Fires the AUTO orchestrator (auto_generate.mjs) detached. One-button full pipeline.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let count = 1;
  try {
    const body = await req.json();
    count = Math.max(1, Math.min(10, parseInt(body.count || "1", 10)));
  } catch {}

  const persona = db().prepare("SELECT id FROM personas WHERE id=?").get(id);
  if (!persona) return NextResponse.json({ error: "persona not found" }, { status: 404 });

  const script = path.join(STUDIO_ROOT, "scripts", "auto_generate.mjs");
  const logDir = path.join(STUDIO_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `auto_${id}_${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");

  const child = spawn("node", [script, id, String(count)], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  return NextResponse.json({
    ok: true,
    status: "started",
    count,
    message: `AUTO pipeline jalan untuk ${count} video. Pantau di pipeline board.`,
    log: path.basename(logFile),
  });
}
