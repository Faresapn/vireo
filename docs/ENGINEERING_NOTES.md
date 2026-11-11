# Vireo — Engineering Notes & Changelog

Dokumentasi teknis fitur, perbaikan, dan aturan engine yang sudah terbukti.
Dipelihara per sesi kerja. Paling baru di atas.

---

## 2026-11-04 — Seedance duration rule, persona baru, char-lock, anti-nsfw

### 🔑 Seedance 2.5 reference-to-video — ATURAN DURATION (penting)
Engine `seedance-2.5/reference-to-video` menolak request dengan error
**"Your prompt was interpreted as video editing. The output aspect ratio and
duration must follow the selected input video..."** kalau `duration` **>= panjang
source clip**.

**Aturan yang benar (dibuktikan dari body web app Higgsfield):**
- `duration` harus **STRICTLY LESS THAN** panjang source video.
- Contoh web: source 8.0s → kirim `duration: 7`.
- **Parity tidak relevan** — ganjil (7) diterima. Teori lama "harus genap" SALAH.

**Tabel bukti:**

| source | duration dikirim | dur < source? | hasil |
|--------|------------------|---------------|-------|
| 8.0s   | 7                | ya            | OK    |
| 9.2s   | 8                | ya            | OK    |
| 16.04s | 16               | ya            | OK    |
| 8.0s   | 8                | TIDAK (=)     | FAIL editing |
| 15.0s  | 16               | TIDAK (>)     | FAIL editing |

**Fix di `scripts/generate.mjs`:**
```js
const srcLen = video.duration_s || 5;
const refDur = Math.max(4, Math.ceil(srcLen) - 1); // strictly below source
const wantDur = durArg ? parseInt(durArg, 10) : refDur;
const dur = Math.min(Math.max(wantDur || refDur, 4), 30);
// body seedance-2.5/2.0: duration: Math.min(dur, 30) — TANPA evenDur
```
Body tetap mengirim `aspect_ratio: "9:16"` + `duration` (jangan dihapus — semua job
sukses mengirimnya). `generate_audio: true` + `bitrate_mode: "high"` wajib.

Catatan: error "parameters not supported" itu MASALAH BERBEDA — flaky backend,
solusinya retry 2-3x, bukan utak-atik body.

### 🧍 Character lock — rujuk image eksplisit di master prompt
Master prompt yang cuma mendeskripsikan subjek secara generik ("a young Asian boy")
menghasilkan wajah yang **tidak mirip** reference. Fix: rujuk image slot secara
eksplisit (pola dari persona extreme yang char-lock-nya kuat):

```
The young boy from image 1, image 2, image 3 and image 4 — <detail wajah spesifik:
bentuk wajah, mata, hidung, rambut, ciri khas> ...
... the boy's face, hair, and facial features match image 1, image 2, image 3 and
image 4 from every angle throughout without changing appearance ...
```

Detail wajah spesifik diambil dengan menganalisis foto char (vision) lalu
dimasukkan ke prompt. Terbukti naikkan kemiripan signifikan (persona Denvo, Kaylee).

### 🛡️ Content-safety (nsfw) false-positive
Output bisa di-flag `nsfw` di akhir render walau reference bersih (mis. orang
BMX malam hari berpakaian lengkap — pose membungkuk + cahaya rendah + motion blur
memicu skin-detection false-positive). Dua langkah:
1. **Retry** — false-positive sering flaky, retry 1-2x bisa lolos.
2. Perkuat master prompt dengan sinyal eksplisit: *"fully clothed at all times,
   wholesome and non-sexual, no nudity, no exposed skin, no suggestive poses"*.

### 🆕 Persona baru (Denvo, Kaylee) — langkah setup
1. Crop character sheet (2x2) jadi 4 foto satuan via ffmpeg (`crop=W/2:H/2-cap:x:y`,
   buang caption bar ~70px). Simpan ke `personas/<id>/char/character_1..4.jpg`.
2. Insert `personas` row (param-bind python sqlite3, JANGAN readfile → BLOB).
3. Insert 4 `character_images` (ord 0-3, char_group 1, video_id NULL = persona-wide).
4. `viral_cluster_slug` harus match slug cluster di ViralEngine MCP (mis. `anatoly`,
   `general`), kalau tidak ingest gagal.
5. Ref video: copy dari persona lain ATAU ingest dari MCP.

### 🐛 Bug & catatan operasional
- **Banner error "hantu"**: dashboard menampilkan `gen_error` per-video; error lama
  (dari generate yang sudah gagal berhari lalu) tetap muncul sampai `gen_error`
  di-clear atau video itu di-generate ulang. Bukan generate gagal baru.
- **"dup" saat ingest**: pesan NORMAL — shortcode yang sudah ada di DB di-skip
  (dedup), bukan error.
- **2 persona dengan nama mirip**: cek `id` di DB, bukan nama display. Nama bisa
  sama, id unik. Fallback engine kalau `auto_engine` kosong = `seedance`.
- **ViralEngine MCP**: auth `Authorization: Bearer <key>` di `/mcp`. 401 = key
  revoked (rotasi), 404 "Application not found" = server down sementara (bukan
  masalah key). Token di `~/.viralengine_token`.

---

## Engine cheat-sheet

| Engine | Endpoint | Audio | Duration/Aspect param | Catatan |
|--------|----------|-------|----------------------|---------|
| seedance-2.5 | `/bytedance/seedance-2.5/reference-to-video` | AI-generated (`generate_audio:true`) | ya — `duration` harus < source | workhorse, flaky kadang |
| genjutsu | `/higgsfield/genjutsu/motion-transfer/v1.0` | passthrough audio source | TIDAK ada | stabil, imun error editing |
| wan-prime | — | tidak | ya | sering rewel |

**Auth Higgsfield:** `Authorization: Key <KEY_ID:KEY_SECRET>` (BUKAN Bearer).
Key di `~/.higgsfield_key` (Key A) + `~/.higgsfield_key2` (Key B untuk
seedance/genjutsu).

**Poll:** submit → poll `status_url` tiap 5s sampai `completed`. Limit 240 (~20
menit) untuk render 720p yang lambat. `request_id` disimpan di DB saat submit
(bukan cuma saat sukses) supaya timeout bisa di-recover.

---

## Pitfall: SQLite TEXT column via readfile() → BLOB
`UPDATE personas SET master_prompt=readfile('/tmp/x.txt')` membuat kolom jadi BLOB.
`node:sqlite` lalu mengembalikan Buffer dan `.trim()` throw → job hang di stage
`generating`. Selalu param-bind (python sqlite3 atau prepared statement), atau
`CAST(master_prompt AS TEXT)` untuk memperbaiki. Verifikasi `typeof(master_prompt)`
harus `text`.
