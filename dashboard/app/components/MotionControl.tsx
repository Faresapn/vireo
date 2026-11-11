"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type MotionImage = { id: number; rel_path: string; ord: number; label: string | null; width: number; height: number };
type MotionJob = {
  id: number;
  title: string | null;
  stage: string;
  ref_source: string | null;
  ref_cluster: string | null;
  ref_shortcode: string | null;
  local_ref: string | null;
  duration_s: number | null;
  main_char: string | null;
  prompt: string | null;
  engine: string | null;
  resolution: string | null;
  gen_audio: number;
  output_path: string | null;
  gen_error: string | null;
  saved_persona: string | null;
  img_count?: number;
  images?: MotionImage[];
};

const ENGINES = [
  { v: "wan-prime", label: "Wan Prime" },
  { v: "seedance-2.5", label: "Seedance 2.5" },
  { v: "genjutsu", label: "Genjutsu" },
];
const SPEEDS = [0.25, 0.5, 1];

export default function MotionControl() {
  const [jobs, setJobs] = useState<MotionJob[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/motion", { cache: "no-store" });
    const d = await r.json();
    setJobs(d.jobs || []);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function createJob() {
    const r = await fetch("/api/motion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Motion job baru" }) });
    const d = await r.json();
    await load();
    setOpenId(d.id);
  }

  if (openId != null) {
    return <JobEditor jobId={openId} onBack={() => { setOpenId(null); load(); }} onChange={load} />;
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-6 py-6">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <div className="eyebrow">Motion Control</div>
          <h1 className="display mt-1 text-[22px] font-bold text-ink">Motion Control</h1>
          <div className="mt-1 text-[11px] text-faint">
            Ref video + gambar karakter → LLM nulis prompt per-scene → generate (Wan Prime / Seedance 2.5 / Genjutsu). Bebas, gak keiket master prompt.
          </div>
        </div>
        <button onClick={createJob} className="btn btn-accent px-4 py-2 text-sm">+ Job Baru</button>
      </div>

      {jobs.length === 0 ? (
        <div className="card py-16 text-center text-sm text-mute">Belum ada job. Klik <span className="text-accent-soft">+ Job Baru</span>.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {jobs.map((j) => (
            <button key={j.id} onClick={() => setOpenId(j.id)}
              className="card card-hover p-4 text-left">
              <div className="flex items-center justify-between">
                <span className="truncate text-[13px] font-semibold text-ink">{j.title || `Job ${j.id}`}</span>
                <StageBadge stage={j.stage} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-faint">
                <span className="rounded bg-raise px-1.5 py-0.5">{ENGINES.find((e) => e.v === j.engine)?.label || j.engine}</span>
                <span className="rounded bg-raise px-1.5 py-0.5">{j.resolution}</span>
                {j.duration_s ? <span className="rounded bg-raise px-1.5 py-0.5">{Math.round(j.duration_s)}s</span> : null}
                <span className="rounded bg-raise px-1.5 py-0.5">{j.img_count || 0} img</span>
              </div>
              {j.gen_error && <div className="mt-2 text-[10px] text-bad">⚠ {j.gen_error}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StageBadge({ stage }: { stage: string }) {
  const map: Record<string, string> = {
    draft: "bg-edge text-sub",
    prompting: "bg-accent/20 text-accent-soft",
    ready: "bg-accent text-[#241a07]",
    generating: "bg-accent/20 text-accent-soft animate-pulse",
    qc: "bg-accent text-[#241a07]",
    done: "bg-ok/20 text-ok",
  };
  return <span className={`rounded px-2 py-0.5 text-[9px] font-bold uppercase ${map[stage] || "bg-edge"}`}>{stage}</span>;
}

function JobEditor({ jobId, onBack, onChange }: { jobId: number; onBack: () => void; onChange: () => void }) {
  const [job, setJob] = useState<MotionJob | null>(null);
  const [clusters, setClusters] = useState<{ slug: string; name: string }[]>([]);
  const [personas, setPersonas] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [speed, setSpeed] = useState(1);
  const [savePersona, setSavePersona] = useState("");
  const vref = useRef<HTMLVideoElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/motion/${jobId}`, { cache: "no-store" });
    const d = await r.json();
    setJob(d);
    setPromptDraft(d.prompt || "");
  }, [jobId]);
  useEffect(() => {
    load();
    fetch("/api/clusters", { cache: "no-store" }).then((r) => r.json()).then((d) => setClusters(d.clusters || [])).catch(() => {});
    fetch("/api/personas", { cache: "no-store" }).then((r) => r.json()).then((d) => setPersonas((d || []).map((p: any) => ({ id: p.id, name: p.name })))).catch(() => {});
  }, [load]);
  // poll while generating
  useEffect(() => {
    if (job?.stage !== "generating") return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [job?.stage, load]);

  async function patch(fields: any) {
    await fetch(`/api/motion/${jobId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
    await load(); onChange();
  }

  async function uploadRefFile(file: File) {
    setBusy("ref"); setMsg(null);
    const fd = new FormData(); fd.append("file", file);
    const r = await fetch(`/api/motion/${jobId}/ref`, { method: "POST", body: fd });
    const d = await r.json();
    setBusy(null); setMsg(d.error ? "✗ " + d.error : `ref ${Math.round(d.duration_s)}s ✓`);
    await load(); onChange();
  }

  async function uploadImage(file: File) {
    setBusy("img"); setMsg(null);
    const fd = new FormData(); fd.append("file", file);
    const r = await fetch(`/api/motion/${jobId}/image`, { method: "POST", body: fd });
    const d = await r.json();
    setBusy(null); if (d.error) setMsg("✗ " + d.error); else if (d.warn) setMsg(d.warn);
    await load();
  }
  async function delImage(imgId: number) {
    await fetch(`/api/motion/${jobId}/image?img=${imgId}`, { method: "DELETE" });
    await load();
  }

  async function runPrompt() {
    setBusy("prompt"); setMsg("LLM nonton video + nulis prompt… (bisa ~1 menit)");
    const r = await fetch(`/api/motion/${jobId}/prompt`, { method: "POST" });
    const d = await r.json();
    setBusy(null);
    if (d.error) setMsg("✗ " + d.error);
    else { setMsg("prompt ter-generate ✓ — review & edit di bawah"); setPromptDraft(d.prompt); await load(); }
  }

  async function doGenerate() {
    if (!confirm("Generate sekarang? Ini pakai kredit Higgsfield (duit asli).")) return;
    await patch({ prompt: promptDraft }); // save edits first
    setBusy("gen"); setMsg(null);
    const r = await fetch(`/api/motion/${jobId}/generate`, { method: "POST" });
    const d = await r.json();
    setBusy(null);
    if (d.error) { setMsg("✗ " + d.error); await load(); return; }
    setMsg("⚡ submit… nunggu engine");
    await load();
    // Generate runs detached; submit-fail happens a moment later. Poll a few
    // times so a fast failure (e.g. invalid creds) surfaces instead of looking idle.
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 2500));
      const jr = await fetch(`/api/motion/${jobId}`, { cache: "no-store" });
      const jd = await jr.json();
      setJob(jd);
      if (jd.gen_error) { setMsg("✗ Gagal: " + jd.gen_error); break; }
      if (jd.stage === "generating") { setMsg("⚡ render jalan… auto-refresh"); break; }
      if (jd.stage === "qc" || jd.output_path) { setMsg("✓ selesai — cek hasil di bawah"); break; }
    }
    onChange();
  }

  async function saveToPersona() {
    if (!savePersona) { setMsg("pilih persona dulu"); return; }
    setBusy("save");
    const r = await fetch(`/api/motion/${jobId}/save`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persona_id: savePersona }) });
    const d = await r.json();
    setBusy(null);
    setMsg(d.error ? "✗ " + d.error : "tersimpan ke persona ✓");
    await load(); onChange();
  }

  function setRate(r: number) { setSpeed(r); if (vref.current) vref.current.playbackRate = r; }

  if (!job) return <div className="p-6 text-sm text-mute">Memuat…</div>;

  const refUrl = job.local_ref ? `/api/motion-media/${jobId}/${job.local_ref}` : null;
  const outUrl = job.output_path ? `/api/motion-media/${jobId}/${job.output_path}` : null;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
      <button onClick={onBack} className="btn btn-ghost mb-4 px-3 py-1.5 text-[12px]">‹ Kembali ke daftar</button>

      <div className="mb-4 flex items-center justify-between">
        <input
          value={job.title || ""}
          onChange={(e) => setJob({ ...job, title: e.target.value })}
          onBlur={() => patch({ title: job.title })}
          className="display bg-transparent text-[20px] font-bold text-ink focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <StageBadge stage={job.stage} />
          <button onClick={async () => { if (confirm("Hapus job ini?")) { await fetch(`/api/motion/${jobId}`, { method: "DELETE" }); onBack(); } }}
            className="btn btn-ghost px-2 py-1 text-[11px] text-bad">Hapus</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* LEFT: inputs */}
        <div className="space-y-4">
          {/* STEP 1: ref video */}
          <div className="card p-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-accent-soft">1 · Video Referensi</div>
            {refUrl ? (
              <div className="space-y-2">
                <video src={refUrl} controls className="aspect-[9/16] w-full rounded bg-void object-contain" />
                <div className="text-[10px] text-faint">{job.ref_source} · {Math.round(job.duration_s || 0)}s</div>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="btn btn-ghost block w-full cursor-pointer px-2 py-2 text-center text-[11px]">
                  ⬆ Upload video manual
                  <input type="file" accept="video/*" className="hidden" disabled={busy === "ref"}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadRefFile(f); e.currentTarget.value = ""; }} />
                </label>
                <ViralPicker jobId={jobId} clusters={clusters} onDone={() => { load(); onChange(); }} />
              </div>
            )}
          </div>

          {/* STEP 2: character images */}
          <div className="card p-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-accent-soft">2 · Gambar Karakter (urut: Image 1 = main)</div>
            <input
              value={job.main_char || ""}
              onChange={(e) => setJob({ ...job, main_char: e.target.value })}
              onBlur={() => patch({ main_char: job.main_char })}
              placeholder="Main character (Image 1) — wajib, mis. 'kura-kura sulcata'"
              className="mb-2 w-full rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
            />
            <div className="flex flex-wrap gap-2">
              {(job.images || []).map((im, i) => (
                <div key={im.id} className="group relative">
                  <img src={`/api/motion-media/${jobId}/${im.rel_path}`} className="h-14 w-14 rounded object-cover" />
                  <span className="absolute left-0 top-0 rounded-br bg-black/70 px-1 text-[8px] text-white">#{i + 1}</span>
                  <button onClick={() => delImage(im.id)}
                    className="absolute -right-1 -top-1 hidden h-4 w-4 place-items-center rounded-full bg-bad text-[9px] text-white group-hover:grid">×</button>
                </div>
              ))}
              {(job.images?.length || 0) < 8 && (
                <label className="grid h-14 w-14 cursor-pointer place-items-center rounded border border-dashed border-edge text-faint hover:border-accent/50 hover:text-accent">
                  +
                  <input type="file" accept="image/*" className="hidden" disabled={busy === "img"}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.currentTarget.value = ""; }} />
                </label>
              )}
            </div>
            <div className="mt-1 text-[9px] text-faint">{job.images?.length || 0}/8 — Image 1 = karakter utama, sisanya pendamping (LLM petain)</div>
          </div>

          {/* STEP 3: engine/res */}
          <div className="card p-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-accent-soft">3 · Model & Resolusi</div>
            <div className="flex gap-2">
              <select value={job.engine || "wan-prime"} onChange={(e) => patch({ engine: e.target.value })}
                className="flex-1 rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-ink focus:border-accent/50 focus:outline-none">
                {ENGINES.map((e) => <option key={e.v} value={e.v}>{e.label}</option>)}
              </select>
              <select value={job.resolution || "720p"} onChange={(e) => patch({ resolution: e.target.value })}
                className="rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-ink focus:border-accent/50 focus:outline-none">
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
              </select>
            </div>
          </div>
        </div>

        {/* RIGHT: prompt + generate + output */}
        <div className="space-y-4">
          {/* STEP 4: vision prompt */}
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-wide text-accent-soft">4 · Prompt (LLM nulis, bisa diedit)</div>
              <button onClick={runPrompt} disabled={busy === "prompt" || !job.local_ref || !(job.images?.length)}
                className="btn btn-ghost px-2 py-1 text-[10px] disabled:opacity-40">
                {busy === "prompt" ? "…" : "🧠 Generate Prompt"}
              </button>
            </div>
            <textarea
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              onBlur={() => patch({ prompt: promptDraft })}
              rows={10}
              placeholder="Klik 'Generate Prompt' — LLM nonton video per 2 detik, nulis timeline + swap karakter. Hasilnya muncul di sini & bisa kamu edit sebelum generate."
              className="w-full rounded border border-edge bg-void px-2 py-1.5 text-[10px] leading-relaxed text-ink placeholder:text-faint focus:border-accent/50 focus:outline-none"
            />
          </div>

          {/* STEP 5: generate */}
          <div className="card p-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-accent-soft">5 · Generate</div>
            <button onClick={doGenerate} disabled={busy === "gen" || job.stage === "generating" || !promptDraft.trim()}
              className="btn btn-accent w-full px-2 py-2 text-[12px] disabled:opacity-40">
              {job.stage === "generating" ? "⏳ Generating…" : busy === "gen" ? "⏳ Submit…" : "⚡ Generate Video"}
            </button>
            {job.stage === "generating" && (
              <div className="mt-2 text-center text-[10px] text-accent-soft">render jalan… auto-refresh tiap 5 detik</div>
            )}
            {job.gen_error && job.stage !== "generating" && (
              <div className="mt-2 rounded border border-bad/30 bg-bad/[0.07] px-2 py-1.5 text-[10px] text-bad">⚠ Gagal: {job.gen_error}</div>
            )}
          </div>

          {/* OUTPUT + QC + save */}
          {outUrl && (
            <div className="card p-4">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-accent-soft">Hasil · QC</div>
              <div className="relative">
                <video ref={vref} src={outUrl} controls playsInline className="aspect-[9/16] w-full rounded bg-void object-contain"
                  onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).playbackRate = speed; }} />
                <div className="absolute left-2 top-2 flex gap-1 rounded-lg bg-black/60 p-0.5 backdrop-blur">
                  {SPEEDS.map((r) => (
                    <button key={r} onClick={() => setRate(r)}
                      className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${speed === r ? "bg-accent text-[#241a07]" : "text-white/70"}`}>{r}×</button>
                  ))}
                </div>
              </div>
              {job.stage !== "done" ? (
                <div className="mt-3 space-y-2">
                  <div className="text-[10px] text-faint">OK? Simpan ke persona:</div>
                  <div className="flex gap-2">
                    <select value={savePersona} onChange={(e) => setSavePersona(e.target.value)}
                      className="flex-1 rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-ink focus:border-accent/50 focus:outline-none">
                      <option value="">Pilih persona…</option>
                      {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    <button onClick={saveToPersona} disabled={busy === "save" || !savePersona}
                      className="btn btn-accent px-3 py-1.5 text-[11px] disabled:opacity-40">OK ✓ Simpan</button>
                  </div>
                </div>
              ) : (
                <div className="mt-3 rounded bg-ok/15 px-2 py-1.5 text-[10px] text-ok">✓ Tersimpan ke persona: {job.saved_persona}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {msg && <div className="mt-4 text-center text-[11px] text-accent-soft">{msg}</div>}
    </div>
  );
}

// Viral ref picker: choose cluster -> list items -> pick one -> download as ref
function ViralPicker({ jobId, clusters, onDone }: { jobId: number; clusters: { slug: string; name: string }[]; onDone: () => void }) {
  const [cluster, setCluster] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  async function loadItems(slug: string) {
    setCluster(slug); setItems([]);
    if (!slug) return;
    setBusy(true);
    const r = await fetch(`/api/clusters/${slug}/items`, { cache: "no-store" }).catch(() => null);
    setBusy(false);
    if (r && r.ok) { const d = await r.json(); setItems(d.items || []); }
  }

  async function pick(it: any) {
    setBusy(true);
    const r = await fetch(`/api/motion/${jobId}/ref`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_url: it.source_url || it.url, shortcode: it.shortcode, cluster }),
    });
    setBusy(false);
    if (r.ok) onDone();
  }

  return (
    <div className="rounded border border-edge p-2">
      <div className="mb-1 text-[10px] text-faint">atau tarik dari viral:</div>
      <select value={cluster} onChange={(e) => loadItems(e.target.value)}
        className="w-full rounded border border-edge bg-void px-2 py-1.5 text-[11px] text-ink focus:border-accent/50 focus:outline-none">
        <option value="">Pilih cluster…</option>
        {clusters.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
      </select>
      {busy && <div className="mt-2 text-[10px] text-mute">loading…</div>}
      {items.length > 0 && (
        <div className="mt-2 grid max-h-48 grid-cols-3 gap-1 overflow-y-auto">
          {items.map((it, i) => (
            <button key={i} onClick={() => pick(it)} disabled={busy}
              className="rounded border border-edge p-1 text-[8px] text-faint hover:border-accent/50 hover:text-accent">
              {it.shortcode || `#${i + 1}`}
              {it.duration_s ? <div>{Math.round(it.duration_s)}s</div> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
