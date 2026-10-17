import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import OpusScript from "opusscript";
import type { Session } from "@google/genai";
import { Ts3Client, buildCommand, generateIdentity, restoreIdentity, type ParsedCommand } from "./tslib/index.js";
import { Player, beep, down48to16, parseVoice, up24to48stereo } from "./audio.js";
import { ask, openLive } from "./gemini.js";
import { uploadAvatar } from "./filetransfer.js";
import { playMusic, playNowKeepQueue, shouldQueue, enqueueMusic, playRadio, getQueue, removeFromQueue, skip, stop, pause, resume } from "./manager.js";

// sherpa-onnx-node é CommonJS com binário nativo (só no container); carrega via require.
const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx-node");

const env = process.env;
for (const k of ["TS_HOST", "GEMINI_API_KEY", "KWS_DIR"]) {
  if (!env[k]) throw new Error(`Faltou ${k} no .env (veja .env.example)`);
}

function loadIdentity() {
  const file = env.IDENTITY_FILE || "identity.json";
  if (existsSync(file)) return restoreIdentity(JSON.parse(readFileSync(file, "utf8")));
  console.log("Gerando identidade (só na primeira vez)...");
  const id = generateIdentity(8);
  const { privateKeyBigInt, keyOffset, publicKeyString, uid } = id;
  writeFileSync(file, JSON.stringify({ privateKeyBigInt: String(privateKeyBigInt), keyOffset: String(keyOffset), publicKeyString, uid }));
  return id;
}

const client = new Ts3Client();
const identity = loadIdentity();

// ---------- Conexão ----------
let retry: NodeJS.Timeout | undefined;
const reconnect = () => {
  clearTimeout(retry);
  retry = setTimeout(connect, 5000);
};
async function connect() {
  try {
    await client.connect({
      host: env.TS_HOST!,
      port: Number(env.TS_PORT || 9987),
      identity,
      nickname: env.TS_NICK || "Gemini",
      serverPassword: env.TS_SERVER_PASSWORD || undefined,
      defaultChannel: env.TS_CHANNEL || undefined,
      channelPassword: env.TS_CHANNEL_PASSWORD || undefined,
    });
    console.log(`Conectado em ${env.TS_HOST} (clid ${client.getClientId()})`);
    setTimeout(setAvatarOnce, 2500);
  } catch (e: any) {
    console.error("Falha ao conectar:", e.message);
    reconnect();
  }
}
// Define a foto de perfil do bot uma vez (arquivo AVATAR_FILE, padrão ./avatar.png).
let avatarDone = false;
async function setAvatarOnce() {
  if (avatarDone) return;
  const file = env.AVATAR_FILE || "avatar.png";
  if (!existsSync(file)) return;
  avatarDone = true; // tenta uma vez por processo (não repete a cada reconexão)
  try {
    await uploadAvatar(client, env.TS_HOST!, readFileSync(file));
    console.log("[avatar] definido");
  } catch (e: any) {
    console.error("[avatar] falhou:", e.message);
  }
}

client.on("error", (e: Error) => console.error("[ts]", e.message));
client.on("ts3error", (p: Record<string, string>) => p.id !== "0" && console.error("[ts]", p.id, p.msg));

// Rastreia apelido de cada cliente, pra ignorar a voz do bot de música (ele toca no canal
// e a música chegaria como "fala", atrapalhando/gastando a detecção da wake word).
const nameByClid = new Map<number, string>();
const IGNORE = (env.IGNORE_SPEAKERS || env.MUSIC_BOT_NAME || "DJ Morri")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
client.on("command", (p: ParsedCommand) => {
  if (p.name === "notifycliententerview" || p.name === "notifyclientupdated") {
    // enterview traz clid; clientupdated (troca de apelido ao tocar) também — mantém o nome fresco
    for (const g of p.groups ?? [p.params]) {
      const clid = Number(g.clid);
      if (clid && g.client_nickname !== undefined) {
        nameByClid.set(clid, String(g.client_nickname).toLowerCase());
      }
    }
  } else if (p.name === "notifyclientleftview") {
    for (const g of p.groups ?? [p.params]) nameByClid.delete(Number(g.clid));
  }
});
function isIgnored(clid: number): boolean {
  const nick = nameByClid.get(clid) || "";
  return !!nick && IGNORE.some((x) => nick.includes(x));
}
client.on("disconnected", () => {
  resetVoice(); // zera qualquer conversa travada antes de voltar
  reconnect();
});

// ---------- Texto: !gemini no canal, qualquer coisa no privado ----------
function sendText(targetmode: number, target: number, text: string) {
  for (let i = 0; i < text.length; i += 900) {
    client.sendCommand(buildCommand("sendtextmessage", { targetmode, target, msg: text.slice(i, i + 900) }));
  }
}

client.on("textMessage", async (p: Record<string, string>) => {
  const from = Number(p.invokerid);
  if (from === client.getClientId()) return;
  const mode = Number(p.targetmode);
  let q: string;
  if (mode === 1) q = p.msg;
  else if (mode === 2 && /^!gemini\b/i.test(p.msg)) q = p.msg.replace(/^!gemini\s*/i, "");
  else return;
  if (!q.trim()) return;
  const [tm, target] = mode === 1 ? [1, from] : [2, 0];
  try {
    sendText(tm, target, await ask(q));
  } catch (e: any) {
    console.error("[gemini]", e.message);
    sendText(tm, target, "Deu erro falando com o Gemini.");
  }
});

// ---------- Voz: wake word via VAD + Whisper-PT (transcreve e procura "gemini") → Gemini Live ----------
const MODEL = env.KWS_DIR!;
// Dispara quando a transcrição em PT contém alguma destas palavras.
const WAKE = new RegExp(env.WAKE_WORDS || "gemini|gemin|jemin|jimin|jimi|zemain|gize|gêmeos|ok google|\\bgoogle\\b", "i");
const WP = env.WHISPER_PREFIX || "base"; // tiny | base | small
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    whisper: {
      encoder: `${MODEL}/${WP}-encoder.int8.onnx`,
      decoder: `${MODEL}/${WP}-decoder.int8.onnx`,
      language: "pt",
      task: "transcribe",
    },
    tokens: `${MODEL}/${WP}-tokens.txt`,
    numThreads: Number(env.ASR_THREADS || 2),
    provider: "cpu",
    debug: 0,
  },
});
const VAD_WINDOW = 512;
function makeVad() {
  return new sherpa.Vad(
    {
      sileroVad: {
        model: `${MODEL}/silero_vad.onnx`,
        threshold: 0.5,
        minSpeechDuration: 0.2,
        minSilenceDuration: 0.4,
        maxSpeechDuration: 6,
        windowSize: VAD_WINDOW,
      },
      sampleRate: 16000,
      numThreads: 1,
      debug: false,
    },
    12
  );
}

type Speaker = { dec: OpusScript; vad: any };
// ponytail: one decoder+VAD per clid ever seen, never freed; prune on notifyclientleftview if it grows.
const speakers = new Map<number, Speaker>();
function speaker(clid: number): Speaker {
  let s = speakers.get(clid);
  if (!s) {
    s = { dec: new OpusScript(48000, 1), vad: makeVad() };
    speakers.set(clid, s);
  }
  return s;
}

const voiceDbg: Record<number, number> = {};
let lastVoiceLog = 0;

const player = new Player(
  (o) => {
    client.sendVoice(o);
    if (listener !== null) keepAlive(); // enquanto o bot fala, o contador de silêncio não corre
  },
  () => {
    client.sendVoiceStop();
    if (listener !== null) keepAlive(); // o Gemini acabou de falar → começa a contar o silêncio agora
  }
);
let session: Session | null = null;
let listener: number | null = null; // null = ocioso; clid de quem ativou = conversa em grupo em andamento
let pending: Int16Array[] = []; // audio captured while the Live session connects
let silenceTimer: NodeJS.Timeout | undefined; // marca o fim de cada fala
let convoTimer: NodeJS.Timeout | undefined; // encerra a conversa após silêncio longo
let closeAfterTurn = false; // fecha a sessão após a fala de confirmação de um comando
const CONVO_IDLE_MS = Number(env.CONVO_IDLE_MS || 12000); // destranca sozinho após esse silêncio

function toLive(pcm: Int16Array) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
  session!.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });
}

// Fim da conversa: para de ouvir e fecha a sessão (zera o contexto).
function endConversation() {
  console.log("[voz] conversa encerrada (silêncio)");
  listener = null;
  clearTimeout(silenceTimer);
  player.clear();
  session?.close();
  if (env.BEEP !== "0") player.push(beep([{ f: 784, ms: 110 }, { f: 587, ms: 170 }])); // desce = "liberei"
}

// Encerra a conversa na hora, sem beep de saída e sem limpar a fila de áudio
// (usado após um comando de música, pra parar de ouvir e deixar os sons tocarem).
function endConversationQuiet() {
  listener = null;
  clearTimeout(silenceTimer);
  clearTimeout(convoTimer);
  session?.close();
}

// Zera todo o estado de voz (usado ao reconectar, pra não ficar travado).
function resetVoice() {
  listener = null;
  clearTimeout(silenceTimer);
  clearTimeout(convoTimer);
  pending = [];
  player.clear();
  session?.close();
  session = null;
}

// Rearmado a cada fala; se passar CONVO_IDLE_MS sem ninguém falar, encerra.
function keepAlive() {
  clearTimeout(convoTimer);
  convoTimer = setTimeout(endConversation, CONVO_IDLE_MS);
}

async function startListening(clid: number) {
  console.log(`[voz] ativado por clid ${clid} — conversando`);
  listener = clid;
  player.clear();
  if (env.BEEP !== "0") player.push(beep([{ f: 587, ms: 110 }, { f: 784, ms: 170 }])); // sobe = "te ouvi"
  keepAlive();
  if (!session) {
    try {
      session = await openLive({
        audio: (pcm) => player.push(up24to48stereo(pcm)),
        turnComplete: () => {
          // Após um comando de música, o Gemini fala a confirmação e AÍ a sessão fecha.
          if (closeAfterTurn) {
            closeAfterTurn = false;
            endConversationQuiet();
          } else keepAlive();
        },
        interrupted: () => player.clear(),
        onTool: async (name, args) => {
          const beeps = env.BEEP !== "0";
          // "tururum" = comando reconhecido (feedback instantâneo até a voz sair)
          if (beeps) player.push(beep([{ f: 659, ms: 80 }, { f: 784, ms: 80 }, { f: 1047, ms: 130 }]));
          const q = String(args?.busca ?? args?.nome ?? "");
          // Escolhe a ação e a frase. "tocar_musica" decide fila vs. agora pelo estado atual,
          // pra confirmação por voz corresponder ao que de fato aconteceu.
          let run: () => Promise<unknown>;
          let frase: string;
          if (name === "tocar_musica") {
            if (await shouldQueue().catch(() => false)) {
              run = () => enqueueMusic(q);
              frase = `adicionei ${q} na fila`;
            } else {
              run = () => playMusic(q);
              frase = `ok, já vou tocar ${q}`;
            }
          } else if (name === "remover_fila") {
            // rápido (sem download): faz agora e confirma o resultado real
            const title = await removeFromQueue(q).catch(() => null);
            run = async () => {};
            frase = title ? `removi ${title} da fila` : `não achei ${q} na fila`;
          } else {
            const texto = String(args?.texto || "");
            const action: Record<string, () => Promise<unknown>> = {
              tocar_agora: () => playNowKeepQueue(q),
              adicionar_fila: () => enqueueMusic(q),
              tocar_radio: () => playRadio(q),
              pular_musica: skip,
              parar_musica: stop,
              pausar_musica: pause,
              retomar_musica: resume,
              escrever_chat: async () => texto && sendText(2, 0, texto),
              listar_fila: async () => {
                const { nowPlaying, upcoming } = await getQueue();
                const LIMIT = 15;
                let msg = nowPlaying ? `▶ Tocando: ${nowPlaying}\n` : "";
                if (upcoming.length) {
                  msg += "🎵 Próximas:\n" + upcoming.slice(0, LIMIT).map((t, i) => `${i + 1}. ${t}`).join("\n");
                  if (upcoming.length > LIMIT) msg += `\n… e mais ${upcoming.length - LIMIT}`;
                } else if (!nowPlaying) {
                  msg = "A fila está vazia.";
                } else {
                  msg += "(sem próximas na fila)";
                }
                sendText(2, 0, msg);
              },
            };
            if (!action[name]) return { erro: "função desconhecida" };
            run = action[name];
            frase =
              {
                tocar_agora: `tocando ${q} agora`,
                adicionar_fila: `adicionei ${q} na fila`,
                tocar_radio: `colocando a rádio ${q}`,
                pular_musica: "pulei",
                parar_musica: "parei",
                pausar_musica: "pausei",
                retomar_musica: "voltei",
                escrever_chat: "mandei no chat",
                listar_fila: "mandei a fila no chat",
              }[name] ?? "feito";
          }
          // Ação pesada (download ~10s) em segundo plano; o Gemini confirma por voz agora e
          // a sessão fecha logo após essa fala (closeAfterTurn), não durante o download todo.
          run().catch((e) => {
            console.error(`[tool] ${name} erro:`, e.message);
            if (beeps) player.push(beep([{ f: 392, ms: 150 }, { f: 294, ms: 200 }])); // só se falhar
          });
          closeAfterTurn = true;
          clearTimeout(convoTimer);
          convoTimer = setTimeout(endConversationQuiet, 10000); // segurança, se não vier turnComplete
          return { resultado: "ok", diga_curto: frase };
        },
        closed: () => {
          session = null;
          listener = null;
          clearTimeout(convoTimer);
        },
      });
    } catch (e: any) {
      console.error("[live] não conectou:", e.message);
      listener = null;
      return;
    }
  }
  pending.forEach(toLive);
  pending = [];
}

client.on("voice", (data: Buffer) => {
  const v = parseVoice(data);
  if (!v || v.opus.length === 0 || (v.codec !== 4 && v.codec !== 5)) return; // 4/5 = Opus voice/music
  if (v.clientId !== listener && isIgnored(v.clientId)) return; // ignora a voz do bot de música
  const s = speaker(v.clientId);
  let pcm: Int16Array;
  try {
    pcm = down48to16(Buffer.from(s.dec.decode(v.opus)));
  } catch {
    return;
  }

  // Conversa travada em quem chamou: só a voz dele vai pro Gemini (evita bagunça).
  if (listener === v.clientId) {
    if (session) toLive(pcm);
    else pending.push(pcm);
    keepAlive(); // o chamador falou → mantém a conversa viva
    // TS não manda nada no silêncio, então avisa o Live que a fala terminou (fecha o turno).
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => session?.sendRealtimeInput({ audioStreamEnd: true }), 800);
    return;
  }

  // Outra pessoa falando enquanto alguém conversa → ignora (não atrapalha, não ativa).
  if (listener !== null) return;
  if (env.DEBUG_VOICE === "1") {
    voiceDbg[v.clientId] = (voiceDbg[v.clientId] || 0) + pcm.length;
    const now = Date.now();
    if (now - lastVoiceLog > 1500) {
      lastVoiceLog = now;
      console.log(`[audio] recebendo voz:`, JSON.stringify(voiceDbg));
      for (const k in voiceDbg) voiceDbg[+k] = 0;
    }
  }
  // VAD segmenta a fala; cada segmento é transcrito (PT) e procuramos a wake word no texto.
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  for (let i = 0; i < samples.length; i += VAD_WINDOW) {
    s.vad.acceptWaveform(samples.subarray(i, i + VAD_WINDOW));
  }
  while (!s.vad.isEmpty()) {
    const seg = s.vad.front();
    s.vad.pop();
    if (listener !== null) continue; // já ativou nesse meio-tempo
    const st = recognizer.createStream();
    st.acceptWaveform({ sampleRate: 16000, samples: seg.samples });
    recognizer.decode(st);
    const text = (recognizer.getResult(st).text || "").toLowerCase().trim();
    if (text && env.DEBUG_VOICE === "1") console.log(`[asr ${v.clientId}] ${text}`);
    if (text && WAKE.test(text)) {
      console.log(`[wake] ${v.clientId}: "${text}"`);
      void startListening(v.clientId);
    }
  }
});

// Desconecta limpo tanto no Ctrl-C (SIGINT) quanto no stop do Docker (SIGTERM),
// senão o servidor guarda o cliente como "clone" fantasma no próximo start.
function shutdown() {
  client.removeListener("disconnected", reconnect);
  client.disconnect();
  setTimeout(() => process.exit(0), 700);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await connect();
