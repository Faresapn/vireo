// Proxy to the Go backend (backend-go/, launchd ai.vireo.backend-go on
// 127.0.0.1:4320). Returns null when the Go service is unreachable so the
// caller can fall back to its original Node implementation — the dashboard
// keeps working even if the Go process is down.
const GO_URL = process.env.GO_BACKEND_URL || "http://127.0.0.1:4320";

export async function viaGo(req: Request, pathWithQuery: string): Promise<Response | null> {
  if (process.env.GO_BACKEND === "off") return null;
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const r = await fetch(GO_URL + pathWithQuery, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: hasBody ? await req.clone().text() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    return new Response(r.body, {
      status: r.status,
      headers: { "Content-Type": r.headers.get("content-type") || "application/json", "X-Backend": "go" },
    });
  } catch {
    return null;
  }
}
