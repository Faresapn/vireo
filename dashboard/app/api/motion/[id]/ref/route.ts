import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import fs from "fs";
import path from "path";
import { execFile, execFileSync } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MOTION_DIR = path.join(STUDIO_ROOT, "motion");

function probeDuration(file: string): number {
  try {
    return parseFloat(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim()
    ) || 0;
  } catch { return 0; }
}

// POST /api/motion/[id]/ref
//  - multipart file=<video>              (manual upload)
//  - OR JSON { cluster, shortcode? }      (pull from viral via yt-dlp-less path)
// For viral: we reuse mcp_client to get a URL then yt-dlp download.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id) as any;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const jobDir = path.join(MOTION_DIR, String(id));
  fs.mkdirSync(jobDir, { recursive: true });
  const ctype = req.headers.get("content-type") || "";

  // ---- manual file upload ----
  if (ctype.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    const dest = path.join(jobDir, "ref.mp4");
    fs.writeFileSync(dest, buf);
    const dur = probeDuration(dest);
    db().prepare(
      "UPDATE motion_jobs SET ref_source='manual', ref_cluster=NULL, ref_shortcode=NULL, local_ref='ref.mp4', duration_s=?, updated_at=datetime('now') WHERE id=?"
    ).run(dur, id);
    return NextResponse.json({ ok: true, source: "manual", duration_s: dur });
  }

  // ---- viral: download by direct source_url (passed from client after it picks) ----
  const body = await req.json().catch(() => ({}));
  const url = (body.source_url || "").toString().trim();
  const shortcode = (body.shortcode || "").toString().trim();
  const cluster = (body.cluster || "").toString().trim();
  if (!url) return NextResponse.json({ error: "source_url wajib untuk viral" }, { status: 400 });

  const dest = path.join(jobDir, "ref.mp4");
  return new Promise<Response>((resolve) => {
    execFile(
      "yt-dlp",
      ["-f", "mp4/best", "-o", dest, url],
      { timeout: 120000 },
      (err) => {
        if (err || !fs.existsSync(dest)) {
          resolve(NextResponse.json({ error: "download gagal", detail: String(err).slice(-300) }, { status: 500 }));
          return;
        }
        const dur = probeDuration(dest);
        db().prepare(
          "UPDATE motion_jobs SET ref_source='viral', ref_cluster=?, ref_shortcode=?, local_ref='ref.mp4', duration_s=?, updated_at=datetime('now') WHERE id=?"
        ).run(cluster || null, shortcode || null, dur, id);
        resolve(NextResponse.json({ ok: true, source: "viral", duration_s: dur }));
      }
    );
  });
}
