"use client";

import { useEffect, useState, useCallback } from "react";

type Persona = {
  id: string;
  name: string;
  niche: string;
  platform: string;
  aspect: string;
  master_prompt: string | null;
  character_img: string | null;
  viral_source: string | null;
  archived: number;
  cnt_inbox: number;
  cnt_shortlist: number;
  cnt_gen: number;
  cnt_qc: number;
  cnt_done: number;
};

export default function Home() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const r = await fetch("/api/personas", { cache: "no-store" });
    const data = await r.json();
    setPersonas(data);
    setLoading(false);
    if (!activeId && data.length) setActiveId(data[0].id);
  }, [activeId]);

  useEffect(() => {
    load();
  }, [load]);

  const active = personas.find((p) => p.id === activeId) || null;

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {/* ===== Sidebar ===== */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-edge bg-panel">
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
          <div>
            <div className="text-[11px] font-mono tracking-[0.2em] text-mute">
              HIGGSFIELD
            </div>
            <div className="text-sm font-semibold tracking-wide text-ink">
              STUDIO
            </div>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-edge text-indigo-soft hover:border-indigo hover:bg-indigo/10 transition"
            title="Tambah niche"
          >
            +
          </button>
        </div>

        <div className="px-4 pt-3 pb-1 text-[10px] font-mono tracking-widest text-mute">
          PERSONAS
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {loading && (
            <div className="px-3 py-6 text-xs text-mute">Loading…</div>
          )}
          {!loading && personas.length === 0 && (
            <div className="px-3 py-6 text-xs text-mute leading-relaxed">
              Belum ada persona. Klik{" "}
              <span className="text-indigo-soft">+</span> buat tambah niche
              pertama.
            </div>
          )}
          {personas
            .filter((p) => !p.archived)
            .map((p) => (
              <button
                key={p.id}
                onClick={() => setActiveId(p.id)}
                className={`group mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition ${
                  activeId === p.id
                    ? "bg-indigo/15 glow-indigo"
                    : "hover:bg-edge/60"
                }`}
              >
                <Avatar persona={p} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">
                    {p.name}
                  </div>
                  <div className="truncate text-[11px] text-mute">
                    {p.niche}
                  </div>
                </div>
                <ReadyDot persona={p} />
              </button>
            ))}
        </nav>

        <CreditsWidget />

        <div className="border-t border-edge px-5 py-3 text-[11px] text-mute">
          {personas.filter((p) => !p.archived).length} aktif ·{" "}
          Instagram-first
        </div>
      </aside>

      {/* ===== Main ===== */}
      <main className="flex-1 overflow-y-auto">
        {active ? (
          <PersonaView persona={active} onChange={load} />
        ) : (
          <div className="flex h-full items-center justify-center text-mute">
            {loading ? "" : "Pilih atau tambah persona"}
          </div>
        )}
      </main>

      {showAdd && (
        <AddNicheModal
          onClose={() => setShowAdd(false)}
          onCreated={async (id) => {
            setShowAdd(false);
            await load();
            setActiveId(id);
          }}
        />
      )}
    </div>
  );
}

function CreditsWidget() {
  const [c, setC] = useState<any>(null);
  const [topup, setTopup] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/credits", { cache: "no-store" });
    setC(await r.json());
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function addTopup() {
    const amt = parseFloat(topup);
    if (isNaN(amt)) return;
    await fetch("/api/credits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topup: amt }),
    });
    setTopup("");
    setOpen(false);
    load();
  }

  if (!c) return null;
  const low = c.balance < 5;
  return (
    <div className="border-t border-edge px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono tracking-widest text-mute">
          SALDO HIGGSFIELD
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[10px] text-indigo-soft hover:text-indigo"
        >
          + top-up
        </button>
      </div>
      <div className={`mt-1 text-lg font-semibold ${low ? "text-bad" : "text-ink"}`}>
        ${c.balance?.toFixed(2)}
        {low && <span className="ml-1 text-[10px] text-bad">⚠ menipis</span>}
      </div>
      <div className="mt-0.5 text-[10px] text-mute">
        terpakai ~${c.total_spend_est?.toFixed(2)} · {c.videos_charged} video
      </div>
      {open && (
        <div className="mt-2 flex gap-1">
          <input
            type="number"
            value={topup}
            onChange={(e) => setTopup(e.target.value)}
            placeholder="isi $ (cek console)"
            className="w-full rounded border border-edge bg-void px-2 py-1 text-[11px] text-ink focus:border-indigo focus:outline-none"
          />
          <button
            onClick={addTopup}
            className="rounded bg-indigo px-2 py-1 text-[10px] font-semibold text-white hover:bg-indigo-deep"
          >
            set
          </button>
        </div>
      )}
    </div>
  );
}

function Avatar({ persona }: { persona: Persona }) {
  if (persona.character_img) {
    return (
      <img
        src={`/api/media/${persona.id}/${persona.character_img}`}
        alt=""
        className="h-9 w-9 rounded-full object-cover border border-edge"
      />
    );
  }
  const letter = persona.name.charAt(0).toUpperCase();
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-deep/40 text-sm font-semibold text-indigo-soft border border-edge">
      {letter}
    </div>
  );
}

// green dot = ready (has master prompt + character)
function ReadyDot({ persona }: { persona: Persona }) {
  const ready = !!persona.master_prompt && !!persona.character_img;
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${
        ready ? "bg-ok" : "bg-warn/60"
      }`}
      title={ready ? "Siap generate" : "Lengkapi master prompt + character"}
    />
  );
}

/* ========================= Persona View ========================= */

function PersonaView({
  persona,
  onChange,
}: {
  persona: Persona;
  onChange: () => void;
}) {
  const [tab, setTab] = useState<"setup" | "pipeline" | "insights">(
    persona.master_prompt && persona.character_img ? "pipeline" : "setup"
  );

  return (
    <div className="mx-auto max-w-[1600px] px-8 py-6">
      {/* header */}
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <Avatar persona={persona} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              {persona.name}
            </h1>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-mute">
              <Tag>{persona.niche}</Tag>
              <Tag>{persona.platform}</Tag>
              <Tag>{persona.aspect}</Tag>
            </div>
          </div>
        </div>
        <div className="flex gap-1 rounded-lg border border-edge p-1">
          {(["setup", "pipeline", "insights"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-4 py-1.5 text-xs font-medium capitalize transition ${
                tab === t
                  ? "bg-indigo/20 text-indigo-soft"
                  : "text-mute hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6">
        {tab === "setup" ? (
          <SetupPanel persona={persona} onChange={onChange} />
        ) : tab === "pipeline" ? (
          <PipelineBoard persona={persona} />
        ) : (
          <InsightsPanel persona={persona} />
        )}
      </div>
    </div>
  );
}

function InsightsPanel({ persona }: { persona: Persona }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/personas/${persona.id}/insights`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }, [persona.id]);

  if (loading) return <div className="text-xs text-mute">Loading insights…</div>;
  if (!data || data.error)
    return <div className="text-xs text-mute">Belum ada data RAG.</div>;

  const rec = data.recommendations || {};
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* summary */}
      <div className="rounded-xl border border-edge bg-panel p-5">
        <div className="text-[11px] font-mono tracking-widest text-indigo-soft">
          RAG MEMORY — niche: {data.niche}
        </div>
        <div className="mt-1 text-[11px] text-mute">
          {data.total_decisions} keputusan QC tercatat
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <Stat label="OK" value={data.counts.ok} tone="ok" />
          <Stat label="Revisi" value={data.counts.revisi} tone="warn" />
          <Stat label="Ulang" value={data.counts.ulang} tone="bad" />
        </div>
        <div className="mt-4 space-y-1.5 text-[11px]">
          <Row k="OK rate" v={`${(data.ok_rate * 100).toFixed(0)}%`} />
          <Row
            k="First-try OK"
            v={`${(data.first_try_ok_rate * 100).toFixed(0)}% (${data.first_try_samples} sampel)`}
          />
          <Row k="Best engine" v={data.best_engine || "—"} />
        </div>
      </div>

      {/* recommendation */}
      <div className="rounded-xl border border-edge bg-panel p-5">
        <div className="text-[11px] font-mono tracking-widest text-indigo-soft">
          REKOMENDASI SISTEM
        </div>
        <div
          className={`mt-3 rounded-lg border p-3 text-[11px] leading-relaxed ${
            rec.auto_skip_480p
              ? "border-ok/40 bg-ok/10 text-ok"
              : "border-edge bg-void text-mute"
          }`}
        >
          <div className="font-semibold">
            {rec.auto_skip_480p ? "✓ Aman langsung 1080p" : "⏳ Tetap 480p draft dulu"}
          </div>
          <div className="mt-1">{rec.note}</div>
        </div>
        {data.engines?.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[10px] font-mono tracking-widest text-mute">
              ENGINE WIN-RATE
            </div>
            {data.engines.map((e: any) => (
              <div key={e.engine} className="flex items-center justify-between text-[11px]">
                <span className="text-ink">{e.engine}</span>
                <span className="text-mute">
                  {e.ok}/{e.total} ({(e.win_rate * 100).toFixed(0)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* winning prompts */}
      {data.winning_prompts?.length > 0 && (
        <div className="rounded-xl border border-edge bg-panel p-5 lg:col-span-2">
          <div className="text-[11px] font-mono tracking-widest text-indigo-soft">
            PROMPT LIBRARY — yang menang (OK)
          </div>
          <div className="mt-3 space-y-2">
            {data.winning_prompts.map((p: any, i: number) => (
              <details key={i} className="rounded-lg border border-edge bg-void p-2">
                <summary className="cursor-pointer text-[11px] text-ink">
                  {p.shortcode} · {p.engine} ·{" "}
                  <span className="text-mute">{p.created_at}</span>
                </summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-[10px] leading-snug text-mute">
                  {p.prompt}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-bad";
  return (
    <div className="rounded-lg border border-edge bg-void p-3 text-center">
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] text-mute">{label}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-mute">{k}</span>
      <span className="text-ink">{v}</span>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-edge bg-void px-2 py-0.5 font-mono text-[10px] tracking-wide text-mute">
      {children}
    </span>
  );
}

/* ========================= Setup Panel ========================= */

function SetupPanel({
  persona,
  onChange,
}: {
  persona: Persona;
  onChange: () => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <CharacterCard persona={persona} onChange={onChange} />
      <MasterPromptCard persona={persona} onChange={onChange} />
    </div>
  );
}

function CharacterCard({
  persona,
  onChange,
}: {
  persona: Persona;
  onChange: () => void;
}) {
  const [imgs, setImgs] = useState<
    { id: number; rel_path: string; width: number; height: number }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadImgs = useCallback(async () => {
    const r = await fetch(`/api/personas/${persona.id}/character`, {
      cache: "no-store",
    });
    setImgs(await r.json());
  }, [persona.id]);

  useEffect(() => {
    loadImgs();
  }, [loadImgs]);

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/personas/${persona.id}/character`, {
      method: "POST",
      body: fd,
    });
    const data = await r.json();
    setBusy(false);
    if (data.error) setMsg("Error: " + data.error);
    else {
      setMsg(
        data.warn
          ? "⚠ " + data.warn
          : `OK · ${data.width}×${data.height} — foto ${data.count}/8`
      );
      await loadImgs();
      onChange();
    }
  }

  async function remove(imgId: number) {
    setBusy(true);
    await fetch(`/api/personas/${persona.id}/character?img=${imgId}`, {
      method: "DELETE",
    });
    setBusy(false);
    await loadImgs();
    onChange();
  }

  const full = imgs.length >= 8;

  return (
    <Card
      title="CHARACTER LOCK"
      hint="Foto karakter (1–8) — dikirim sebagai image_urls di Genjutsu"
    >
      <div className="grid grid-cols-4 gap-2.5">
        {imgs.map((im, i) => (
          <div
            key={im.id}
            className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-edge bg-void"
          >
            <img
              src={`/api/media/${persona.id}/${im.rel_path}?t=${im.id}`}
              alt=""
              className="h-full w-full object-cover"
            />
            {i === 0 && (
              <span className="absolute left-1 top-1 rounded bg-indigo/80 px-1.5 py-0.5 text-[9px] font-medium text-white">
                avatar
              </span>
            )}
            <button
              onClick={() => remove(im.id)}
              disabled={busy}
              className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-black/70 text-xs text-bad opacity-0 transition group-hover:opacity-100 hover:bg-black"
              title="Hapus"
            >
              ×
            </button>
            {im.width > 0 && im.width < 768 && (
              <span className="absolute bottom-0 left-0 right-0 bg-warn/20 px-1 py-0.5 text-center text-[8px] text-warn">
                {im.width}px low
              </span>
            )}
          </div>
        ))}

        {!full && (
          <label className="flex aspect-[3/4] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-edge text-mute transition hover:border-indigo/50 hover:text-indigo-soft">
            <span className="text-xl leading-none">+</span>
            <span className="text-[10px]">
              {busy ? "…" : "tambah"}
            </span>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-mute">
        Wajah frontal, tajam, ≥1024px. Multi-foto (angle/ekspresi beda) bikin
        lock lebih kuat. Foto pertama = avatar. Harus konsisten sama deskripsi
        karakter di master prompt.
      </p>
      {msg && <div className="mt-2 text-[11px] text-mute">{msg}</div>}
    </Card>
  );
}

function MasterPromptCard({
  persona,
  onChange,
}: {
  persona: Persona;
  onChange: () => void;
}) {
  const [text, setText] = useState(persona.master_prompt || "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setText(persona.master_prompt || "");
  }, [persona.id, persona.master_prompt]);

  const slots = Array.from(new Set((text.match(/\[[^\]]+\]/g) || [])));

  async function saveText() {
    setBusy(true);
    setMsg(null);
    const r = await fetch(`/api/personas/${persona.id}/master-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await r.json();
    setBusy(false);
    if (data.error) setMsg("Error: " + data.error);
    else {
      setMsg(`Tersimpan · ${data.length} char · ${data.slots.length} slot`);
      onChange();
    }
  }

  async function uploadPdf(file: File) {
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/personas/${persona.id}/master-prompt`, {
      method: "POST",
      body: fd,
    });
    const data = await r.json();
    setBusy(false);
    if (data.error) setMsg("Error: " + data.error);
    else {
      // reload text from server
      const pr = await fetch(`/api/personas/${persona.id}`, { cache: "no-store" });
      const pd = await pr.json();
      setText(pd.master_prompt || "");
      setMsg(`PDF ter-extract · ${data.length} char · ${data.slots.length} slot`);
      onChange();
    }
  }

  return (
    <Card
      title="MASTER PROMPT"
      hint="Sumber kebenaran — template fill-in. Slot [...] diisi per generate"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Tempel master prompt, atau upload PDF di bawah…"
        className="h-56 w-full resize-none rounded-lg border border-edge bg-void p-3 font-mono text-[11px] leading-relaxed text-ink placeholder:text-mute focus:border-indigo focus:outline-none"
      />
      {slots.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[10px] font-mono tracking-widest text-mute">
            SLOT TERDETEKSI ({slots.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {slots.map((s) => (
              <span
                key={s}
                className="rounded border border-indigo/30 bg-indigo/10 px-2 py-0.5 font-mono text-[10px] text-indigo-soft"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={saveText}
          disabled={busy}
          className="rounded-md bg-indigo px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-deep disabled:opacity-50 transition"
        >
          {busy ? "…" : "Simpan"}
        </button>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-edge px-4 py-2 text-xs text-mute hover:text-ink hover:border-indigo/40 transition">
          Upload PDF
          <input
            type="file"
            accept=".pdf,.txt"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadPdf(f);
            }}
          />
        </label>
        {msg && <span className="text-[11px] text-mute">{msg}</span>}
      </div>
    </Card>
  );
}

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <div className="mb-4">
        <div className="text-[11px] font-mono tracking-widest text-indigo-soft">
          {title}
        </div>
        {hint && <div className="mt-0.5 text-[11px] text-mute">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/* ========================= Pipeline Board ========================= */

type Video = {
  id: number;
  stage: string;
  source_url: string | null;
  local_ref: string | null;
  duration_s: number | null;
  ref_score: number | null;
  ref_notes: string | null;
  shortcode: string | null;
  views: number | null;
  views_per_hour: number | null;
  caption: string | null;
  creator: string | null;
  output_480: string | null;
  output_1080: string | null;
  qc_status: string | null;
  gen_error?: string | null;
};

const STAGES = [
  { key: "inbox", label: "INBOX", sub: "viral masuk" },
  { key: "shortlist", label: "SHORTLIST", sub: "ref-fit ✅" },
  { key: "generating", label: "GENERATING", sub: "480p draft" },
  { key: "qc", label: "QC", sub: "OK / Revisi" },
  { key: "done", label: "DONE", sub: "1080p HD" },
];

function fmtViews(n: number | null) {
  if (!n) return "–";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return String(n);
}

function PipelineBoard({ persona }: { persona: Persona }) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/personas/${persona.id}/videos`, {
      cache: "no-store",
    });
    setVideos(await r.json());
    setLoading(false);
  }, [persona.id]);

  useEffect(() => {
    load();
  }, [load]);

  // auto-poll while any video is generating (async render tracking)
  const anyGenerating = videos.some((v) => v.stage === "generating");
  useEffect(() => {
    if (!anyGenerating) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [anyGenerating, load]);

  async function ingest() {
    setIngesting(true);
    setMsg(null);
    const r = await fetch(`/api/personas/${persona.id}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 8 }),
    });
    const d = await r.json();
    setIngesting(false);
    if (d.error) setMsg("Error: " + d.error);
    else setMsg(`+${d.added} ditarik · ${d.skipped} dup · ${d.failed} gagal`);
    await load();
  }

  async function move(v: Video, stage: string) {
    await fetch(`/api/personas/${persona.id}/videos`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: v.id, stage }),
    });
    await load();
  }

  async function del(v: Video) {
    await fetch(`/api/personas/${persona.id}/videos?video_id=${v.id}`, {
      method: "DELETE",
    });
    await load();
  }

  const [genMsg, setGenMsg] = useState<string | null>(null);

  async function generate(v: Video, engine: string) {
    setGenMsg(null);
    const r = await fetch(`/api/personas/${persona.id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: v.id, engine, resolution: "480p" }),
    });
    const d = await r.json();
    if (d.error) setGenMsg("✗ " + (d.detail || d.error).slice(0, 120));
    else setGenMsg(`⚡ ${engine} jalan di background…`);
    await load();
  }

  const byStage = (s: string) => videos.filter((v) => v.stage === s);

  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  async function startAuto() {
    setAutoBusy(true);
    setAutoMsg(null);
    const r = await fetch(`/api/personas/${persona.id}/auto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 1 }),
    });
    const d = await r.json();
    setAutoMsg(d.error ? "✗ " + d.error : "⚡ AUTO jalan — pantau board");
    setAutoBusy(false);
    setTimeout(load, 2000);
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[11px] text-mute">
          Cluster:{" "}
          <span className="font-mono text-indigo-soft">
            {persona.viral_cluster_slug || "(belum di-set)"}
          </span>
          {msg && <span className="ml-3 text-mute">· {msg}</span>}
          {autoMsg && <span className="ml-3 text-indigo-soft">· {autoMsg}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={ingest}
            disabled={ingesting || !persona.viral_cluster_slug}
            className="rounded-md border border-edge px-4 py-2 text-xs font-semibold text-mute hover:text-ink hover:border-indigo disabled:opacity-40 transition"
          >
            {ingesting ? "Menarik viral…" : "⬇ Tarik Viral (MCP)"}
          </button>
          <button
            onClick={startAuto}
            disabled={autoBusy || !persona.viral_cluster_slug}
            className="rounded-md bg-gradient-to-r from-indigo to-indigo-deep px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo/30 hover:brightness-110 disabled:opacity-40 transition"
            title="Full-auto: ingest → pilih ref → prompt → generate → QC, tanpa sentuhan"
          >
            {autoBusy ? "Memulai…" : "⚡ GENERATE AUTO VIDEO"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {STAGES.map((st) => {
          const items = byStage(st.key);
          return (
            <div
              key={st.key}
              className="flex flex-col rounded-xl border border-edge bg-panel"
            >
              <div className="flex items-center justify-between border-b border-edge px-3 py-2.5">
                <div>
                  <div className="text-[11px] font-mono tracking-widest text-ink">
                    {st.label}
                  </div>
                  <div className="text-[10px] text-mute">{st.sub}</div>
                </div>
                <span className="rounded-full border border-edge bg-void px-2 py-0.5 font-mono text-[11px] text-indigo-soft">
                  {items.length}
                </span>
              </div>
              <div className="flex min-h-[340px] flex-col gap-2.5 p-2.5">
                {loading && (
                  <div className="text-[11px] text-mute">Loading…</div>
                )}
                {!loading && items.length === 0 && (
                  <div className="py-6 text-center text-[11px] text-mute">
                    kosong
                  </div>
                )}
                {items.map((v) => (
                  <VideoCard
                    key={v.id}
                    v={v}
                    personaId={persona.id}
                    onMove={move}
                    onDelete={del}
                    onGenerate={generate}
                    genBusy={v.stage === "generating"}
                    genMsg={genMsg}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VideoCard({
  v,
  personaId,
  onMove,
  onDelete,
  onGenerate,
  genBusy,
  genMsg,
}: {
  v: Video;
  personaId: string;
  onMove: (v: Video, stage: string) => void;
  onDelete: (v: Video) => void;
  onGenerate: (v: Video, engine: string) => void;
  genBusy?: boolean;
  genMsg?: string | null;
}) {
  const [engine, setEngine] = useState("seedance");
  const src =
    v.output_1080 || v.output_480 || v.local_ref
      ? `/api/media/${personaId}/${v.output_1080 || v.output_480 || v.local_ref}`
      : null;

  return (
    <div className="overflow-hidden rounded-lg border border-edge bg-void">
      {src && (
        <video
          src={src}
          controls
          preload="metadata"
          className="aspect-[9/16] w-full bg-black object-cover"
        />
      )}
      <div className="p-2">
        <div className="flex items-center justify-between text-[10px] text-mute">
          <span className="font-mono">
            {v.duration_s ? v.duration_s.toFixed(0) + "s" : "–"}
          </span>
          <span>👁 {fmtViews(v.views)}</span>
          {v.views_per_hour ? (
            <span className="text-indigo-soft">
              {Math.round(v.views_per_hour).toLocaleString()}/h
            </span>
          ) : null}
        </div>
        {v.creator && (
          <div className="mt-1 truncate text-[10px] text-mute">
            @{v.creator}
          </div>
        )}
        {v.caption && (
          <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-mute/80">
            {v.caption}
          </div>
        )}

        {/* stage-specific actions */}
        <div className="mt-2 flex flex-wrap gap-1">
          {v.stage === "inbox" && (
            <>
              <Btn ok onClick={() => onMove(v, "shortlist")}>
                ✓ pilih ref
              </Btn>
              <Btn onClick={() => onDelete(v)}>✕</Btn>
            </>
          )}
          {v.stage === "shortlist" && (
            <div className="flex w-full flex-col gap-1.5">
              {v.gen_error && (
                <div className="rounded border border-bad/40 bg-bad/10 px-1.5 py-1 text-[9px] text-bad">
                  gagal: {v.gen_error.slice(0, 80)}
                </div>
              )}
              <div className="flex items-center gap-1">
                <select
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  disabled={genBusy}
                  className="flex-1 rounded border border-edge bg-void px-1.5 py-1 text-[10px] text-ink focus:border-indigo focus:outline-none"
                >
                  <option value="seedance">Seedance (aman predator)</option>
                  <option value="genjutsu">Genjutsu (ketat, kualitas)</option>
                </select>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => onGenerate(v, engine)}
                  disabled={genBusy}
                  className="flex-1 rounded bg-indigo px-2 py-1 text-[10px] font-semibold text-white hover:bg-indigo-deep disabled:opacity-40 transition"
                >
                  {genBusy ? "Generating…" : "⚡ Generate 480p"}
                </button>
                <Btn onClick={() => onMove(v, "inbox")}>↩</Btn>
              </div>
              {genMsg && <div className="text-[9px] text-mute">{genMsg}</div>}
            </div>
          )}
          {v.stage === "generating" && (
            <div className="flex items-center gap-1.5 text-[10px] text-indigo-soft">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo" />
              rendering…
            </div>
          )}
          {v.stage === "qc" && (
            <>
              <Btn ok onClick={() => onMove(v, "done")}>
                OK
              </Btn>
              <Btn onClick={() => onMove(v, "generating")}>revisi</Btn>
              <Btn onClick={() => onMove(v, "inbox")}>ulang</Btn>
            </>
          )}
          {v.stage === "done" && v.source_url && (
            <a
              href={v.source_url}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-edge px-2 py-0.5 text-[10px] text-mute hover:text-ink"
            >
              sumber ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  ok,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ok?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${
        ok
          ? "bg-indigo/20 text-indigo-soft hover:bg-indigo/30"
          : "border border-edge text-mute hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/* ========================= Add Niche Modal ========================= */

function AddNicheModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [cluster, setCluster] = useState("");
  const [clusters, setClusters] = useState<any[]>([]);
  const [platform, setPlatform] = useState("instagram");
  const [aspect, setAspect] = useState("9:16");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/clusters", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setClusters(d.clusters || []))
      .catch(() => {});
  }, []);

  async function create() {
    if (!name.trim() || !niche.trim()) {
      setErr("Nama & niche wajib diisi");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, niche, platform, aspect, viral_cluster_slug: cluster || null }),
    });
    const data = await r.json();
    setBusy(false);
    if (data.error) setErr(data.error);
    else onCreated(data.id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-edge bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold tracking-wide text-ink">
          Tambah Niche / Persona
        </h2>
        <p className="mt-1 text-[11px] text-mute">
          Bikin folder + config persona baru. Master prompt & character diisi
          setelah ini.
        </p>

        <div className="mt-5 space-y-4">
          <Field label="Nama persona">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Kepin Animal"
              className="input"
            />
          </Field>
          <Field label="Kategori viral (ViralEngine cluster)">
            <select
              value={cluster}
              onChange={(e) => {
                const slug = e.target.value;
                setCluster(slug);
                // auto-fill niche from the cluster's base word if empty
                if (slug && !niche.trim()) {
                  setNiche(slug.split("-")[0]);
                }
              }}
              className="input"
            >
              <option value="">— pilih kategori —</option>
              {clusters.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}{c.total ? ` (${c.total})` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Niche">
            <input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="animal"
              className="input"
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Platform">
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="input"
              >
                <option value="instagram">Instagram</option>
                <option value="tiktok" disabled>
                  TikTok (nanti)
                </option>
                <option value="youtube" disabled>
                  YouTube (nanti)
                </option>
              </select>
            </Field>
            <Field label="Aspect">
              <select
                value={aspect}
                onChange={(e) => setAspect(e.target.value)}
                className="input"
              >
                <option value="9:16">9:16 (reels)</option>
                <option value="1:1">1:1</option>
                <option value="16:9">16:9</option>
              </select>
            </Field>
          </div>
        </div>

        {err && <div className="mt-4 text-[11px] text-bad">{err}</div>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-edge px-4 py-2 text-xs text-mute hover:text-ink transition"
          >
            Batal
          </button>
          <button
            onClick={create}
            disabled={busy}
            className="rounded-md bg-indigo px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-deep disabled:opacity-50 transition"
          >
            {busy ? "Membuat…" : "Buat Persona"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[10px] font-mono tracking-widest text-mute">
        {label.toUpperCase()}
      </span>
      {children}
    </label>
  );
}
