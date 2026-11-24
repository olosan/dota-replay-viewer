// Dota 2 Replay Viewer: Heldenpositionen über das ganze Spiel (Quelle: STRATZ).
// Supabase Edge Function "drv-pos". Der STRATZ-Token liegt als Secret STRATZ_TOKEN
// im Supabase-Projekt und steht NICHT in dieser Datei.
//
// Aufruf:  GET /functions/v1/drv-pos?match=<Match-ID>
// Antwort: { id, players: [{ h, r, aid, g: [[x,y,n,...], ...4 Zeitabschnitte] }] }
//          x/y = Kartenzelle (64..192, auf 2er-Raster), n = Sekunden an dieser Stelle.
//          Zeitabschnitte: 0–10, 10–20, 20–30, ab 30 Minuten.
//
// Liga:    GET /functions/v1/drv-pos?league=<Liga-ID>
// Antwort: { league: { id, name }, teams: [{ id, name, tag, matches: [{ id, start, side, win }] }] }
//          side = 'r' oder 'd' (Seite des Teams in diesem Match), win = Team hat gewonnen.
// Ersatz für OpenDota (wenn api.opendota.com gestört ist), Antworten im OpenDota-Format:
//          ?od=match&id=<Match-ID>        wie /api/matches/<id> (Draft, Spieler, Wards, Lane-Positionen)
//          ?od=player&aid=<Konto>&days=150 wie /api/players/<aid>/matches?lobby_type=1&date=150
//          ?od=heroes                      wie /api/constants/heroes
// Diagnose: ?probe=<GraphQL-Typname> zeigt die Felder eines Typs,
//           ?match=<ID>&raw=1 zeigt die ersten Rohwerte.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200, maxAge = 86400) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": status === 200 ? "public, max-age=" + maxAge : "no-store" },
  });

// Alle Matches einer Liga holen und nach Teams gruppieren.
async function league(id: string) {
  const all: any[] = [];
  let name = "";
  for (let skip = 0; skip < 2000; skip += 100) {
    const d = await stratz(`{ league(id: ${id}) { id displayName name
      matches(request: { skip: ${skip}, take: 100 }) {
        id startDateTime didRadiantWin radiantTeamId direTeamId
        radiantTeam { id name tag } direTeam { id name tag }
      } } }`);
    if (!d.league) throw new Error("Liga bei STRATZ nicht gefunden");
    name = d.league.displayName || d.league.name || name;
    const ms = d.league.matches || [];
    all.push(...ms);
    if (ms.length < 100) break;
  }
  const teams = new Map<number, any>();
  for (const m of all) {
    for (const [side, tid, t] of [["r", m.radiantTeamId, m.radiantTeam], ["d", m.direTeamId, m.direTeam]] as const) {
      if (!tid) continue;
      const e = teams.get(tid) || { id: tid, name: (t && t.name) || ("Team " + tid), tag: (t && t.tag) || null, matches: [] };
      e.matches.push({ id: m.id, start: m.startDateTime || 0, side, win: side === "r" ? !!m.didRadiantWin : !m.didRadiantWin });
      teams.set(tid, e);
    }
  }
  const list = [...teams.values()].sort((a, b) => b.matches.length - a.matches.length || a.name.localeCompare(b.name));
  list.forEach((t) => t.matches.sort((a: any, b: any) => b.start - a.start));
  return { league: { id: Number(id), name }, teams: list };
}

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

// ---------- Ersatz für OpenDota ----------
// Spielmodi von STRATZ (Namen) in OpenDota-Nummern
const MODES: Record<string, number> = {
  NONE: 0, ALL_PICK: 1, CAPTAINS_MODE: 2, RANDOM_DRAFT: 3, SINGLE_DRAFT: 4, ALL_RANDOM: 5, INTRO: 6, THE_DIRETIDE: 7,
  REVERSE_CAPTAINS_MODE: 8, THE_GREEVILING: 9, TUTORIAL: 10, MID_ONLY: 11, LEAST_PLAYED: 12, NEW_PLAYER_POOL: 13,
  COMPENDIUM_MATCHMAKING: 14, CUSTOM: 15, CAPTAINS_DRAFT: 16, BALANCED_DRAFT: 17, ABILITY_DRAFT: 18, EVENT: 19,
  ALL_RANDOM_DEATH_MATCH: 20, SOLO_MID: 21, ALL_PICK_RANKED: 22, TURBO: 23, MUTATION: 24,
};
const mode = (v: unknown) => (typeof v === "number" ? v : MODES[String(v)] ?? null);

async function odMatch(id: string) {
  const d = await stratz(`{ match(id: ${id}) {
    id didRadiantWin durationSeconds startDateTime gameMode leagueId league { displayName name }
    radiantTeamId radiantTeam { name } direTeamId direTeam { name }
    pickBans { isPick heroId bannedHeroId order isRadiant }
    playbackData { wardEvents { indexId time positionX positionY fromPlayer wardType action playerDestroyed } }
    players { playerSlot steamAccountId isRadiant heroId kills hero { name } steamAccount { name }
      playbackData { playerUpdatePositionEvents { time x y } } }
  } }`);
  const m = d.match;
  if (!m || !m.players) return null;
  const players = [...m.players].sort((a: any, b: any) => (a.playerSlot ?? 0) - (b.playerSlot ?? 0));
  const slot = (p: any, i: number) => p.playerSlot ?? (p.isRadiant ? i : 128 + i - 5);
  // Wer hat die Ward gesetzt/zerstört: STRATZ nennt den Spieler als Index 0–9 (oder als Slot ab 128).
  const who = (n: any) => n == null ? null : n >= 128 ? players.find((p: any) => p.playerSlot === n)
    : players[n] || null;
  const out = players.map((p: any, i: number) => ({
    match_id: m.id, player_slot: slot(p, i), account_id: p.steamAccountId || null, hero_id: p.heroId,
    personaname: p.steamAccount?.name || null, kills: p.kills || 0,
    lane_pos: lanePos(p.playbackData?.playerUpdatePositionEvents || []),
    obs_log: [] as any[], obs_left_log: [] as any[], sen_log: [] as any[], sen_left_log: [] as any[],
  }));
  const wards = m.playbackData?.wardEvents;
  const spawned = new Map<number, any>(); // indexId -> Spieler, der die Ward gesetzt hat
  (wards || []).slice().sort((a: any, b: any) => a.time - b.time).forEach((w: any) => {
    const obs = String(w.wardType).toUpperCase().startsWith("OBS");
    const x = cell(w.positionX), y = cell(w.positionY);
    if (String(w.action).toUpperCase() === "SPAWN") {
      const p = who(w.fromPlayer);
      const o = p && out[players.indexOf(p)];
      if (!o) return;
      spawned.set(w.indexId, o);
      (obs ? o.obs_log : o.sen_log).push({ time: w.time, x, y, ehandle: w.indexId });
    } else {
      const o = spawned.get(w.indexId);
      if (!o) return;
      const k = who(w.playerDestroyed);
      (obs ? o.obs_left_log : o.sen_left_log).push({ time: w.time, x, y, ehandle: w.indexId,
        attackername: k?.hero?.name || null });
    }
  });
  // Ohne Ward-Daten gilt das Match wie bei OpenDota als nicht ausgewertet.
  if (!wards || !wards.length) out.forEach((o: any) => { delete o.obs_log; delete o.obs_left_log; delete o.sen_log; delete o.sen_left_log; });
  const score = (r: boolean) => out.filter((o: any) => (o.player_slot < 128) === r).reduce((s: number, o: any) => s + o.kills, 0);
  return {
    match_id: m.id, start_time: m.startDateTime || 0, duration: m.durationSeconds || 0,
    radiant_win: !!m.didRadiantWin, radiant_score: score(true), dire_score: score(false),
    game_mode: mode(m.gameMode), leagueid: m.leagueId || 0,
    league: m.league ? { name: m.league.displayName || m.league.name || null } : null,
    radiant_team_id: m.radiantTeamId || null, dire_team_id: m.direTeamId || null,
    radiant_team: m.radiantTeam ? { name: m.radiantTeam.name } : null, dire_team: m.direTeam ? { name: m.direTeam.name } : null,
    radiant_name: m.radiantTeam?.name || null, dire_name: m.direTeam?.name || null,
    picks_bans: (m.pickBans || []).filter((b: any) => (b.heroId || b.bannedHeroId) && b.isRadiant != null)
      .map((b: any, i: number) => ({ hero_id: b.heroId || b.bannedHeroId, team: b.isRadiant ? 0 : 1, is_pick: !!b.isPick, order: b.order ?? i })),
    players: out, source: "stratz",
  };
}
// Lane-Positionen der ersten 10 Minuten wie bei OpenDota: { x: { y: Sekunden } }
function lanePos(ev: any[]) {
  const lp: Record<number, Record<number, number>> = {};
  const list = ev.filter((e) => e.x != null && e.y != null).sort((a, b) => (a.time || 0) - (b.time || 0));
  list.forEach((e, i) => {
    if ((e.time || 0) >= 600) return;
    const x = Math.round(cell(e.x)), y = Math.round(cell(e.y));
    const next = list[i + 1];
    const dt = next ? Math.max(1, Math.min(10, Math.min(600, next.time || 0) - (e.time || 0))) : 1;
    (lp[x] ||= {})[y] = (lp[x][y] || 0) + dt;
  });
  return Object.keys(lp).length ? lp : null;
}
async function odPlayer(aid: string, days: number) {
  const from = Math.floor(Date.now() / 1000) - days * 86400;
  const d = await stratz(`{ player(steamAccountId: ${aid}) {
    matches(request: { lobbyTypeIds: [1], startDateTime: ${from}, take: 100 }) { id startDateTime gameMode leagueId } } }`);
  return (d.player?.matches || []).map((m: any) => ({
    match_id: m.id, start_time: m.startDateTime || 0, game_mode: mode(m.gameMode), leagueid: m.leagueId || null, lobby_type: 1,
  }));
}
async function odHeroes() {
  const d = await stratz(`{ constants { heroes { id name displayName shortName } } }`);
  const out: Record<string, any> = {};
  (d.constants?.heroes || []).forEach((h: any) => {
    const short = h.shortName || String(h.name || "").replace("npc_dota_hero_", "");
    out[h.id] = { id: h.id, name: h.name, localized_name: h.displayName,
      img: "/apps/dota2/images/dota_react/heroes/" + short + ".png?", icon: "/apps/dota2/images/dota_react/heroes/icons/" + short + ".png?" };
  });
  return out;
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
        `{ __type(name: "${probe}") { name fields { name args { name type { name kind ofType { name } } } type { name kind ofType { name kind ofType { name } } } } inputFields { name type { name kind ofType { name } } } } }`));
    }

    const od = url.searchParams.get("od");
    if (od === "heroes") return json(await odHeroes(), 200, 86400);
    if (od === "player") {
      const aid = url.searchParams.get("aid") || "";
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 150));
      if (!/^\d{1,12}$/.test(aid)) return json({ error: "Ungültiges Konto" }, 400);
      return json(await odPlayer(aid, days), 200, 600);
    }
    if (od === "match") {
      const mid = url.searchParams.get("id") || "";
      if (!/^\d{6,12}$/.test(mid)) return json({ error: "Ungültige Match-ID" }, 400);
      const m = await odMatch(mid);
      if (!m) return json({ error: "Match bei STRATZ nicht gefunden" }, 404);
      if (url.searchParams.get("raw")) {
        const raw = await stratz(`{ match(id: ${mid}) { playbackData { wardEvents { indexId time positionX positionY fromPlayer wardType action playerDestroyed } } players { playerSlot heroId } pickBans { isPick heroId bannedHeroId order isRadiant } } }`);
        return json({ converted: { ...m, players: m.players.map((p: any) => ({ ...p, lane_pos: p.lane_pos ? Object.keys(p.lane_pos).length + " Spalten" : null })) },
          wards: raw.match?.playbackData?.wardEvents?.slice(0, 12), slots: raw.match?.players, pickBans: raw.match?.pickBans }, 200, 0);
      }
      return json(m, 200, 86400);
    }

    const lg = url.searchParams.get("league");
    if (lg) {
      if (!/^\d{1,9}$/.test(lg)) return json({ error: "Ungültige Liga-ID" }, 400);
      return json(await league(lg), 200, 600);
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
