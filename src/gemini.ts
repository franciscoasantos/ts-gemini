import { GoogleGenAI, Modality, type Session } from "@google/genai";

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
}

export function openLive(h: LiveHandlers): Promise<Session> {
  return ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: PERSONA + " Você está falando por voz, então seja breve.",
    },
    callbacks: {
      onopen: () => console.log(`[live] sessão aberta (${LIVE_MODEL})`),
      onmessage: (m) => {
        if (m.setupComplete) console.log("[live] pronto (setupComplete)");
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
}
