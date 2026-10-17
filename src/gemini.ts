import { GoogleGenAI, Modality, Type, type Session } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-flash-latest";
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const PERSONA =
  "Você é o Gemini, um bot num servidor de TeamSpeak. Responda em português do Brasil, de forma curta e direta.";

export async function ask(question: string): Promise<string> {
  const res = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: question,
    config: { systemInstruction: PERSONA + " Use texto puro, sem markdown." },
  });
  return res.text?.trim() || "(sem resposta)";
}

export interface LiveHandlers {
  audio: (pcm24k: Buffer) => void;
  turnComplete: () => void;
  interrupted: () => void;
  closed: () => void;
  onTool?: (name: string, args: any) => Promise<any>;
}

const buscaParam = {
  type: Type.OBJECT,
  properties: { busca: { type: Type.STRING, description: "Nome da música e/ou artista a buscar no YouTube" } },
  required: ["busca"],
};
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "tocar_musica",
        description: "Pedido normal de tocar uma música. Se já houver algo tocando, adiciona na fila; se não houver nada, toca na hora. Use para 'toca', 'coloca', 'bota' uma música.",
        parameters: buscaParam,
      },
      {
        name: "tocar_agora",
        description: "Toca uma música IMEDIATAMENTE, interrompendo a que está tocando. Use SÓ quando o usuário disser explicitamente 'tocar agora', 'põe essa agora', 'interrompe e toca'.",
        parameters: buscaParam,
      },
      {
        name: "adicionar_fila",
        description: "Adiciona uma música na fila sem interromper a que está tocando. Use quando pedir para adicionar/enfileirar/botar na fila.",
        parameters: buscaParam,
      },
      {
        name: "tocar_radio",
        description: "Toca uma estação de rádio online (streaming). Use quando o usuário pedir para tocar/colocar uma rádio, por nome ou estilo (ex.: lofi, jazz, rock, techno).",
        parameters: {
          type: Type.OBJECT,
          properties: { nome: { type: Type.STRING, description: "Nome ou estilo da rádio" } },
          required: ["nome"],
        },
      },
      {
        name: "remover_fila",
        description: "Remove uma música da fila pelo nome. Use quando pedirem para tirar/remover/cancelar uma música da fila.",
        parameters: buscaParam,
      },
      {
        name: "listar_fila",
        description: "Lista as músicas da fila e escreve no chat de texto do canal. Use quando perguntarem o que está na fila, próximas músicas, ou o que está tocando.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      {
        name: "escrever_chat",
        description: "Escreve uma mensagem no chat de texto do canal do TeamSpeak. Use quando pedirem para você escrever/mandar algo no chat.",
        parameters: { type: Type.OBJECT, properties: { texto: { type: Type.STRING, description: "O texto a escrever no chat" } }, required: ["texto"] },
      },
      { name: "pular_musica", description: "Pula para a próxima música da fila.", parameters: { type: Type.OBJECT, properties: {} } },
      { name: "parar_musica", description: "Para a reprodução de música.", parameters: { type: Type.OBJECT, properties: {} } },
      { name: "pausar_musica", description: "Pausa a música atual.", parameters: { type: Type.OBJECT, properties: {} } },
      { name: "retomar_musica", description: "Retoma a música pausada.", parameters: { type: Type.OBJECT, properties: {} } },
    ],
  },
];

export async function openLive(h: LiveHandlers): Promise<Session> {
  const ref: { s?: Session } = {};
  const session = await ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction:
        PERSONA +
        " Você está falando por voz, então seja breve. Você controla um bot de música: tocar, adicionar na fila, tocar rádio, pular, parar, pausar e retomar. Depois de usar uma ferramenta de música, confirme em voz alta numa frase bem curta (ex.: 'ok, já vou colocar').",
      tools: TOOLS as any,
    },
    callbacks: {
      onopen: () => console.log(`[live] sessão aberta (${LIVE_MODEL})`),
      onmessage: async (m) => {
        if (m.setupComplete) console.log("[live] pronto (setupComplete)");

        // Chamadas de ferramenta (ex.: tocar música)
        if (m.toolCall?.functionCalls?.length) {
          const functionResponses = [];
          for (const fc of m.toolCall.functionCalls) {
            console.log(`[tool] ${fc.name}(${JSON.stringify(fc.args)})`);
            let response: any;
            try {
              response = (await h.onTool?.(fc.name!, fc.args)) ?? { ok: true };
            } catch (e: any) {
              console.error("[tool] erro:", e.message);
              response = { erro: String(e.message || e) };
            }
            functionResponses.push({ id: fc.id, name: fc.name, response });
          }
          try {
            ref.s?.sendToolResponse({ functionResponses });
          } catch {
            // a sessão pode ter sido fechada pelo comando (one-shot); tudo bem
          }
          return;
        }

        const c = m.serverContent;
        if (!c) return;
        if (c.interrupted) h.interrupted();
        let bytes = 0;
        for (const p of c.modelTurn?.parts ?? []) {
          if (p.inlineData?.data) {
            const buf = Buffer.from(p.inlineData.data, "base64");
            bytes += buf.length;
            h.audio(buf);
          }
        }
        if (bytes) console.log(`[live] respondendo (+${bytes} bytes de áudio)`);
        if (c.turnComplete) {
          console.log("[live] fim do turno");
          h.turnComplete();
        }
      },
      onerror: (e) => console.error("[live] erro:", e.message ?? e),
      onclose: (e) => {
        console.log("[live] fechou:", e?.reason || "(sem motivo)");
        h.closed();
      },
    },
  });
  ref.s = session;
  return session;
}
