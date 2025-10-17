// api/subtitles.js
import { YoutubeTranscript } from "youtube-transcript";

// --- Helpers: formatting ---
function pad(n, w = 2) { return String(n).padStart(w, "0"); }
function tsSRT(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
}
function tsVTT(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const ms = Math.floor((t - Math.floor(t)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
}
function itemsToSRT(items) {
  return items.map((it, i) => `${i + 1}\n${tsSRT(it.start)} --> ${tsSRT(it.start + (it.duration ?? 2))}\n${it.text}\n`).join("\n");
}
function itemsToVTT(items) {
  return "WEBVTT\n\n" + items.map(it => `${tsVTT(it.start)} --> ${tsVTT(it.start + (it.duration ?? 2))}\n${it.text}\n`).join("\n");
}
function sanitizeText(s) { return (s || "").replace(/\s+/g, " ").trim(); }

// --- A. Jalur 1: youtube-transcript (paling simpel) ---
async function fetchViaLib(videoId, langPref = "auto") {
  let transcript;
  const tryLangs = langPref && langPref !== "auto" ? [langPref, "id", "en"] : ["id", "en"];
  for (const L of tryLangs) {
    try {
      transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: L });
      if (transcript?.length) break;
    } catch {}
  }
  if (!transcript || !transcript.length) {
    try { transcript = await YoutubeTranscript.fetchTranscript(videoId); } catch {}
  }
  if (!transcript || !transcript.length) return null;

  return transcript.map(t => ({
    text: sanitizeText(t.text),
    start: t.offset / 1000,
    duration: t.duration / 1000,
  }));
}

// --- B. Jalur 2: YouTube timedtext (manual + asr) ---
async function fetchTimedTextList(videoId) {
  const url = `https://www.youtube.com/api/timedtext?v=${videoId}&type=list`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const tracks = [];
  const rgx = /<track\b([^>]+)\/>/g;
  let m;
  while ((m = rgx.exec(xml))) {
    const attrs = m[1];
    const get = (k) => {
      const r = new RegExp(`${k}="([^"]*)"`).exec(attrs);
      return r ? r[1] : "";
    };
    tracks.push({
      lang: get("lang_code"),
      name: get("name"),
      kind: get("kind"), // 'asr' untuk auto captions
      vss: get("vss_id")
    });
  }
  return tracks;
}
async function fetchTimedTextTrack(videoId, track, fmt = "vtt") {
  // name perlu URL encode jika ada
  const qs = new URLSearchParams({
    v: videoId,
    lang: track.lang || "en",
    fmt // vtt lebih stabil
  });
  if (track.name) qs.set("name", track.name);
  if (track.kind === "asr") qs.set("kind", "asr");
  const url = `https://www.youtube.com/api/timedtext?${qs}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const text = await res.text();
  if (!text || text.trim().length === 0) return null;

  // Jika fmt=vtt, kita bisa parsing kasar -> items
  // Baris VTT: cue time diikuti teks. Kita sederhanakan parser:
  const lines = text.split(/\r?\n/);
  const items = [];
  let curStart = 0, curEnd = 0, buf = [];
  const timeRgx = /(\d{2}:\d{2}:\d{2}\.\d{3})\s-->\s(\d{2}:\d{2}:\d{2}\.\d{3})/;
  function toSec(hms) {
    const [h, m, sMs] = hms.split(":");
    const [s, ms] = sMs.split(".");
    return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
  }
  for (const ln of lines) {
    const m = timeRgx.exec(ln);
    if (m) {
      // flush previous
      if (buf.length) {
        items.push({ start: curStart, duration: Math.max(0.5, curEnd - curStart), text: sanitizeText(buf.join(" ")) });
        buf = [];
      }
      curStart = toSec(m[1]); curEnd = toSec(m[2]);
      continue;
    }
    if (ln && !/^(WEBVTT|NOTE|STYLE|REGION)/.test(ln)) buf.push(ln);
  }
  if (buf.length) items.push({ start: curStart, duration: Math.max(0.5, curEnd - curStart), text: sanitizeText(buf.join(" ")) });

  return items.length ? items : null;
}
async function fetchViaTimedText(videoId, langPref = "auto") {
  const tracks = await fetchTimedTextList(videoId);
  if (!tracks.length) return null;

  // prioritas: bahasa diminta (kalau ada) -> manual -> asr
  const want = (t) => (langPref !== "auto" && t.lang === langPref);
  const manual = tracks.filter(t => !t.kind);
  const asr = tracks.filter(t => t.kind === "asr");

  let order = [];
  if (langPref !== "auto") order = tracks.filter(want).concat(manual, asr);
  else order = manual.concat(asr);

  for (const tr of order) {
    const items = await fetchTimedTextTrack(videoId, tr, "vtt");
    if (items && items.length) return items;
  }
  return null;
}

// --- HTTP handler (Vercel) ---
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url = String(req.query.url || "");
    const lang = String(req.query.lang || "auto");
    const format = String(req.query.format || "txt"); // txt|srt|vtt
    if (!url) return res.status(400).json({ error: "Missing url" });

    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
    if (!m) return res.status(400).json({ error: "Invalid YouTube URL" });
    const videoId = m[1];

    // 1) coba library
    let items = await fetchViaLib(videoId, lang);

    // 2) fallback timedtext
    if (!items || !items.length) items = await fetchViaTimedText(videoId, lang);

    if (!items || !items.length) {
      return res.status(404).json({ error: "Subtitle not found (manual/auto)" });
    }

    // keluaran
    if (format === "srt") {
      const body = itemsToSRT(items);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${videoId}.srt"`);
      return res.status(200).send(body);
    }
    if (format === "vtt") {
      const body = itemsToVTT(items);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${videoId}.vtt"`);
      return res.status(200).send(body);
    }
    // default txt (digabung)
    const body = items.map(i => i.text).join(" ").trim();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${videoId}.txt"`);
    return res.status(200).send(body);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
}
