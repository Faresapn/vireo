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

  const body = await req.json().catch(() => ({}));
  // Free-mode personas (niche='freestyle') can ingest from ANY cluster via
  // body.cluster override. Locked personas use their own viral_cluster_slug.
  const clusterOverride = typeof body.cluster === "string" ? body.cluster.trim() : "";
  const effSlug = clusterOverride || persona.viral_cluster_slug;
  if (!effSlug)
    return NextResponse.json(
      { error: "persona belum punya viral_cluster_slug (pilih cluster dulu)" },
      { status: 400 }
    );

  const limit = Math.min(Math.max(parseInt(body.limit || "8", 10), 1), 20);
  // Sort order: "velocity" (paling rame, default) | "date" (paling baru).
  const order = body.order === "date" ? "date" : "velocity";
  const script = path.join(STUDIO_ROOT, "scripts", "ingest_viral.mjs");
  // argv: [personaId, limit, offset, cluster, order]. Empty offset = auto-paging.
  // cluster slot always present (empty string falls back to persona's own slug)
  // so `order` lands at the correct argv position.
  const args = [script, id, String(limit), "", clusterOverride, order];

  return new Promise<Response>((resolve) => {
    execFile(
      "node",
      args,
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
