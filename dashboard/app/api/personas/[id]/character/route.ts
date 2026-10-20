import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export const dynamic = "force-dynamic";

const MAX_IMAGES = 8;

// GET -> list character images for persona
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const rows = db()
    .prepare(
      "SELECT id, rel_path, width, height, ord, char_group FROM character_images WHERE persona_id=? ORDER BY ord ASC, id ASC"
    )
    .all(id);
  return NextResponse.json(rows);
}

// POST (multipart file=<image>) -> append one image (up to MAX_IMAGES)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id) as any;
  if (!persona)
    return NextResponse.json({ error: "persona not found" }, { status: 404 });

  const count = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM character_images WHERE persona_id=?")
      .get(id) as any
  ).n as number;
  if (count >= MAX_IMAGES)
    return NextResponse.json(
      { error: `maksimal ${MAX_IMAGES} foto per persona` },
      { status: 400 }
    );

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
  // char_group: 1 or 2 (for duo personas). Defaults to 1.
  const charGroup = (form.get("char_group") as string) === "2" ? 2 : 1;

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = (path.extname(file.name) || ".jpg").toLowerCase();
  const safeExt = [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
  const idx = count + 1;
  const fname = `character_${idx}${safeExt}`;
  const chardir = path.join(PERSONAS_DIR, id, "char");
  fs.mkdirSync(chardir, { recursive: true });
  const dest = path.join(chardir, fname);
  fs.writeFileSync(dest, buf);

  let width = 0,
    height = 0;
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        dest,
      ],
      { encoding: "utf8" }
    ).trim();
    const [w, h] = out.split(",").map((n) => parseInt(n, 10));
    width = w || 0;
    height = h || 0;
  } catch {}

  const relPath = path.join("char", fname);
  db()
    .prepare(
      "INSERT INTO character_images (persona_id, rel_path, width, height, ord, char_group) VALUES (?,?,?,?,?,?)"
    )
    .run(id, relPath, width, height, count, charGroup);

  // keep personas.character_img pointing at the FIRST image (avatar)
  if (count === 0) {
    db()
      .prepare(
        "UPDATE personas SET character_img=?, updated_at=datetime('now') WHERE id=?"
      )
      .run(relPath, id);
  }

  const warn =
    width && width < 768
      ? `Resolusi rendah (${width}x${height}). Disarankan >=1024 biar wajah gak morph.`
      : null;

  return NextResponse.json({
    ok: true,
    rel_path: relPath,
    width,
    height,
    count: count + 1,
    warn,
  });
}

// DELETE ?img=<id> -> remove one character image
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const imgId = req.nextUrl.searchParams.get("img");
  if (!imgId) return NextResponse.json({ error: "img id wajib" }, { status: 400 });

  const row = db()
    .prepare("SELECT * FROM character_images WHERE id=? AND persona_id=?")
    .get(imgId, id) as any;
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // delete file (best-effort)
  try {
    fs.unlinkSync(path.join(PERSONAS_DIR, id, row.rel_path));
  } catch {}
  db().prepare("DELETE FROM character_images WHERE id=?").run(imgId);

  // fix avatar pointer: set to the new first image (or null)
  const first = db()
    .prepare(
      "SELECT rel_path FROM character_images WHERE persona_id=? ORDER BY ord ASC, id ASC LIMIT 1"
    )
    .get(id) as any;
  db()
    .prepare(
      "UPDATE personas SET character_img=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(first ? first.rel_path : null, id);

  return NextResponse.json({ ok: true });
}
