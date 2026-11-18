// Dota 2 Replay Viewer: Heldenpositionen über das ganze Spiel (Quelle: STRATZ).
// Supabase Edge Function "drv-pos". Der STRATZ-Token liegt als Secret STRATZ_TOKEN
// im Supabase-Projekt und steht NICHT in dieser Datei.
//
// Aufruf:  GET /functions/v1/drv-pos?match=<Match-ID>
// Antwort: { id, players: [{ h, r, aid, g: [[x,y,n,...], ...4 Zeitabschnitte] }] }
//          x/y = Kartenzelle (64..192, auf 2er-Raster), n = Sekunden an dieser Stelle.
//          Zeitabschnitte: 0–10, 10–20, 20–30, ab 30 Minuten.
// Diagnose: ?probe=<GraphQL-Typname> zeigt die Felder eines Typs,
//           ?match=<ID>&raw=1 zeigt die ersten Rohwerte.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": status === 200 ? "public, max-age=86400" : "no-store" },
  });

async function stratz(query: string) {
  const token = Deno.env.get("STRATZ_TOKEN");
  if (!token) throw new Error("Secret STRATZ_TOKEN fehlt");
  const res = await fetch("https://api.stratz.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "STRATZ_API", Authorization: "Bearer " + token },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { throw new Error("STRATZ " + res.status + ": " + text.slice(0, 200)); }
  if (!res.ok || data.errors) {
    throw new Error("STRATZ " + res.status + ": " + JSON.stringify(data.errors || data).slice(0, 600));
  }
  return data.data;
}

// Weltkoordinaten (-16384..16384) in Kartenzellen (64..192) umrechnen, falls nötig.
const cell = (v: number) => (Math.abs(v) > 300 ? (v + 16384) / 128 : v);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    const probe = url.searchParams.get("probe");
    if (probe) {
      if (!/^[A-Za-z_]{1,60}$/.test(probe)) return json({ error: "Ungültiger Typname" }, 400);
      return json(await stratz(
        `{ __type(name: "${probe}") { name fields { name type { name kind ofType { name kind ofType { name } } } } } }`));
    }

    const id = url.searchParams.get("match") || "";
    if (!/^\d{6,12}$/.test(id)) return json({ error: "Ungültige Match-ID" }, 400);

    const data = await stratz(`{ match(id: ${id}) { id players {
      heroId isRadiant steamAccountId
      playbackData { playerUpdatePositionEvents { time x y } }
    } } }`);
    const m = data.match;
    if (!m) return json({ error: "Match bei STRATZ nicht gefunden" }, 404);

    if (url.searchParams.get("raw")) {
      return json({ id, players: m.players.map((p: any) => ({
        h: p.heroId, r: p.isRadiant, n: (p.playbackData?.playerUpdatePositionEvents || []).length,
        first: (p.playbackData?.playerUpdatePositionEvents || []).slice(0, 5),
        last: (p.playbackData?.playerUpdatePositionEvents || []).slice(-3),
      })) });
    }

    const players = m.players.map((p: any) => {
      // STRATZ meldet nur Positionswechsel. Deshalb zählt jede Position so viele Sekunden,
      // wie der Held dort stand (höchstens 10, damit Todes- und Wartezeiten nicht überwiegen).
      const ev = (p.playbackData?.playerUpdatePositionEvents || [])
        .filter((e: any) => e.x != null && e.y != null)
        .sort((a: any, b: any) => (a.time || 0) - (b.time || 0));
      const maps = [new Map(), new Map(), new Map(), new Map()] as Map<number, number>[];
      ev.forEach((e: any, i: number) => {
        const gx = Math.round(cell(e.x) / 2) * 2, gy = Math.round(cell(e.y) / 2) * 2;
        if (gx < 60 || gx > 196 || gy < 60 || gy > 196) return;
        const next = ev[i + 1];
        const dt = next ? Math.max(1, Math.min(10, (next.time || 0) - (e.time || 0))) : 1;
        const b = Math.max(0, Math.min(3, Math.floor((e.time || 0) / 600)));
        const k = gx * 256 + gy;
        maps[b].set(k, (maps[b].get(k) || 0) + dt);
      });
      return {
        h: p.heroId, r: p.isRadiant ? 1 : 0, aid: p.steamAccountId || 0,
        g: maps.map((mp) => { const out: number[] = []; mp.forEach((n, k) => out.push(k >> 8, k & 255, n)); return out; }),
      };
    });
    const total = players.reduce((s: number, p: any) => s + p.g.reduce((a: number, g: number[]) => a + g.length, 0), 0);
    if (!total) return json({ error: "STRATZ hat für dieses Match keine Positionsdaten" }, 404);
    return json({ id, players });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 502);
  }
});
