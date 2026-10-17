FROM node:20-bookworm-slim

# sherpa-onnx-node e opusscript são binários/WASM prontos — sem toolchain.
# Só precisamos baixar e descompactar o modelo de keyword spotting.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget bzip2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

# Whisper multilíngue (small) p/ reconhecer PT + VAD silero
RUN MODEL=sherpa-onnx-whisper-small \
 && wget -q "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2" \
 && tar xjf "${MODEL}.tar.bz2" \
 && mv "${MODEL}" model \
 && rm "${MODEL}.tar.bz2" \
 && wget -q "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx" -O model/silero_vad.onnx

COPY tsconfig.json keywords.txt avatar.png ./
COPY src ./src

# node como PID 1 (recebe SIGTERM direto → desconecta limpo, sem clone-fantasma)
CMD ["node", "--import", "tsx", "src/index.ts"]
