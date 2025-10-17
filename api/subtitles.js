// Backend Vercel — ambil subtitle YouTube -> txt/srt/vtt
import { YoutubeTranscript } from "youtube-transcript";

function toSRT(items) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = (t) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms).padStart(3, "0")}`;
  };
  return items
    .map((it, i) => {
      const start = ts(it.start);
      const end = ts(it.start + (it.duration ?? 2));
      return `${i + 1}\n${start} --> ${end}\n${it.text}\n`;
    })
    .join("\n");
}

function toVTT(items) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const ts = (t) => {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.floor((t - Math.floor(t)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
  };
  return (
    "WEBVTT\n\n" +
    items
      .map((it) => {
        const start = ts(it.start);
        const end = ts(it.start + (it.duration ?? 2));
        return `${start} --> ${end}\n${it.text}\n`;
      })
      .join("\n")
  );
}

export default async function handler(req, res) {
  // CORS (biar bisa dipanggil dari Blogspot)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url = String(req.query.url || "");
    const lang = String(req.query.lang || "auto");
    const format = String(req.query.format || "txt"); // txt|srt|vtt
    if (!url) return res.status(400).json({ error: "Missing url" });

    // ambil videoId dari berbagai bentuk URL
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/);
    if (!m) return res.status(400).json({ error: "Invalid YouTube URL" });
    const videoId = m[1];

    // coba manual lang -> fallback auto
    let transcript;
    try {
      if (lang && lang !== "auto") {
        transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
      }
      if (!transcript || transcript.length === 0) {
        transcript = await YoutubeTranscript.fetchTranscript(videoId);
      }
    } catch {
      transcript = null;
    }

    if (!transcript || transcript.length === 0) {
      return res.status(404).json({ error: "Subtitle not found (manual/auto)" });
    }

    const items = transcript.map((t) => ({
      text: (t.text || "").replace(/\s+/g, " ").trim(),
      start: t.offset / 1000,
      duration: t.duration / 1000,
    }));

    if (format === "srt") {
      const body = toSRT(items);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${videoId}.srt"`);
      return res.status(200).send(body);
    }
    if (format === "vtt") {
      const body = toVTT(items);
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="${videoId}.vtt"`);
      return res.status(200).send(body);
    }

    // default txt (digabung)
    const body = items.map((i) => i.text).join(" ").trim();
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${videoId}.txt"`);
    return res.status(200).send(body);
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
}
