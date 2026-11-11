"use client";

import { useCallback, useEffect, useState } from "react";

type KeyInfo = {
  slot: "wan" | "seedance";
  file: string;
  engines: string;
  set: boolean;
  masked: string | null;
  updated: string | null;
  status?: "valid" | "invalid" | "unknown";
};

const TITLE: Record<KeyInfo["slot"], string> = {
  wan: "API Key Wan",
  seedance: "API Key Seedance",
};

const STATUS: Record<NonNullable<KeyInfo["status"]>, { text: string; cls: string }> = {
  valid: { text: "aktif", cls: "bg-ok/15 text-ok" },
  invalid: { text: "ditolak", cls: "bg-bad/15 text-bad" },
  unknown: { text: "gak bisa dicek", cls: "bg-warn/15 text-warn" },
};

export default function SettingsPage() {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const r = await fetch("/api/settings/keys?check=1", { cache: "no-store" });
    const j = await r.json();
    setKeys(j.keys || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-6">
      <div className="mb-5">
        <div className="eyebrow">Settings</div>
        <h1 className="display mt-1 text-[22px] font-bold text-ink">API Key Higgsfield</h1>
        <div className="mt-1 text-[11px] text-faint">
          Key dicek ke Higgsfield dulu sebelum disimpan. Berlaku untuk render berikutnya; render yang lagi jalan tetap pakai key lama.
        </div>
      </div>
      {loading ? (
        <div className="card py-16 text-center text-sm text-mute">Memuat…</div>
      ) : (
        <div className="space-y-4">
          {keys.map((k) => <KeyCard key={k.slot} info={k} onSaved={load} />)}
        </div>
      )}
    </div>
  );
}

function KeyCard({ info, onSaved }: { info: KeyInfo; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/settings/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slot: info.slot, key: value }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.error || "Gagal simpan" }); return; }
    setValue("");
    setMsg({ ok: true, text: j.status === "valid" ? "Tersimpan, key aktif." : "Tersimpan, tapi Higgsfield gak bisa dihubungi buat cek." });
    onSaved();
  }

  const st = info.status ? STATUS[info.status] : null;
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold text-ink">{TITLE[info.slot]}</div>
          <div className="mt-0.5 text-[11px] text-faint">Dipakai: {info.engines}</div>
        </div>
        {st && <span className={`rounded-md px-2 py-1 text-[11px] font-semibold ${st.cls}`}>{st.text}</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-sub">
        <span>Sekarang: <span className="font-mono text-ink">{info.masked || "belum diisi"}</span></span>
        {info.updated && <span className="text-faint">diubah {new Date(info.updated).toLocaleString("id-ID")}</span>}
        <span className="font-mono text-faint">{info.file}</span>
      </div>

      <div className="mt-4 flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="input flex-1 font-mono text-[12px]"
          placeholder="Tempel key baru: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:secret"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim() && !busy) save(); }}
        />
        <button className="btn btn-accent shrink-0" disabled={!value.trim() || busy} onClick={save}>
          {busy ? "Ngecek…" : "Simpan"}
        </button>
      </div>
      {msg && <div className={`mt-2 text-[12px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</div>}
    </div>
  );
}
