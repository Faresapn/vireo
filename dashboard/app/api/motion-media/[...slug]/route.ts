import { NextRequest, NextResponse } from "next/server";
import { STUDIO_ROOT } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const MOTION_DIR = path.join(STUDIO_ROOT, "motion");

// GET /api/motion-media/<job_id>/<...path> -> serve files under motion/<job_id>/
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const rel = slug.join("/");
  const target = path.resolve(MOTION_DIR, rel);
  if (!target.startsWith(path.resolve(MOTION_DIR))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const buf = fs.readFileSync(target);
  const ext = path.extname(target).toLowerCase();
  const mime: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".mp4": "video/mp4",
  };
  return new NextResponse(buf, {
    headers: {
      "Content-Type": mime[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
