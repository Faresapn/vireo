"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

type Persona = {
  id: string;
  name: string;
  niche: string;
  platform: string;
  aspect: string;
  master_prompt: string | null;
  character_img: string | null;
  viral_source: string | null;
  viral_cluster_slug?: string | null;
  auto_engine?: string | null;
  archived: number;
  cnt_inbox: number;
  cnt_shortlist: number;
  cnt_gen: number;
  cnt_qc: number;
  cnt_done: number;
};

const PLATFORMS = [
  { key: "all", label: "Semua", icon: "✦" },
  { key: "instagram", label: "Instagram", icon: "📷" },
  { key: "tiktok", label: "TikTok", icon: "🎵" },
  { key: "youtube", label: "YouTube", icon: "▶️" },
  { key: "facebook", label: "Facebook", icon: "👤" },
];

export default function Studio({ activeIdProp }: { activeIdProp?: string | null }) {
  const router = useRouter();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState<string | null>(activeIdProp ?? null);
  const [showAdd, setShowAdd] = useState(false);
  const [platform, setPlatform] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const r = await fetch("/api/personas", { cache: "no-store" });
    const data = await r.json();
    setPersonas(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // sync active id from the URL prop (route-driven)
  useEffect(() => {
    if (activeIdProp !== undefined) setActiveId(activeIdProp);
  }, [activeIdProp]);

  // navigate helper: push a real URL so routing works
  const selectPersona = useCallback(
    (id: string) => {
      setActiveId(id);
      router.push(`/niche/${id}`);
    },
    [router]
  );

  const active = personas.find((p) => p.id === activeId) || null;
  const visiblePersonas = personas.filter(
    (p) => !p.archived && (platform === "all" || (p.platform || "instagram") === platform)
  );

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden">
      {/* ===== Top navbar: brand + platform switcher ===== */}
      <header className="flex h-14 shrink-0 items-center gap-6 border-b border-edgeSoft bg-base/70 px-5 shadow-[0_1px_0_0_rgba(0,0,0,0.5),0_8px_24px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-accent-soft to-accent-deep text-[15px] font-bold text-[#241a07] shadow-glow">V</div>
          <div className="display text-[17px] font-bold text-ink">Vireo<span className="text-accent">.</span></div>
        </div>
        <nav className="flex items-center gap-1">
          {PLATFORMS.map((pl) => {
            const on = platform === pl.key;
            return (
              <button
                key={pl.key}
                onClick={() => setPlatform(pl.key)}
                className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all ${on ? "bg-accent/15 text-accent-soft" : "text-faint hover:bg-raise/60 hover:text-sub"}`}
              >
                <span className="text-[15px] leading-none">{pl.icon}</span>
                {pl.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
      {/* ===== Sidebar ===== */}
      <aside className="flex w-[264px] shrink-0 flex-col border-r border-edgeSoft bg-base/80 backdrop-blur-xl">
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <div className="leading-none">
            <div className="eyebrow">Personas</div>
            <div className="mt-1 text-[11px] text-faint">{PLATFORMS.find((p) => p.key === platform)?.label}</div>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="grid h-7 w-7 place-items-center rounded-lg border border-edge text-sub transition hover:border-accent/50 hover:text-accent hover:bg-accent/5"
            title="Tambah niche"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        </div>

        <nav className="stagger flex-1 overflow-y-auto px-2.5 pb-2">
          {loading && (
            <div className="space-y-1.5 px-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-[46px] rounded-xl shimmer" />
              ))}
            </div>
          )}
          {!loading && visiblePersonas.length === 0 && (
            <div className="px-3 py-6 text-xs text-mute leading-relaxed">
              {personas.filter((p) => !p.archived).length === 0
                ? <>Belum ada persona. Klik <span className="text-accent">+</span> buat tambah niche pertama.</>
                : <>Belum ada persona di {PLATFORMS.find((p) => p.key === platform)?.label}.</>}
            </div>
          )}
          {visiblePersonas
            .map((p) => (
              <button
                key={p.id}
                onClick={() => selectPersona(p.id)}
                className={`group relative mb-1 flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-all duration-200 ${
                  activeId === p.id
                    ? "bg-raise"
                    : "hover:bg-raise/50"
                }`}
              >
                {activeId === p.id && (
                  <span className="absolute left-0 top-1/2 h-5 w-[2.5px] -translate-y-1/2 rounded-full bg-accent" />
                )}
                <Avatar persona={p} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13px] font-medium ${activeId === p.id ? "text-ink" : "text-sub group-hover:text-ink"}`}>
                    {p.name}
                  </div>
                  <div className="truncate text-[11px] text-faint">
                    {p.niche}
                  </div>
                </div>
                <ReadyDot persona={p} />
              </button>
            ))}
        </nav>

        <CreditsWidget />

        <div className="flex items-center gap-2 border-t border-edgeSoft px-5 py-3 text-[11px] text-faint">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
          </span>
          {personas.filter((p) => !p.archived).length} aktif · Instagram-first
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
      </div>

      {showAdd && (
        <AddNicheModal
          onClose={() => setShowAdd(false)}
          onCreated={async (id) => {
            setShowAdd(false);
            await load();
            selectPersona(id);
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
    <div className="mx-2.5 mb-2 rounded-xl border border-edgeSoft bg-panel/60 px-3.5 py-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Saldo Higgsfield</span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="text-[10px] font-medium text-accent transition hover:text-accent-soft"
        >
          + top-up
        </button>
      </div>
      <div className={`mt-1.5 flex items-baseline gap-1.5 font-semibold tracking-tightest ${low ? "text-bad" : "text-ink"}`}>
        <span className="text-[22px] tabular-nums">${c.balance?.toFixed(2)}</span>
        {low && <span className="text-[10px] font-normal text-bad">⚠ menipis</span>}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-faint">
        <span>terpakai ~${c.total_spend_est?.toFixed(2)}</span>
        <span className="h-0.5 w-0.5 rounded-full bg-faint" />
        <span>{c.videos_charged} video</span>
      </div>
      {/* usage bar */}
      {c.topup_total > 0 && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-raise">
          <div
            className={`h-full rounded-full ${low ? "bg-bad" : "bg-accent"}`}
            style={{ width: `${Math.min(100, Math.max(2, ((c.total_spend_est || 0) / c.topup_total) * 100))}%` }}
          />
        </div>
      )}
      {open && (
        <div className="mt-2.5 flex gap-1.5">
          <input
            type="number"
            value={topup}
            onChange={(e) => setTopup(e.target.value)}
            placeholder="isi $ (cek console)"
            className="w-full rounded-lg border border-edge bg-void px-2.5 py-1.5 text-[11px] text-ink outline-none transition focus:border-accent/50 focus:shadow-[0_0_0_3px_rgba(232,177,76,0.1)]"
          />
          <button
            onClick={addTopup}
            className="rounded-lg bg-accent px-3 py-1.5 text-[10px] font-semibold text-[#241a07] transition hover:brightness-105"
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
        className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-edge"
      />
    );
  }
  const letter = persona.name.replace(/^Kepin\s+/i, "").charAt(0).toUpperCase() || persona.name.charAt(0).toUpperCase();
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-raise text-[13px] font-semibold text-sub ring-1 ring-edge">
      {letter}
    </div>
  );
}

// dot = ready (has master prompt + character)
function ReadyDot({ persona }: { persona: Persona }) {
  const ready = !!persona.master_prompt && !!persona.character_img;
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
        ready ? "bg-ok shadow-[0_0_8px_rgba(74,222,128,0.6)]" : "bg-warn/50"
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
  const [tab, setTab] = useState<"setup" | "refs" | "pipeline" | "insights">(
    persona.master_prompt && persona.character_img ? "pipeline" : "setup"
  );

  return (
    <div className="mx-auto max-w-[2100px] animate-fade-up px-12 py-8 2xl:px-16">
      {/* header */}
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Avatar persona={persona} />
          </div>
          <div>
            <h1 className="display text-[34px] font-semibold text-ink">
              {persona.name}
            </h1>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Tag>{persona.niche}</Tag>
              <Tag>{persona.platform}</Tag>
              <Tag>{persona.aspect}</Tag>
              {persona.viral_cluster_slug && (
                <span className="chip border-accent/20 bg-accent/5 text-accent-soft">
                  {persona.viral_cluster_slug}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-0.5 rounded-xl border border-edgeSoft bg-base/60 p-1 backdrop-blur">
          {([
            ["setup", "Setup"],
            ["refs", "Pilih Ref"],
            ["pipeline", "Pipeline"],
            ["insights", "Insights"],
          ] as const).map(([t, label]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative rounded-lg px-4 py-1.5 text-[13px] font-medium transition-all duration-200 ${
                tab === t
                  ? "bg-raise text-ink shadow-sm"
                  : "text-mute hover:text-sub"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-8">
        {tab === "setup" ? (
          <SetupPanel persona={persona} onChange={onChange} />
        ) : tab === "refs" ? (
          <PipelineBoard persona={persona} view="refs" />
        ) : tab === "pipeline" ? (
          <PipelineBoard persona={persona} view="pipeline" />
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
      <div className="card p-5">
        <div className="eyebrow">
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
      <div className="card p-5">
        <div className="eyebrow">
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
        <div className="card p-5 lg:col-span-2">
          <div className="eyebrow">
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
    <span className="chip font-mono text-[10px] tracking-wide">
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
              <span className="absolute left-1 top-1 rounded bg-accent/90 text-[#241a07] px-1.5 py-0.5 text-[9px] font-medium text-white">
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
          <label className="flex aspect-[3/4] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-edge text-mute transition hover:border-accent/50 hover:text-accent">
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
        className="h-56 w-full resize-none rounded-lg border border-edge bg-void p-3 font-mono text-[11px] leading-relaxed text-ink placeholder:text-mute focus:border-accent/50 focus:outline-none"
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
                className="rounded border border-accent/25 bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent-soft"
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
          className="btn btn-primary disabled:opacity-50"
        >
          {busy ? "…" : "Simpan"}
        </button>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-edge px-4 py-2 text-xs text-mute hover:text-ink hover:border-accent/40 transition">
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
    <div className="card p-5">
      <div className="mb-4">
        <div className="eyebrow">
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
  gen_engine?: string | null;
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

function PipelineBoard({ persona, view = "pipeline" }: { persona: Persona; view?: "refs" | "pipeline" }) {
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

  async function generate(v: Video, engine: string, resolution: string = "480p") {
    setGenMsg(null);
    const r = await fetch(`/api/personas/${persona.id}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: v.id, engine, resolution }),
    });
    const d = await r.json();
    if (d.error) setGenMsg("✗ " + (d.detail || d.error).slice(0, 120));
    else setGenMsg(`⚡ ${engine} ${resolution} jalan di background…`);
    await load();
  }

  const byStage = (s: string) => videos.filter((v) => v.stage === s);

  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const [autoEngine, setAutoEngine] = useState(persona.auto_engine || "");
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
          <span className="font-mono text-accent-soft">
            {persona.viral_cluster_slug || "(belum di-set)"}
          </span>
          {msg && <span className="ml-3 text-mute">· {msg}</span>}
          {autoMsg && <span className="ml-3 text-accent-soft">· {autoMsg}</span>}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={autoEngine}
            onChange={async (e) => {
              const val = e.target.value;
              setAutoEngine(val);
              await fetch(`/api/personas/${persona.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ auto_engine: val || null }),
              });
            }}
            title="Model buat mode AUTO. 'Auto' = sistem pilih sendiri (durasi/predator/RAG)."
            className="rounded-lg border border-edge bg-void px-2 py-2 text-xs text-sub focus:border-accent/50 focus:outline-none"
          >
            <option value="">Model: Auto</option>
            <option value="seedance">Kunci: Seedance</option>
            <option value="genjutsu">Kunci: Genjutsu</option>
            <option value="wan-prime">Kunci: Wan Prime</option>
          </select>
          <button
            onClick={ingest}
            disabled={ingesting || !persona.viral_cluster_slug}
            className="btn btn-ghost text-xs font-semibold disabled:opacity-40"
          >
            {ingesting ? "Menarik viral…" : "⬇ Tarik Viral (MCP)"}
          </button>
          <button
            onClick={startAuto}
            disabled={autoBusy || !persona.viral_cluster_slug}
            className="btn btn-accent px-4 py-2 text-xs disabled:opacity-40"
            title="Full-auto: ingest → pilih ref → prompt → generate → QC, tanpa sentuhan"
          >
            {autoBusy ? "Memulai…" : "⚡ GENERATE AUTO VIDEO"}
          </button>
        </div>
      </div>

      {view === "refs" ? (
        /* PILIH REF — grid INBOX dari MCP */
        <div>
          {loading && <div className="text-[11px] text-mute">Loading…</div>}
          {!loading && byStage("inbox").length === 0 && (
            <div className="card flex flex-col items-center justify-center gap-2 py-16 text-center">
              <div className="text-sm text-sub">INBOX kosong</div>
              <div className="text-[11px] text-mute">Klik <span className="text-accent-soft">Tarik Viral (MCP)</span> buat narik ref viral baru.</div>
            </div>
          )}
          <div className="stagger grid grid-cols-4 gap-3 xl:grid-cols-6 2xl:grid-cols-7">
            {byStage("inbox").map((v) => (
              <RefCard
                key={v.id}
                v={v}
                personaId={persona.id}
                onPick={async (vid) => { await move(vid, "shortlist"); }}
                onDelete={del}
              />
            ))}
          </div>
        </div>
      ) : (
        /* PIPELINE — baris per ref terpilih */
        <div className="stagger flex flex-col gap-2.5">
          {loading && <div className="text-[11px] text-mute">Loading…</div>}
          {!loading && byStage("shortlist").length + byStage("generating").length + byStage("qc").length + byStage("done").length === 0 && (
            <div className="card flex flex-col items-center justify-center gap-2 py-16 text-center">
              <div className="text-sm text-sub">Belum ada ref terpilih</div>
              <div className="text-[11px] text-mute">Pilih ref dulu dari tab <span className="text-accent-soft">Pilih Ref</span>, atau klik GENERATE AUTO VIDEO.</div>
            </div>
          )}
          {["shortlist", "generating", "qc", "done"].flatMap((stage) =>
            byStage(stage).map((v) => (
              <PipelineRow
                key={v.id}
                v={v}
                personaId={persona.id}
                onMove={move}
                onDelete={del}
                onGenerate={generate}
                genBusy={v.stage === "generating"}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Compact INBOX ref card for the "Pilih Ref" page
function RefCard({
  v,
  personaId,
  onPick,
  onDelete,
}: {
  v: Video;
  personaId: string;
  onPick: (v: Video) => void;
  onDelete: (v: Video) => void;
}) {
  const src = v.local_ref ? `/api/media/${personaId}/${v.local_ref}` : null;
  const tooLong = (v.duration_s || 0) > 30;
  return (
    <div className="card card-hover flex flex-col overflow-hidden">
      <div className="relative aspect-[9/16] bg-void">
        {src ? (
          <video src={src} controls preload="metadata" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-faint">no media</div>
        )}
        {tooLong && (
          <span className="absolute left-1.5 top-1.5 rounded bg-bad/80 px-1.5 py-0.5 text-[9px] text-white">&gt;30s</span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-2">
        <div className="flex items-center justify-between text-[10px] text-faint">
          <span>{v.duration_s ? `${Math.round(v.duration_s)}s` : "–"}</span>
          <span>👁 {fmtViews(v.views)}</span>
          {v.views_per_hour ? <span className="text-accent-soft">{Math.round(v.views_per_hour).toLocaleString()}/h</span> : null}
        </div>
        {v.creator && <div className="truncate text-[10px] text-mute">@{v.creator}</div>}
        {v.caption && <div className="line-clamp-2 text-[10px] leading-snug text-mute/80">{v.caption}</div>}
        <div className="mt-auto flex gap-1 pt-1">
          <button onClick={() => onPick(v)} className="btn btn-primary flex-1 px-2 py-1 text-[10px]">✓ pilih ref</button>
          <button onClick={() => onDelete(v)} className="btn btn-ghost px-2 py-1 text-[10px]">✕</button>
        </div>
      </div>
    </div>
  );
}

// PROGRESS STAGES in a row (inbox excluded — that's the refs page)
const ROW_STAGES = [
  { key: "shortlist", label: "Ref" },
  { key: "generating", label: "Generate" },
  { key: "qc", label: "QC" },
  { key: "done", label: "Done" },
];

function PipelineRow({
  v,
  personaId,
  onMove,
  onDelete,
  onGenerate,
  genBusy,
}: {
  v: Video;
  personaId: string;
  onMove: (v: Video, stage: string) => void;
  onDelete: (v: Video) => void;
  onGenerate: (v: Video, engine: string, resolution: string) => void;
  genBusy?: boolean;
}) {
  const [engine, setEngine] = useState("seedance");
  const [resolution, setResolution] = useState("480p");
  const stageIdx = ROW_STAGES.findIndex((s) => s.key === v.stage);
  const refSrc = v.local_ref ? `/api/media/${personaId}/${v.local_ref}` : null;
  const outRel = v.output_1080 || v.output_480;
  const outSrc = outRel ? `/api/media/${personaId}/${outRel}` : null;
  const isGenerating = v.stage === "generating";
  const isDone = v.stage === "done";

  // Box video + label + slot aksi di BAWAH box (box = progress tracker)
  const Col = ({ label, idx, action, children }: { label: string; idx: number; action?: React.ReactNode; children: React.ReactNode }) => {
    const active = idx <= stageIdx;
    return (
      <div className="flex min-w-0 flex-col items-center">
        <div className="relative mx-auto aspect-[9/16] w-full max-h-[340px] max-w-[195px] overflow-hidden rounded-xl border border-edgeSoft bg-void">{children}</div>
        <div className={`mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider ${active ? "text-accent-soft" : "text-faint"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${idx < stageIdx ? "bg-accent" : idx === stageIdx ? "bg-accent shadow-[0_0_6px_rgba(232,177,76,0.6)]" : "bg-edge"} ${genBusy && idx === stageIdx ? "animate-pulse" : ""}`} />
          {label}
        </div>
        {action && <div className="mt-2 flex w-full flex-col gap-1">{action}</div>}
      </div>
    );
  };
  const Vid = ({ s, muted = false }: { s: string; muted?: boolean }) => (
    <video src={s} className="h-full w-full object-contain" controls muted={muted} playsInline preload="metadata" />
  );
  const Empty = ({ t }: { t: string }) => (
    <div className="flex h-full items-center justify-center px-1 text-center text-[9px] text-faint">{t}</div>
  );
  const Loading = () => (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-[9px] text-accent-soft">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />render…
    </div>
  );

  // aksi di bawah REFERENSI (generate) — hanya saat shortlist
  const refAction = v.stage === "shortlist" ? (
    <>
      <div className="flex gap-1">
        <select value={engine} onChange={(e) => setEngine(e.target.value)} disabled={genBusy}
          className="flex-1 rounded border border-edge bg-void px-1 py-1 text-[9px] text-ink focus:border-accent/50 focus:outline-none">
          <option value="seedance">Seedance</option>
          <option value="genjutsu">Genjutsu</option>
          <option value="wan-prime">Wan Prime</option>
        </select>
        <select value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={genBusy}
          className="rounded border border-edge bg-void px-1 py-1 text-[9px] text-ink focus:border-accent/50 focus:outline-none">
          <option value="480p">480p</option>
          <option value="720p">720p</option>
        </select>
      </div>
      <button onClick={() => onGenerate(v, engine, resolution)} disabled={genBusy}
        className="btn btn-primary w-full px-2 py-1 text-[9px] disabled:opacity-40">
        {genBusy ? "Generating…" : `⚡ Generate ${resolution}`}
      </button>
      <button onClick={() => onMove(v, "inbox")} className="text-[9px] text-faint hover:text-mute">↩ inbox</button>
    </>
  ) : null;

  // aksi di bawah QC (OK/revisi/ulang) — saat qc
  const qcAction = v.stage === "qc" ? (
    <>
      <button onClick={() => onMove(v, "done")} className="btn btn-accent w-full px-2 py-1 text-[10px]">OK ✓</button>
      <div className="flex gap-1">
        <button onClick={() => onMove(v, "shortlist")} className="btn btn-ghost flex-1 px-1 py-1 text-[9px]">revisi</button>
        <button onClick={() => onMove(v, "inbox")} className="btn btn-ghost flex-1 px-1 py-1 text-[9px]">ulang</button>
      </div>
    </>
  ) : null;

  // aksi di bawah HASIL (buka video) — saat done
  const hasilAction = v.stage === "done" && outSrc ? (
    <a href={outSrc} target="_blank" className="btn btn-ghost w-full px-2 py-1 text-center text-[9px] text-accent-soft">buka ↗</a>
  ) : null;

  return (
    <div className="card card-hover p-4">
      {v.gen_error && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-bad/30 bg-bad/[0.07] px-3 py-2 text-[11px] text-bad">
          <span className="mt-[1px] shrink-0">⚠</span>
          <span className="leading-snug">{v.gen_error}</span>
        </div>
      )}
      <div className="mx-auto grid max-w-[920px] grid-cols-4 gap-6">
        <Col label="referensi" idx={0} action={refAction}>
          {refSrc ? <Vid s={refSrc} muted /> : <Empty t="no ref" />}
        </Col>
        <Col label="proses" idx={1}>
          {isGenerating ? <Loading /> : outSrc ? <Empty t="✓ selesai" /> : <Empty t="—" />}
        </Col>
        <Col label="qc" idx={2} action={qcAction}>
          {outSrc ? <Vid s={outSrc} /> : isGenerating ? <Loading /> : <Empty t="belum ada" />}
        </Col>
        <Col label="hasil" idx={3} action={hasilAction}>
          {isDone && outSrc ? <Vid s={outSrc} /> : <Empty t={outSrc ? "nunggu OK" : "belum ada"} />}
        </Col>
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
          ? "bg-accent/20 text-accent-soft hover:bg-accent/30"
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
        className="card w-full max-w-md p-6"
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
            className="btn btn-ghost text-xs"
          >
            Batal
          </button>
          <button
            onClick={create}
            disabled={busy}
            className="btn btn-primary disabled:opacity-50"
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
