"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";

type QCItem = {
  id: number;
  persona_id: string;
  persona_name: string;
  niche: string;
  platform: string;
  stage: "qc" | "done";
  shortcode: string | null;
  duration_s: number | null;
  resolution: string;
  engine: string;
  media: string | null;
  when: string | null;
  views: number | null;
  views_per_hour: number | null;
};

function toLocalDate(s: string | null): Date | null {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export default function QCPage() {
  const [items, setItems] = useState<QCItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/qc-feed", { cache: "no-store" });
    const d = await r.json();
    // Only videos still awaiting QC. Approved ones (done) drop off the tab.
    setItems((d.items || []).filter((x: QCItem) => x.stage === "qc"));
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function approve(it: QCItem) {
    setBusy(it.id);
    await fetch(`/api/personas/${it.persona_id}/videos`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: it.id, stage: "done" }),
    });
    // approved → remove from the tab immediately
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    setBusy(null);
  }

  // group by niche; only niches that currently have QC video.
  // newest-generated first within each niche.
  const groups = useMemo(() => {
    const m = new Map<string, QCItem[]>();
    for (const it of items) {
      const k = it.niche || "lainnya";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(it);
    }
    for (const list of m.values()) {
      list.sort((a, b) => {
        const da = toLocalDate(a.when)?.getTime() || 0;
        const db = toLocalDate(b.when)?.getTime() || 0;
        return db - da;
      });
    }
    return [...m.entries()];
  }, [items]);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-6">
      {/* header */}
      <div className="mb-5">
        <div className="eyebrow">Quality Control</div>
        <h1 className="display mt-1 text-[22px] font-bold text-ink">
          QC · Review Video
        </h1>
        <div className="mt-1 text-[11px] text-faint">
          Semua video dari seluruh niche yang nunggu QC. OK → langsung jadi HASIL
          &amp; ilang dari sini.
        </div>
      </div>

      {loading ? (
        <div className="card py-16 text-center text-sm text-mute">Memuat…</div>
      ) : items.length === 0 ? (
        <div className="card py-16 text-center text-sm text-mute">
          Gak ada video yang nunggu QC. Semua udah kelar 🎉
        </div>
      ) : (
        <div className="space-y-7">
          {groups.map(([niche, list]) => (
            <div key={niche}>
              <div className="mb-2.5 flex items-center gap-2">
                <span className="rounded-md bg-accent/15 px-2.5 py-1 text-[12px] font-bold uppercase tracking-wide text-accent-soft">
                  {niche}
                </span>
                <span className="text-[11px] text-faint">{list.length} nunggu QC</span>
              </div>
              {/* horizontal scroll row */}
              <div className="flex gap-4 overflow-x-auto pb-3">
                {list.map((it) => (
                  <div key={it.id} className="w-[260px] shrink-0">
                    <QCCard it={it} busy={busy === it.id} onApprove={() => approve(it)} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const SPEEDS = [0.25, 0.5, 1];

function QCCard({ it, busy, onApprove }: { it: QCItem; busy: boolean; onApprove: () => void }) {
  const vref = useRef<HTMLVideoElement>(null);
  const [speed, setSpeed] = useState(1);

  function setRate(r: number) {
    setSpeed(r);
    if (vref.current) vref.current.playbackRate = r;
  }

  const timeStr = (() => {
    const d = toLocalDate(it.when);
    if (!d) return "—";
    return d.toLocaleString("id-ID", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  })();

  return (
    <div className="card overflow-hidden">
      {/* badge row */}
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="rounded-md bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-soft">
          {it.niche}
        </span>
        <span className="rounded-md bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#241a07]">
          QC
        </span>
      </div>

      {/* video */}
      <div className="relative mt-2 aspect-[9/16] bg-void">
        {it.media ? (
          <video
            ref={vref}
            src={it.media}
            className="h-full w-full object-contain"
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).playbackRate = speed; }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-faint">
            no media
          </div>
        )}
        {/* speed control overlay */}
        <div className="absolute left-2 top-2 flex gap-1 rounded-lg bg-black/60 p-0.5 backdrop-blur">
          {SPEEDS.map((r) => (
            <button
              key={r}
              onClick={() => setRate(r)}
              className={`rounded px-1.5 py-0.5 text-[9px] font-semibold transition ${
                speed === r ? "bg-accent text-[#241a07]" : "text-white/70 hover:text-white"
              }`}
            >
              {r}×
            </button>
          ))}
        </div>
      </div>

      {/* meta */}
      <div className="space-y-1.5 px-3 py-3 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="text-faint">Niche</span>
          <span className="font-medium text-sub">{it.persona_name}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-faint">Generate</span>
          <span className="font-medium text-sub">{timeStr}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-faint">Engine</span>
          <span className="font-medium text-sub">{it.engine}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-faint">Resolusi</span>
          <span className="font-medium text-accent-soft">{it.resolution}</span>
        </div>
        {it.duration_s ? (
          <div className="flex items-center justify-between">
            <span className="text-faint">Durasi</span>
            <span className="font-medium text-sub">{Math.round(it.duration_s)}s</span>
          </div>
        ) : null}
      </div>

      {/* action */}
      <div className="px-3 pb-3">
        <button
          onClick={onApprove}
          disabled={busy}
          className="btn btn-accent w-full px-2 py-1.5 text-[11px] disabled:opacity-40"
        >
          {busy ? "…" : "OK ✓ jadikan HASIL"}
        </button>
      </div>
    </div>
  );
}
