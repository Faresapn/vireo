"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, pass }),
    });
    setBusy(false);
    if (r.ok) {
      router.push(params.get("next") || "/");
      router.refresh();
    } else {
      const d = await r.json().catch(() => ({}));
      setErr(d.error || "Gagal login");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="animate-scale-in w-full max-w-[380px]">
        {/* brand */}
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-accent-soft to-accent-deep text-[26px] font-bold text-[#241a07] shadow-glow">V</div>
          <div>
            <div className="display text-[24px] font-bold text-ink">Vireo<span className="text-accent">.</span></div>
            <div className="eyebrow mt-1">Autonomous Video Studio</div>
          </div>
        </div>

        {/* card */}
        <form onSubmit={submit} className="card p-6">
          <div className="mb-5 text-center">
            <div className="text-[15px] font-semibold text-ink">Masuk ke Studio</div>
            <div className="mt-1 text-[12px] text-mute">Area terbatas. Login buat lanjut.</div>
          </div>

          <label className="mb-1.5 block eyebrow">Username</label>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="admin@gmail.com"
            autoFocus
            className="input mb-4"
          />

          <label className="mb-1.5 block eyebrow">Password</label>
          <div className="relative mb-4">
            <input
              type={showPass ? "text" : "password"}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="••••••••"
              className="input pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPass((s) => !s)}
              tabIndex={-1}
              title={showPass ? "Sembunyikan" : "Tampilkan"}
              className="absolute right-2 top-1/2 -translate-y-1/2 grid h-7 w-7 place-items-center rounded-lg text-mute transition hover:text-ink"
            >
              {showPass ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              )}
            </button>
          </div>

          {err && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-bad/30 bg-bad/[0.07] px-3 py-2 text-[12px] text-bad">
              <span>⚠</span>{err}
            </div>
          )}

          <button type="submit" disabled={busy} className="btn btn-accent w-full py-2.5 text-[13px] disabled:opacity-50">
            {busy ? "Masuk…" : "Masuk"}
          </button>
        </form>

        <div className="mt-6 text-center text-[11px] text-faint">
          Vireo Studio · akses privat
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-mute">…</div>}>
      <LoginForm />
    </Suspense>
  );
}

