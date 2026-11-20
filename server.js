import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const STREAM_SECRET = String(process.env.STREAM_SECRET || '').trim();
const GEMINI_LIVE_MODEL = String(process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025').trim();
const GEMINI_VOICE = String(process.env.GEMINI_VOICE || 'Kore').trim();
const SYSTEM_INSTRUCTION = String(process.env.SYSTEM_INSTRUCTION || 'אתה עוזר קולי בעברית לשיחות טלפון. דבר בעברית טבעית, בקיצור ומכבד.').trim();

function pcm8kTo16k(buffer) {
  if (!buffer.length) return Buffer.alloc(0);
  const out = Buffer.alloc(buffer.length * 2);
  for (let i = 0; i < buffer.length - 1; i += 2) {
    const sample = buffer.readInt16LE(i);
    out.writeInt16LE(sample, i * 2);
    out.writeInt16LE(sample, i * 2 + 2);
  }
  return out;
}

function pcm24kTo8k(buffer) {
  if (!buffer.length) return Buffer.alloc(0);
  const frame = 6;
  const count = Math.floor(buffer.length / frame);
  const out = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) sum += buffer.readInt16LE(i * frame + j * 2);
    out.writeInt16LE(Math.round(sum / 3), i * 2);
  }
  return out;
}

const app = express();
app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, geminiConfigured: !!GEMINI_API_KEY }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/voice') {
    socket.destroy();
    return;
  }

  const authorization = String(req.headers.authorization || '').trim();
  if (STREAM_SECRET && authorization !== `Bearer ${STREAM_SECRET}`) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  const call = { callId: '', caller: '', system: '', token: '', closing: false };
  let gemini = null;
  let geminiReady = false;

  const closeGemini = () => {
    if (gemini && gemini.readyState === WebSocket.OPEN) gemini.close();
  };

  const sendPBX = payload => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const openGemini = () => {
    if (!GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is missing');
      ws.close(1011, 'AI service not configured');
      return;
    }

    const endpoint = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    gemini = new WebSocket(endpoint);

    gemini.on('open', () => {
      gemini.send(JSON.stringify({
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: GEMINI_VOICE }
              }
            }
          },
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] }
        }
      }));
    });

    gemini.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }

      if (message.setupComplete) {
        geminiReady = true;
        console.log(call.callId, 'gemini live ready');
        return;
      }

      const serverContent = message.serverContent;
      if (serverContent?.interrupted) {
        sendPBX({ type: 'clear' });
      }

      const parts = serverContent?.modelTurn?.parts || [];
      for (const part of parts) {
        const inline = part.inlineData || part.inline_data;
        const base64 = inline?.data;
        if (!base64) continue;
        const pcm24k = Buffer.from(base64, 'base64');
        const pcmMime = inline.mimeType || inline.mime_type || '';
        const pcm8k = /rate=24000|24000/.test(pcmMime) ? pcm24kTo8k(pcm24k) : pcm24k;
        if (ws.readyState === WebSocket.OPEN && pcm8k.length) {
          ws.send(pcm8k, { binary: true });
        }
      }

      if (message.error) {
        console.error(call.callId, 'gemini live error', message.error);
      }
    });

    gemini.on('close', (code, reason) => {
      geminiReady = false;
      console.log(call.callId, 'gemini live closed', code, reason.toString());
      if (ws.readyState === WebSocket.OPEN && !call.closing) ws.close(1011, 'AI session closed');
    });

    gemini.on('error', error => {
      console.error(call.callId, 'gemini live websocket error', error.message);
    });
  };

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!geminiReady || !gemini || gemini.readyState !== WebSocket.OPEN) return;
      const pcm16k = pcm8kTo16k(Buffer.isBuffer(data) ? data : Buffer.from(data));
      gemini.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: pcm16k.toString('base64') }]
        }
      }));
      return;
    }

    let message;
    try { message = JSON.parse(data.toString()); } catch (error) {
      console.error(call.callId, 'invalid JSON from PBX', error.message);
      return;
    }

    switch (message.type) {
      case 'start':
        Object.assign(call, {
          callId: String(message.callId || ''),
          caller: String(message.caller || ''),
          system: String(message.system || ''),
          token: String(message.token || '')
        });
        console.log(call.callId, 'PBX streaming call started', call.caller, call.system);
        openGemini();
        break;

      case 'dtmf':
        if (!geminiReady || !gemini || gemini.readyState !== WebSocket.OPEN) break;
        gemini.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: `המתקשר הקיש את המקש ${String(message.digit || '').slice(0, 1)}.` }] }], turnComplete: true } }));
        break;

      case 'hangup':
        call.closing = true;
        closeGemini();
        if (ws.readyState === WebSocket.OPEN) ws.close();
        break;

      default:
        console.log(call.callId, 'PBX event', message);
    }
  });

  ws.on('close', () => {
    call.closing = true;
    closeGemini();
  });

  ws.on('error', error => console.error(call.callId, 'PBX websocket error', error.message));

  // Random local call identifier only as a fallback before PBX sends start.
  call.callId = crypto.randomUUID();
});

server.listen(PORT, () => {
  console.log(`Kav AI streaming server listening on port ${PORT}`);
});
