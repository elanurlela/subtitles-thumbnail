// api/list.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const url = String(req.query.url || "");
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{11})/);
    if (!m) return res.status(400).json({ error: "Invalid YouTube URL" });
    const videoId = m[1];

    const listUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&type=list&hl=en`;
    const r = await fetch(listUrl);
    if (!r.ok) return res.status(502).json({ error: "timedtext list fetch failed" });
    const xml = await r.text();

    // parse sederhana <track .../>
    const tracks = [];
    const rgx = /<track\b([^>]+)\/>/g;
    let m2;
    while ((m2 = rgx.exec(xml))) {
      const attrs = m2[1];
      const pick = (k) => ((new RegExp(`${k}="([^"]*)"`)).exec(attrs)?.[1]) || "";
      tracks.push({
        lang: pick("lang_code"),
        name: pick("name"),
        kind: pick("kind"), // "asr" = auto captions
        vss: pick("vss_id")
      });
    }

    return res.status(200).json({ videoId, count: tracks.length, tracks });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Internal error" });
  }
}
