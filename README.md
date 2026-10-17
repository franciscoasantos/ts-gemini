# ts-gemini

Bot do Gemini para TeamSpeak 6. Entra no canal como um cliente normal e:

- **voz (conversa):** diga **"ok gemini"** e comece a falar. Ele responde falando no
  canal e **continua a conversa** (mantém o contexto) até ~20s de silêncio, sem precisar
  repetir a palavra de ativação a cada pergunta.
- **texto:** `!gemini <pergunta>` no chat do canal, ou qualquer mensagem no privado do bot.

## Arquitetura

- Cliente de voz TS3 (`src/tslib`, engenharia reversa, copiado do
  [ts6-manager](https://github.com/clusterzx/ts6-manager), MIT) — mesmo cliente dos bots
  de música do TS6 Manager, então convivem sem conflito.
- Wake word por **sherpa-onnx** (keyword spotting, binário pronto, roda em ARM64).
- Voz pela **Gemini Live API** (`@google/genai`); texto por `generateContent`.
- Áudio Opus via `opusscript` (puro WASM, sem compilar nada).

## Rodar (Docker, recomendado)

É como está em produção, no servidor:

```bash
cp .env.example .env   # preencha GEMINI_API_KEY e TS_HOST
docker compose up -d --build
docker compose logs -f
```

O `GEMINI_API_KEY` vem de https://aistudio.google.com/apikey. A identidade do bot é
gerada na 1ª execução e salva em `data/identity.json` (volume) — é o que o servidor usa
pra reconhecer o bot (permissões/grupos), então guarde esse arquivo.

> Rodar fora do Docker (`npx tsx src/index.ts`) exige `sherpa-onnx-node` instalado para a
> sua plataforma; em Windows/Node 24 pode não instalar. Docker é o caminho suportado.

## Ajustar a palavra de ativação

O modelo de keyword spotting é inglês; os gatilhos ficam em `keywords.txt` como pedaços
BPE (ex.: `▁G E M IN I`). Pra adicionar/variar uma palavra, gere os pedaços com o
`bpe.model` do modelo (ferramenta `sentencepiece` / `sherpa-onnx-cli text2token`) e some
uma linha. `:2.0` no fim aumenta a sensibilidade daquele gatilho.

Se o bot não disparar com o seu sotaque, ligue `DEBUG_KWS=1` no `.env` pra ver o
diagnóstico do spotter e calibrar.

## Verificação

- `npx tsx src/audio.ts` — self-check de áudio (resample + Opus + parse dos pacotes).
- No TS: `!gemini oi` no canal; mensagem no privado; falar "ok gemini, ...".
