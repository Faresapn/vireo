#!/usr/bin/env python3
"""
Local embedding daemon for idea-only dedup (bge-small-en-v1.5, 384-dim).

Runs as a tiny HTTP server on 127.0.0.1 so the model loads ONCE and stays
warm — per-request embedding is then ~10ms instead of the ~9s cold load.

Endpoints (POST, JSON):
  /embed   { "texts": ["..."] }        -> { "vectors": [[...384 floats...]] }
  /health                               -> { "ok": true, "dim": 384 }

Fully local/offline. No credentials, no network calls after the model is cached.
Isolation (per-persona) is enforced by the CALLER (generate_idea.mjs filters
candidate vectors by persona_id) — this server only turns text into vectors.

Start (managed by launchd ai.vireo.embed; port fixed 4330):
  ./.venv-embed/bin/python3 scripts/embed_server.py
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("EMBED_PORT", "4330"))
MODEL_NAME = "BAAI/bge-small-en-v1.5"

# Lazy singleton — loaded once at startup.
_model = None


def get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(MODEL_NAME)
    return _model


def embed_texts(texts):
    m = get_model()
    # fastembed returns numpy arrays; convert to plain lists for JSON.
    return [v.tolist() for v in m.embed(texts)]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # quiet

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "dim": 384, "model": MODEL_NAME})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(n) or b"{}")
            texts = payload.get("texts") or []
            if not isinstance(texts, list) or not texts:
                self._send(400, {"error": "texts (non-empty list) required"})
                return
            texts = [str(t) for t in texts]
            self._send(200, {"vectors": embed_texts(texts)})
        except Exception as e:
            self._send(500, {"error": str(e)[:300]})


def main():
    # Warm the model before accepting traffic so the first real request is fast.
    get_model()
    sys.stderr.write(f"embed_server ready on 127.0.0.1:{PORT} ({MODEL_NAME})\n")
    sys.stderr.flush()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
