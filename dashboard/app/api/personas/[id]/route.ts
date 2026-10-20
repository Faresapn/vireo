import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// GET /api/personas/[id] -> single persona
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const row = db().prepare("SELECT * FROM personas WHERE id=?").get(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

// PATCH /api/personas/[id] -> update fields { master_prompt?, viral_source?, aspect?, platform?, archived? }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const allowed = [
    "name",
    "niche",
    "platform",
    "aspect",
    "master_prompt",
    "viral_source",
    "viral_cluster_slug",
    "auto_engine",
    "auto_instruction",
    "archived",
  ];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k}=?`);
      vals.push(body[k]);
    }
  }
  if (!sets.length)
    return NextResponse.json({ error: "no fields" }, { status: 400 });
  sets.push("updated_at=datetime('now')");
  vals.push(id);
  db()
    .prepare(`UPDATE personas SET ${sets.join(", ")} WHERE id=?`)
    .run(...vals);
  const row = db().prepare("SELECT * FROM personas WHERE id=?").get(id);
  return NextResponse.json(row);
}

// DELETE /api/personas/[id] -> remove persona + its videos + character rows.
// Files on disk (personas/<id>/) are left intact as a safety net.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const d = db();
  d.prepare("DELETE FROM videos WHERE persona_id=?").run(id);
  try { d.prepare("DELETE FROM character_images WHERE persona_id=?").run(id); } catch {}
  try { d.prepare("DELETE FROM decisions WHERE niche=(SELECT niche FROM personas WHERE id=?)").run(id); } catch {}
  d.prepare("DELETE FROM personas WHERE id=?").run(id);
  return NextResponse.json({ ok: true });
}
