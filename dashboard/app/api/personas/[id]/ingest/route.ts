import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import { execFile } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/personas/[id]/ingest  { limit? }
// Runs scripts/ingest_viral.mjs for this persona (MCP -> yt-dlp -> INBOX).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id) as any;
  if (!persona)
    return NextResponse.json({ error: "persona not found" }, { status: 404 });
  if (!persona.viral_cluster_slug)
    return NextResponse.json(
      { error: "persona belum punya viral_cluster_slug" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(Math.max(parseInt(body.limit || "8", 10), 1), 20);
  const script = path.join(STUDIO_ROOT, "scripts", "ingest_viral.mjs");

  return new Promise<Response>((resolve) => {
    execFile(
      "node",
      [script, id, String(limit)],
      { timeout: 280_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          resolve(
            NextResponse.json(
              { error: "ingest gagal", detail: (stderr || err.message).slice(-500) },
              { status: 500 }
            )
          );
          return;
        }
        let result: any = { raw: stdout.trim() };
        try {
          const lastLine = stdout.trim().split("\n").pop() || "{}";
          result = JSON.parse(lastLine);
        } catch {}
        resolve(NextResponse.json({ ok: true, ...result, log: stderr.slice(-800) }));
      }
    );
  });
}
