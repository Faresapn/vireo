import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

const MAX_VOICES = 3;

// audio_ref stored as JSON array of rel paths. Tolerant to a legacy single string.
function parseRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v;
  } catch {}
  return [raw]; // legacy single path
}

// GET -> { audio_mode, voices: [relPath,...] }
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const p = db().prepare("SELECT audio_mode, audio_ref FROM personas WHERE id=?").get(id) as any;
  if (!p) return NextResponse.json({ error: "persona not found" }, { status: 404 });
  return NextResponse.json({ audio_mode: p.audio_mode || "auto", voices: parseRefs(p.audio_ref) });
}

// POST (multipart file=<audio>) -> append one voice (up to MAX_VOICES)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id) as any;
  if (!persona) return NextResponse.json({ error: "persona not found" }, { status: 404 });

  const voices = parseRefs(persona.audio_ref);
  if (voices.length >= MAX_VOICES)
    return NextResponse.json({ error: `maksimal ${MAX_VOICES} suara` }, { status: 400 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = (path.extname(file.name) || ".mp3").toLowerCase();
  const safeExt = [".mp3", ".wav", ".m4a", ".aac", ".ogg"].includes(ext) ? ext : ".mp3";
  const chardir = path.join(PERSONAS_DIR, id, "char");
  fs.mkdirSync(chardir, { recursive: true });
  const idx = voices.length + 1;
  const fname = `voice_${idx}${safeExt}`;
  fs.writeFileSync(path.join(chardir, fname), buf);

  const relPath = path.join("char", fname);
  const next = [...voices, relPath];
  db()
    .prepare("UPDATE personas SET audio_ref=?, audio_mode='ref', updated_at=datetime('now') WHERE id=?")
    .run(JSON.stringify(next), id);

  return NextResponse.json({ ok: true, voices: next });
}

// DELETE ?idx=<n> (1-based) -> remove one voice; no idx -> clear all
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT audio_ref FROM personas WHERE id=?").get(id) as any;
  const voices = parseRefs(persona?.audio_ref);
  const idxParam = req.nextUrl.searchParams.get("idx");

  if (idxParam) {
    const i = parseInt(idxParam, 10) - 1;
    if (i >= 0 && i < voices.length) {
      try { fs.unlinkSync(path.join(PERSONAS_DIR, id, voices[i])); } catch {}
      voices.splice(i, 1);
    }
    db().prepare("UPDATE personas SET audio_ref=? WHERE id=?").run(voices.length ? JSON.stringify(voices) : null, id);
  } else {
    for (const v of voices) { try { fs.unlinkSync(path.join(PERSONAS_DIR, id, v)); } catch {} }
    db().prepare("UPDATE personas SET audio_ref=NULL WHERE id=?").run(id);
  }
  return NextResponse.json({ ok: true, voices: parseRefs((db().prepare("SELECT audio_ref FROM personas WHERE id=?").get(id) as any)?.audio_ref) });
}
