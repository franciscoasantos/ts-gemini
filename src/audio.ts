import assert from "node:assert/strict";
import OpusScript from "opusscript";

const FRAME = 960; // 20 ms @ 48 kHz
const FRAME_BYTES = FRAME * 2 * 2; // stereo, 16-bit

// Server→client voice payload: [voiceId u16][clientId u16][codec u8][opus...]
export function parseVoice(data: Buffer) {
  if (data.length < 5) return null;
  return { clientId: data.readUInt16BE(2), codec: data[4], opus: data.subarray(5) };
}

// 48 kHz → 16 kHz mono by averaging groups of 3.
export function down48to16(pcm: Buffer): Int16Array {
  const n = Math.floor(pcm.length / 6);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    out[i] = Math.round((pcm.readInt16LE(o) + pcm.readInt16LE(o + 2) + pcm.readInt16LE(o + 4)) / 3);
  }
  return out;
}

// 24 kHz mono → 48 kHz stereo (each sample → 2 time steps × L/R).
// ponytail: sample duplication, swap for a proper resampler if it sounds harsh.
export function up24to48stereo(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    for (let k = 0; k < 4; k++) out.writeInt16LE(s, i * 8 + k * 2);
  }
  return out;
}

// Bip curto (48 kHz estéreo 16-bit). Default = "ba-ding" grave (liberou).
// Passe outras notas pra sons distintos (ex.: ativação).
export function beep(notes: { f: number; ms: number }[] = [{ f: 587, ms: 110 }, { f: 784, ms: 170 }]): Buffer {
  const sr = 48000;
  const len = notes.reduce((a, n) => a + Math.round((sr * n.ms) / 1000), 0);
  const out = Buffer.alloc(len * 4);
  let idx = 0;
  const edge = sr * 0.005; // 5 ms de fade pra não estalar
  for (const n of notes) {
    const nlen = Math.round((sr * n.ms) / 1000);
    for (let i = 0; i < nlen; i++, idx++) {
      const fade = Math.min(1, i / edge, (nlen - i) / edge);
      const s = Math.round(Math.sin((2 * Math.PI * n.f * i) / sr) * 0.25 * 32767 * fade);
      out.writeInt16LE(s, idx * 4);
      out.writeInt16LE(s, idx * 4 + 2);
    }
  }
  return out;
}

// Queues 48 kHz stereo PCM and sends it as Opus every 20 ms.
export class Player {
  private enc = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
  private queue = Buffer.alloc(0);
  private timer: NodeJS.Timeout | null = null;
  private next = 0;

  constructor(private send: (opus: Buffer) => void, private stop: () => void) {
    this.enc.setBitrate(64000);
  }

  push(pcm: Buffer) {
    this.queue = Buffer.concat([this.queue, pcm]);
    if (!this.timer) {
      this.next = performance.now();
      this.tick();
    }
  }

  clear() {
    this.queue = Buffer.alloc(0);
  }

  private tick = () => {
    if (this.queue.length === 0) {
      this.timer = null;
      this.stop();
      return;
    }
    let frame = this.queue.subarray(0, FRAME_BYTES);
    this.queue = this.queue.subarray(FRAME_BYTES);
    if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
    this.send(Buffer.from(this.enc.encode(frame, FRAME)));
    // Schedule against an absolute clock so timer jitter doesn't accumulate.
    this.next += 20;
    this.timer = setTimeout(this.tick, Math.max(0, this.next - performance.now()));
  };
}

// Self-check: `npx tsx src/audio.ts`
if (process.argv[1]?.endsWith("audio.ts")) {
  const pkt = Buffer.from([0, 7, 0, 42, 5, 0xaa, 0xbb]);
  assert.deepEqual(parseVoice(pkt), { clientId: 42, codec: 5, opus: Buffer.from([0xaa, 0xbb]) });
  assert.equal(parseVoice(Buffer.from([1, 2, 3])), null);

  const pcm48 = Buffer.alloc(12);
  [3, 6, 9, -3, -6, -9].forEach((v, i) => pcm48.writeInt16LE(v, i * 2));
  assert.deepEqual([...down48to16(pcm48)], [6, -6]);

  const pcm24 = Buffer.alloc(4);
  pcm24.writeInt16LE(100, 0);
  pcm24.writeInt16LE(-5, 2);
  const up = up24to48stereo(pcm24);
  assert.deepEqual([...new Int16Array(up.buffer, up.byteOffset, up.length / 2)], [100, 100, 100, 100, -5, -5, -5, -5]);

  // Opus roundtrip: encoder frame decodes back to 960 samples.
  const sent: Buffer[] = [];
  let stopped = false;
  const p = new Player((b) => sent.push(b), () => (stopped = true));
  p.push(Buffer.alloc(FRAME_BYTES * 2));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 2);
  assert.ok(stopped);
  const dec = new OpusScript(48000, 1);
  assert.equal(dec.decode(sent[0]).length, FRAME * 2);

  const b = beep();
  assert.ok(b.length > 0 && b.length % 4 === 0); // estéreo 16-bit
  console.log("audio ok");
}
