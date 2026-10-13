import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

// POST /api/personas/[id]/master-prompt
//  - multipart form with file=<pdf|txt>  OR
//  - JSON { text: "..." }
// Stores full master prompt template text on persona.master_prompt
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id);
  if (!persona)
    return NextResponse.json({ error: "persona not found" }, { status: 404 });

  const ctype = req.headers.get("content-type") || "";
  let text = "";

  try {
    if (ctype.includes("application/json")) {
      const body = await req.json();
      text = (body.text || "").trim();
    } else {
      const form = await req.formData();
      const file = form.get("file") as File | null;
      if (!file)
        return NextResponse.json({ error: "no file/text" }, { status: 400 });
      const buf = Buffer.from(await file.arrayBuffer());
      const ext = (path.extname(file.name) || "").toLowerCase();

      if (ext === ".pdf") {
        text = await extractPdf(buf);
      } else {
        text = buf.toString("utf8");
      }
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: "extract gagal: " + (e?.message || String(e)) },
      { status: 422 }
    );
  }

  text = (text || "").trim();
  if (!text)
    return NextResponse.json(
      { error: "hasil kosong — PDF mungkin berupa gambar (scan), coba paste teks manual" },
      { status: 422 }
    );

  // archive a copy under persona folder
  const mpdir = path.join(PERSONAS_DIR, id);
  fs.mkdirSync(mpdir, { recursive: true });
  fs.writeFileSync(path.join(mpdir, "master_prompt.txt"), text, "utf8");

  db()
    .prepare(
      "UPDATE personas SET master_prompt=?, updated_at=datetime('now') WHERE id=?"
    )
    .run(text, id);

  const slots = Array.from(new Set((text.match(/\[[^\]]+\]/g) || [])));

  return NextResponse.json({ ok: true, length: text.length, slots });
}

async function extractPdf(buf: Buffer): Promise<string> {
  // pure-JS extraction via unpdf (no native deps, no python)
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}
