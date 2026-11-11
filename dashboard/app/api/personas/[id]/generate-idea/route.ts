import { NextRequest, NextResponse } from "next/server";
import { db, STUDIO_ROOT } from "@/lib/db";
import path from "path";
import { execFile } from "child_process";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/personas/[id]/generate-idea
// Idea-only personas (no viral cluster): invent ONE fresh, non-duplicate prompt
// idea from the persona's master_prompt. Does NOT touch Higgsfield (no cost) —
// it only creates an editable draft (videos row, stage='shortlist') + stores the
// idea embedding for future dedup. The UI shows the draft prompt editable, then
// the user hits generate (seedance-i2v) separately.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const persona = db().prepare("SELECT * FROM personas WHERE id=?").get(id) as any;
  if (!persona)
    return NextResponse.json({ error: "persona not found" }, { status: 404 });
  if (!persona.master_prompt || !persona.master_prompt.trim())
    return NextResponse.json(
      { error: "persona belum punya master prompt — isi dulu" },
      { status: 400 }
    );

  const script = path.join(STUDIO_ROOT, "scripts", "generate_idea.mjs");
  return new Promise<Response>((resolve) => {
    execFile(
      "node",
      [script, id],
      { timeout: 290_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          resolve(
            NextResponse.json(
              { error: "generate idea gagal", detail: (stderr || err.message).slice(-500) },
              { status: 500 }
            )
          );
          return;
        }
        let result: any = {};
        try {
          const lastLine = stdout.trim().split("\n").pop() || "{}";
          result = JSON.parse(lastLine);
        } catch {
          resolve(
            NextResponse.json(
              { error: "output tidak terbaca", detail: stdout.slice(-300) },
              { status: 500 }
            )
          );
          return;
        }
        resolve(NextResponse.json({ ok: true, ...result, log: stderr.slice(-400) }));
      }
    );
  });
}
