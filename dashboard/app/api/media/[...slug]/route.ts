import { NextRequest, NextResponse } from "next/server";
import { PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// GET /api/media/<persona>/<...path>  -> serve files under personas/<persona>/
// safe: resolves and verifies the path stays inside PERSONAS_DIR
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const rel = slug.join("/");
  const target = path.resolve(PERSONAS_DIR, rel);
  if (!target.startsWith(path.resolve(PERSONAS_DIR))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const buf = fs.readFileSync(target);
  const ext = path.extname(target).toLowerCase();
  const mime: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".txt": "text/plain; charset=utf-8",
  };
  return new NextResponse(buf, {
    headers: {
      "Content-Type": mime[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
