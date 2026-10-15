import { NextRequest, NextResponse } from "next/server";
import { db, PERSONAS_DIR, STUDIO_ROOT } from "@/lib/db";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";

export const dynamic = "force-dynamic";

// fire-and-forget: create the Drive folder tree for a new niche
function initDriveFolders(slug: string) {
  const script = path.join(STUDIO_ROOT, "scripts", "drive_init_niche.sh");
  if (!fs.existsSync(script)) return;
  execFile("bash", [script, slug], { timeout: 60_000 }, (err) => {
    if (err) console.error(`drive_init_niche(${slug}) failed:`, err.message);
    else console.error(`drive folders ready for ${slug}`);
  });
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// GET /api/personas  -> list (non-archived first)
export async function GET() {
  const rows = db()
    .prepare(
      `SELECT p.*,
        (SELECT COUNT(*) FROM videos v WHERE v.persona_id = p.id AND v.stage='inbox')     AS cnt_inbox,
        (SELECT COUNT(*) FROM videos v WHERE v.persona_id = p.id AND v.stage='shortlist') AS cnt_shortlist,
        (SELECT COUNT(*) FROM videos v WHERE v.persona_id = p.id AND v.stage IN ('approved','generating')) AS cnt_gen,
        (SELECT COUNT(*) FROM videos v WHERE v.persona_id = p.id AND v.stage='qc')        AS cnt_qc,
        (SELECT COUNT(*) FROM videos v WHERE v.persona_id = p.id AND v.stage='done')      AS cnt_done
       FROM personas p
       ORDER BY p.archived ASC, p.created_at DESC`
    )
    .all();
  return NextResponse.json(rows);
}

// POST /api/personas  -> create { name, niche, platform?, aspect? }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const name = (body.name || "").trim();
  const niche = (body.niche || "").trim();
  if (!name || !niche) {
    return NextResponse.json({ error: "name & niche wajib" }, { status: 400 });
  }
  let id = slugify(name);
  const exists = db().prepare("SELECT 1 FROM personas WHERE id=?").get(id);
  if (exists) id = `${id}-${Date.now().toString(36).slice(-4)}`;

  // scaffold persona folders
  const pdir = path.join(PERSONAS_DIR, id);
  for (const sub of ["char", "refs", "temp", "output"]) {
    fs.mkdirSync(path.join(pdir, sub), { recursive: true });
  }

  db()
    .prepare(
      `INSERT INTO personas (id, name, niche, platform, aspect, viral_source, viral_cluster_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      name,
      niche,
      body.platform || "instagram",
      body.aspect || "9:16",
      body.viral_source || null,
      body.viral_cluster_slug || null
    );

  const row = db().prepare("SELECT * FROM personas WHERE id=?").get(id);

  // auto-create Drive folder tree for this niche (fire-and-forget)
  initDriveFolders(id);

  return NextResponse.json(row, { status: 201 });
}
