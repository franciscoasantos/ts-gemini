// Integração com o backend do TS6 Manager: pedir pro bot de música tocar algo.
const BASE = process.env.MANAGER_URL || "http://backend:3001/api";
const USER = process.env.MANAGER_USER;
const PASS = process.env.MANAGER_PASS;
const BOT_NAME = (process.env.MUSIC_BOT_NAME || "DJ Morri").toLowerCase();

let token: string | null = null;
let botId: number | null = null;
let configId: number | null = null;

async function login(): Promise<void> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!r.ok) throw new Error(`login ${r.status}`);
  token = (await r.json()).accessToken;
  if (!token) throw new Error("login sem accessToken");
}

async function api(path: string, init: RequestInit, retry = true): Promise<Response> {
  if (!token) await login();
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (r.status === 401 && retry) {
    token = null;
    return api(path, init, false);
  }
  return r;
}

async function findBot(): Promise<{ id: number; configId: number }> {
  if (botId != null && configId != null) return { id: botId, configId };
  const r = await api("/music-bots", { method: "GET" });
  if (!r.ok) throw new Error(`music-bots ${r.status}`);
  const list = await r.json();
  const bot = (Array.isArray(list) ? list : []).find((b: any) =>
    String(b.name || "").toLowerCase().includes(BOT_NAME)
  );
  if (!bot) throw new Error(`bot de música "${process.env.MUSIC_BOT_NAME}" não encontrado`);
  botId = bot.id;
  configId = bot.serverConfig?.id ?? bot.serverConfigId ?? null;
  return { id: botId!, configId: configId! };
}

async function ok(r: Response, what: string) {
  if (!r.ok) throw new Error(`${what} ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r;
}

// Controles simples (sem corpo): skip, stop-playback, pause, resume, previous.
async function control(path: string): Promise<void> {
  const { id } = await findBot();
  await ok(await api(`/music-bots/${id}/${path}`, { method: "POST" }), path);
}
export const skip = () => control("skip");
export const stop = () => control("stop-playback");
export const pause = () => control("pause");
export const resume = () => control("resume");
export const previous = () => control("previous");

function requireCreds() {
  if (!USER || !PASS) throw new Error("MANAGER_USER/MANAGER_PASS não configurados no .env");
}

// Toca já (interrompe o atual) uma música pelo nome. Retorna o título.
export async function playMusic(query: string): Promise<string> {
  requireCreds();
  const { id } = await findBot();
  const r = await ok(
    await api(`/music-bots/${id}/play-url`, { method: "POST", body: JSON.stringify({ url: `ytsearch1:${query}` }) }),
    "play-url"
  );
  const j: any = await r.json().catch(() => ({}));
  return j?.queueItem?.title || query;
}

// Toca a música AGORA sem perder a fila: anota as próximas, adiciona e toca a nova,
// e re-enfileira as próximas depois dela. (O Manager não tem "inserir como próxima".)
export async function playNowKeepQueue(query: string): Promise<void> {
  requireCreds();
  const { id } = await findBot();
  // snapshot das próximas (só itens com id de biblioteca, que dá pra re-enfileirar)
  const st: any = await (await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state")).json();
  const items: any[] = st.queue || [];
  const np = st.nowPlaying?.title || null;
  let idx = typeof st.currentIndex === "number" && st.currentIndex >= 0 ? st.currentIndex : np ? items.map((i) => i.title).lastIndexOf(np) : -1;
  const reAddIds: string[] = (idx >= 0 ? items.slice(idx + 1) : []).map((i) => String(i.id)).filter((x) => /^\d+$/.test(x));

  await enqueueMusic(query); // adiciona a nova no fim (id de biblioteca)
  const q2: any = await (await ok(await api(`/music-bots/${id}/queue`, { method: "GET" }), "queue")).json();
  const last = (q2.items || []).length - 1;
  if (last >= 0) await ok(await api(`/music-bots/${id}/queue/${last}/play`, { method: "POST" }), "queue-play");
  for (const sid of reAddIds) {
    await api(`/music-bots/${id}/queue`, { method: "POST", body: JSON.stringify({ songId: sid }) }).catch(() => {});
  }
}

// O que está tocando + só as PRÓXIMAS músicas (depois do índice atual; a fila do Manager
// guarda também as já tocadas).
export async function getQueue(): Promise<{ nowPlaying: string | null; upcoming: string[] }> {
  requireCreds();
  const { id } = await findBot();
  const r = await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state");
  const s: any = await r.json();
  const titles: string[] = (s.queue || []).map((i: any) => i.title || "?");
  const nowPlaying = s.nowPlaying?.title || null;
  // currentIndex costuma vir -1; localiza a música atual pelo título (as já tocadas ficam antes).
  let idx = typeof s.currentIndex === "number" && s.currentIndex >= 0 ? s.currentIndex : -1;
  if (idx < 0 && nowPlaying) idx = titles.lastIndexOf(nowPlaying);
  const upcoming = idx >= 0 ? titles.slice(idx + 1) : [];
  return { nowPlaying, upcoming };
}

// Remove da fila (dentre as próximas) a primeira música cujo título casa com a busca.
export async function removeFromQueue(query: string): Promise<string> {
  requireCreds();
  const { id } = await findBot();
  const st: any = await (await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state")).json();
  const items: any[] = st.queue || [];
  const np = st.nowPlaying?.title || null;
  const idx = typeof st.currentIndex === "number" && st.currentIndex >= 0 ? st.currentIndex : np ? items.map((i) => i.title).lastIndexOf(np) : -1;
  const n = query.toLowerCase().trim();
  let found = -1;
  for (let i = idx + 1; i < items.length; i++) {
    if (String(items[i].title || "").toLowerCase().includes(n)) {
      found = i;
      break;
    }
  }
  if (found < 0) throw new Error(`"${query}" não está na fila`);
  const title = items[found].title || query;
  await ok(await api(`/music-bots/${id}/queue/${found}`, { method: "DELETE" }), "remove");
  return title;
}

// true se já tem algo tocando/pausado → um "tocar" deve enfileirar em vez de atropelar.
export async function shouldQueue(): Promise<boolean> {
  requireCreds();
  const { id } = await findBot();
  const r = await ok(await api(`/music-bots/${id}/state`, { method: "GET" }), "state");
  const s: any = await r.json();
  return s.status === "playing" || s.status === "paused" || !!s.nowPlaying;
}

// Toca uma estação de rádio (streaming) pelo nome ou estilo. Retorna o nome da estação.
export async function playRadio(name: string): Promise<string> {
  requireCreds();
  const { id, configId } = await findBot();
  const r = await ok(await api(`/servers/${configId}/radio-stations`, { method: "GET" }), "radio-stations");
  const res = await r.json();
  const list: any[] = Array.isArray(res) ? res : res.stations || [];
  const n = name.toLowerCase().trim();
  const st =
    list.find((s) => String(s.name || "").toLowerCase().includes(n)) ||
    list.find((s) => String(s.genre || "").toLowerCase().includes(n));
  if (!st) throw new Error(`rádio "${name}" não encontrada`);
  await ok(await api(`/music-bots/${id}/play-radio`, { method: "POST", body: JSON.stringify({ stationId: st.id }) }), "play-radio");
  return st.name;
}

// Adiciona na fila (sem interromper): busca no YouTube → baixa p/ biblioteca → enfileira.
export async function enqueueMusic(query: string): Promise<string> {
  requireCreds();
  const { id, configId } = await findBot();
  const lib = `/servers/${configId}/music-library/youtube`;
  const sr = await ok(await api(`${lib}/search`, { method: "POST", body: JSON.stringify({ query }) }), "search");
  const results = await sr.json();
  const first = (Array.isArray(results) ? results : results.results || [])[0];
  if (!first?.id) throw new Error("nada encontrado no YouTube");
  const url = `https://www.youtube.com/watch?v=${first.id}`;
  const dr = await ok(await api(`${lib}/download`, { method: "POST", body: JSON.stringify({ url }) }), "download");
  const song: any = await dr.json();
  const songId = song?.id ?? song?.song?.id;
  if (!songId) throw new Error("download sem songId");
  await ok(await api(`/music-bots/${id}/queue`, { method: "POST", body: JSON.stringify({ songId }) }), "queue");
  return first.title || query;
}
