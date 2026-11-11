import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import { execFile } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/motion/[id]/prompt -> run motion_prompt.mjs (vision writes timeline).
// Synchronous: returns the authored prompt when done.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id) as any;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  if (!job.local_ref) return NextResponse.json({ error: "upload video referensi dulu" }, { status: 400 });
  const imgN = (db().prepare("SELECT COUNT(*) AS n FROM motion_images WHERE job_id=?").get(id) as any).n;
  if (!imgN) return NextResponse.json({ error: "upload minimal 1 gambar karakter dulu" }, { status: 400 });

  const script = path.join(STUDIO_ROOT, "scripts", "motion_prompt.mjs");
  return new Promise<Response>((resolve) => {
    execFile("node", [script, String(id)], { timeout: 280000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        resolve(NextResponse.json({ error: "prompt gagal", detail: (stderr || String(err)).slice(-500) }, { status: 500 }));
        return;
      }
      const prompt = stdout.trim();
      resolve(NextResponse.json({ ok: true, prompt, log: stderr.slice(-400) }));
    });
  });
}
