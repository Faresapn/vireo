import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export const dynamic = "force-dynamic";

const MOTION_DIR = path.join(STUDIO_ROOT, "motion");
const MAX_IMAGES = 8;

// POST /api/motion/[id]/image  (multipart file=<image>, label?)
//   ord auto-assigned (0 = Image 1 = main character).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = db().prepare("SELECT * FROM motion_jobs WHERE id=?").get(id) as any;
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const count = (db().prepare("SELECT COUNT(*) AS n FROM motion_images WHERE job_id=?").get(id) as any).n as number;
  if (count >= MAX_IMAGES)
    return NextResponse.json({ error: `maksimal ${MAX_IMAGES} gambar` }, { status: 400 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
  const label = (form.get("label") as string) || null;

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = (path.extname(file.name) || ".jpg").toLowerCase();
  const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
  const idx = count + 1;
  const imgDir = path.join(MOTION_DIR, String(id), "img");
  fs.mkdirSync(imgDir, { recursive: true });
  const fname = `image_${idx}${safeExt}`;
  const dest = path.join(imgDir, fname);
  fs.writeFileSync(dest, buf);

  let width = 0, height = 0;
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", dest], { encoding: "utf8" }).trim();
    const [w, h] = out.split(",").map((n) => parseInt(n, 10));
    width = w || 0; height = h || 0;
  } catch {}

  const relPath = path.join("img", fname);
  db().prepare(
    "INSERT INTO motion_images (job_id, rel_path, ord, label, width, height) VALUES (?,?,?,?,?,?)"
  ).run(id, relPath, count, label, width, height);

  const warn = width && width < 768 ? `Resolusi rendah (${width}x${height}). Disarankan >=1024.` : null;
  return NextResponse.json({ ok: true, rel_path: relPath, ord: count, count: count + 1, warn });
}

// DELETE /api/motion/[id]/image?img=<imgId>
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const imgId = req.nextUrl.searchParams.get("img");
  if (!imgId) return NextResponse.json({ error: "img id wajib" }, { status: 400 });
  const row = db().prepare("SELECT * FROM motion_images WHERE id=? AND job_id=?").get(imgId, id) as any;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  try { fs.unlinkSync(path.join(MOTION_DIR, String(id), row.rel_path)); } catch {}
  db().prepare("DELETE FROM motion_images WHERE id=?").run(imgId);
  // re-pack ord so Image numbering stays contiguous (0-based)
  const rest = db().prepare("SELECT id FROM motion_images WHERE job_id=? ORDER BY ord ASC, id ASC").all(id) as any[];
  rest.forEach((r, i) => db().prepare("UPDATE motion_images SET ord=? WHERE id=?").run(i, r.id));
  return NextResponse.json({ ok: true });
}
