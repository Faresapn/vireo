#!/usr/bin/env node
/**
 * ViralEngine MCP client (JSON-RPC 2.0 over HTTP, streamable-http transport).
 *
 * Reads Bearer token from ~/.viralengine_token (never from argv/chat).
 * Usage:
 *   node mcp_client.mjs list                      -> tools/list (read-only)
 *   node mcp_client.mjs call <tool> '<jsonArgs>'  -> tools/call
 *
 * Does NOT auto-call any write tool. 'call' only runs what you pass explicitly.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MCP_URL = "https://backend-production-226f.up.railway.app/mcp/";
const TOKEN_FILE = path.join(os.homedir(), ".viralengine_token");

function token() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error(`Token file not found: ${TOKEN_FILE}`);
    console.error(`Buat dulu: printf 'TOKEN' > ${TOKEN_FILE} && chmod 600 ${TOKEN_FILE}`);
    process.exit(2);
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

let _id = 0;
function rpc(method, params) {
  return { jsonrpc: "2.0", id: ++_id, method, params };
}

async function post(body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    // MCP streamable-http requires accepting both json and SSE
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token()}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const sid = res.headers.get("mcp-session-id") || sessionId;
  const ctype = res.headers.get("content-type") || "";
  const raw = await res.text();

  let data = raw;
  if (ctype.includes("text/event-stream")) {
    // parse SSE: take the last `data:` line that is JSON
    const lines = raw.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    const last = lines.map((l) => l.slice(5).trim()).filter(Boolean).pop();
    data = last || raw;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = { _rawText: data };
  }
  return { status: res.status, sid, parsed, ctype };
}

async function handshake() {
  // 1. initialize
  const init = await post(
    rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "higgsfield-studio", version: "0.1.0" },
    })
  );
  if (init.status !== 200) {
    console.error("initialize failed:", init.status, JSON.stringify(init.parsed));
    process.exit(1);
  }
  const sid = init.sid;
  // 2. notifications/initialized (required by spec, no response expected)
  await post(rpc("notifications/initialized", {}), sid).catch(() => {});
  return { sid, serverInfo: init.parsed?.result?.serverInfo };
}

async function main() {
  const [, , cmd, toolName, argsJson] = process.argv;

  const { sid, serverInfo } = await handshake();
  if (serverInfo) console.error("Connected:", JSON.stringify(serverInfo));

  if (cmd === "list" || !cmd) {
    const r = await post(rpc("tools/list", {}), sid);
    const tools = r.parsed?.result?.tools || [];
    console.log(JSON.stringify(tools, null, 2));
    console.error(`\n${tools.length} tools.`);
    return;
  }

  if (cmd === "call") {
    if (!toolName) {
      console.error("Usage: call <tool> '<jsonArgs>'");
      process.exit(2);
    }
    let args = {};
    if (argsJson) {
      try {
        args = JSON.parse(argsJson);
      } catch (e) {
        console.error("Invalid JSON args:", e.message);
        process.exit(2);
      }
    }
    const r = await post(
      rpc("tools/call", { name: toolName, arguments: args }),
      sid
    );
    console.log(JSON.stringify(r.parsed, null, 2));
    return;
  }

  console.error("Unknown command:", cmd);
  process.exit(2);
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
