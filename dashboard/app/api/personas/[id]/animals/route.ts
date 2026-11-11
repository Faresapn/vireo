import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

export const dynamic = "force-dynamic";

const MAX_ANIMALS = 60;
const SAFE_EXT = [".jpg", ".jpeg", ".png", ".webp"];

function animalsDir(personaId: string) {
  return path.join(PERSONAS_DIR, personaId, "animals");
}

// GET -> list animal pool images (rel_path under personas/<id>/)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const dir = animalsDir(id);
  if (!fs.existsSync(dir)) return NextResponse.json({ animals: [] });
  const files = fs
    .readdirSync(dir)
    .filter((f) => SAFE_EXT.includes(path.extname(f).toLowerCase()))
    .sort();
  return NextResponse.json({
    animals: files.map((f) => ({ name: f, rel_path: path.join("animals", f) })),
  });
}

// POST (multipart file=<image>) -> add one animal to the pool
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT id FROM personas WHERE id=?").get(id) as any;
  if (!persona)
    return NextResponse.json({ error: "persona not found" }, { status: 404 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  const dir = animalsDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const existing = fs
    .readdirSync(dir)
    .filter((f) => SAFE_EXT.includes(path.extname(f).toLowerCase()));
  if (existing.length >= MAX_ANIMALS)
    return NextResponse.json(
      { error: `maksimal ${MAX_ANIMALS} animal` },
      { status: 400 }
    );

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = (path.extname(file.name) || ".jpg").toLowerCase();
  const safeExt = SAFE_EXT.includes(ext) ? ext : ".jpg";
  // keep original basename (sanitized) so the user recognizes the animal;
  // de-dupe by appending a counter if it already exists.
  const base = (path.basename(file.name, path.extname(file.name)) || "animal")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 40) || "animal";
  let fname = `${base}${safeExt}`;
  let n = 1;
  while (fs.existsSync(path.join(dir, fname))) {
    fname = `${base}_${n}${safeExt}`;
    n++;
  }
  const dest = path.join(dir, fname);
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
    const [w, h] = out.split(",").map((x) => parseInt(x, 10));
    width = w || 0;
    height = h || 0;
  } catch {}

  const warn =
    width && width < 768
      ? `Resolusi rendah (${width}x${height}). Disarankan >=1024 biar hewan gak morph.`
      : null;

  return NextResponse.json({
    ok: true,
    name: fname,
    rel_path: path.join("animals", fname),
    width,
    height,
    count: existing.length + 1,
    warn,
  });
}

// DELETE ?name=<filename> -> remove one animal from the pool
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name wajib" }, { status: 400 });
  // guard: filename only, no path traversal
  if (name.includes("/") || name.includes("..") || path.isAbsolute(name))
    return NextResponse.json({ error: "invalid name" }, { status: 400 });

  const target = path.join(animalsDir(id), name);
  if (!fs.existsSync(target))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    fs.unlinkSync(target);
  } catch {}
  return NextResponse.json({ ok: true });
}
