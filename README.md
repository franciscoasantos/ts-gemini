# ts-gemini

Bot do Gemini para TeamSpeak 6. Ele entra no servidor como um cliente normal e conversa
por voz e por texto, e ainda comanda por voz o bot de música do servidor (via TS6 Manager).

## O que ele faz

**Voz.** Diga a palavra de ativação (**"ok gemini"**, e também **"ok google"**) e fale
em seguida. O Gemini responde falando no canal e mantém o contexto da conversa; depois de
alguns segundos de silêncio a sessão encerra sozinha e libera para outra pessoa. O
reconhecimento é em **português** (Whisper), então entende a pronúncia brasileira.

Sinais sonoros: um som curto subindo quando ele te ouve, um "tururum" quando reconhece um
comando de música, e um som descendo quando a conversa é liberada.

**Texto.** `!gemini <pergunta>` no chat do canal, ou qualquer mensagem no privado do bot.

**Música (por voz, comandando o bot de música do Manager).** Depois do "ok gemini":

| Você diz | O que acontece |
|---|---|
| "toca *X*" | Se já tem algo tocando, entra na fila; se está parado, toca na hora |
| "toca *X* agora" | Toca na hora **sem perder** a fila existente |
| "adiciona *X* na fila" | Enfileira sem interromper |
| "tira *X* da fila" | Remove a música da fila pelo nome |
| "pula" / "para" / "pausa" / "continua" | Controla a reprodução |
| "toca a rádio *X*" | Toca uma estação de rádio (por nome ou estilo) — streaming, sem espera |
| "o que vem na fila?" | Escreve as próximas músicas no chat do canal |
| "escreve *X* no chat" | Posta um texto no chat do canal |

## Como funciona

- **Cliente de voz TS3** (`src/tslib`): engenharia reversa do protocolo, copiado do
  [ts6-manager](https://github.com/clusterzx/ts6-manager) (MIT). É o mesmo cliente dos
  bots de música, então convivem no servidor sem conflito.
- **Wake word**: VAD (silero) recorta a fala e o **Whisper multilíngue** transcreve; o bot
  procura a palavra de ativação no texto. O áudio do bot de música é ignorado para não
  interferir nem gastar CPU.
- **Conversa de voz**: Gemini Live API (`@google/genai`). O texto usa `generateContent`.
- **Música**: o bot chama a API do backend do TS6 Manager, que controla o bot de música.
- **Áudio Opus**: `opusscript` (WASM); modelos de voz via `sherpa-onnx` (binário, roda em
  ARM64). Nada disso precisa compilar.

## Rodar (Docker)

```bash
cp .env.example .env     # preencha ao menos TS_HOST e GEMINI_API_KEY
docker compose up -d --build
docker compose logs -f
```

A chave do Gemini vem do [Google AI Studio](https://aistudio.google.com/apikey). Na
primeira execução o bot gera uma identidade e salva em `data/identity.json` (volume) — é
o que o servidor usa para reconhecê-lo; guarde esse arquivo.

Para os comandos de **música**, preencha `MANAGER_USER`/`MANAGER_PASS` com um login do TS6
Manager e confirme `MUSIC_BOT_NAME`. O container precisa alcançar o backend do Manager — o
`docker-compose.yml` já o conecta à rede `teamspeak_ts6`; ajuste o nome se o seu projeto do
Manager usar outro.

## Ajustes (`.env`)

- `WAKE_WORDS` — variações aceitas da palavra de ativação (o Whisper erra a grafia; por
  isso há várias).
- `WHISPER_PREFIX` — `tiny`/`base`/`small`. Maior = mais preciso e mais lento; precisa bater
  com o modelo baixado no `Dockerfile`.
- `CONVO_IDLE_MS` — silêncio (ms) até encerrar a conversa.
- `IGNORE_SPEAKERS` — apelidos cujo áudio é ignorado (padrão: o bot de música).
- `BEEP=0` desliga os avisos sonoros; `DEBUG_VOICE=1` loga o que o bot ouve.

## Limitações conhecidas

- Tocar música do **YouTube** tem ~10s de espera: o Manager baixa o áudio inteiro antes de
  tocar. Rádio é instantâneo (streaming). O bot confirma por voz na hora para não ficar
  mudo durante a espera.
- A wake word usa um modelo de propósito geral; pronúncias muito fora do padrão podem
  escapar — `WAKE_WORDS` é ajustável.
- O upload do avatar do próprio bot é instável (o file transfer do TS retorna "convert
  error" em parte das tentativas).

## Verificação

- `npx tsx src/audio.ts` — self-check de áudio (resample, Opus, parsing dos pacotes de voz).
- No TeamSpeak: `!gemini oi` no canal; mensagem no privado; "ok gemini" + um comando.
