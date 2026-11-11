import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

// POST /api/motion/[id]/generate -> spawn motion_generate.mjs detached.
// Uses the job's stored engine/resolution/prompt. REAL money — client must
// confirm first. Returns immediately; stage flips to generating then qc/ready.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id) as any;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (!job.prompt || job.prompt.trim().length < 50)
    return NextResponse.json({ error: "belum ada prompt (jalankan vision dulu)" }, { status: 400 });
  if (!job.local_ref) return NextResponse.json({ error: "belum ada video referensi" }, { status: 400 });

  const script = path.join(STUDIO_ROOT, "scripts", "motion_generate.mjs");
  const logDir = path.join(STUDIO_ROOT, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, `motion_${id}_${Date.now()}.log`), "a");

  const child = spawn("node", [script, String(id)], { detached: true, stdio: ["ignore", out, out] });
  child.unref();

  return NextResponse.json({ ok: true, status: "started", engine: job.engine, resolution: job.resolution });
}
