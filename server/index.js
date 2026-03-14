/**
 * 라이브 스트리밍 호스팅 서버
 * 브라우저에서 WebSocket으로 전송한 WebM 청크를 시청자 WebSocket으로 그대로 전달합니다. (ts 변환 없음, ffmpeg 불필요)
 * 사용: bun run server 또는 node server/index.js
 */
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3030;

// WebSocket만 사용. HTTP는 포트 리스너용 최소 핸들러만 유지 (Upgrade는 ws가 처리)
const server = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

let activeStreamer = null;
const viewerSockets = new Set();
let initChunk = null;
const chunkBuffer = [];
const MAX_CHUNK_BUFFER = 15;

function safeWsSend(ws, payload) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (err) {
    console.error('WebSocket send error:', err);
  }
}

function sendToViewers(data, isBinary) {
  for (const v of viewerSockets) {
    try {
      if (v.readyState === v.OPEN) {
        if (isBinary) v.send(data);
        else v.send(JSON.stringify(data));
      }
    } catch {
      // skip
    }
  }
}

wss.on('connection', (ws) => {
  viewerSockets.add(ws);
  if (initChunk) {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(initChunk);
        for (const b of chunkBuffer) {
          if (ws.readyState !== ws.OPEN) break;
          ws.send(b);
        }
      }
    } catch {
      // ignore
    }
  }

  let isInitialized = false;
  let inactivityTimer = null;
  let lastChunkAt = null;

  function clearInactivityWatch() {
    if (inactivityTimer) {
      clearInterval(inactivityTimer);
      inactivityTimer = null;
    }
  }

  function startInactivityWatch() {
    clearInactivityWatch();
    lastChunkAt = Date.now();
    const INACTIVITY_LIMIT_MS = 2 * 60 * 1000;
    inactivityTimer = setInterval(() => {
      if (!lastChunkAt) return;
      if (Date.now() - lastChunkAt >= INACTIVITY_LIMIT_MS) {
        stopStream('inactivity_timeout');
      }
    }, 10_000);
  }

  function stopStream(reason = 'stopped') {
    clearInactivityWatch();
    if (activeStreamer === ws) {
      activeStreamer = null;
      initChunk = null;
      chunkBuffer.length = 0;
    }
    try {
      if (ws.readyState === ws.OPEN) {
        safeWsSend(ws, { type: 'stream_closed', reason });
        ws.close(1000);
      }
    } catch {
      // ignore
    }
  }

  function acceptStreamStart() {
    if (isInitialized) return false;
    initChunk = null;
    chunkBuffer.length = 0;
    isInitialized = true;
    activeStreamer = ws;
    viewerSockets.delete(ws);
    startInactivityWatch();
    safeWsSend(ws, { ok: true, message: 'Stream started', viewerUrl: `http://localhost:${PORT}/` });
    return true;
  }

  ws.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'start' || msg.start) {
            if (activeStreamer && activeStreamer !== ws && activeStreamer.readyState === ws.OPEN) {
              safeWsSend(ws, { error: 'stream_already_running' });
              return;
            }
            if (isInitialized) {
              safeWsSend(ws, { error: 'stream_already_initialized' });
              return;
            }
            acceptStreamStart();
            return;
          }
          if (msg.type === 'start_replace') {
            if (isInitialized) {
              safeWsSend(ws, { error: 'stream_already_initialized' });
              return;
            }
            // 기존 방송 강제 해제: 새로 연결한 클라이언트가 start_replace만 보내도 기존 스트리머를 끊고 이 연결을 스트리머로 승인
            if (activeStreamer && activeStreamer !== ws && activeStreamer.readyState === activeStreamer.OPEN) {
              const prevWs = activeStreamer;
              activeStreamer = null;
              initChunk = null;
              chunkBuffer.length = 0;
              try {
                safeWsSend(prevWs, { type: 'stream_closed', reason: 'replaced_by_new_stream' });
                prevWs.close(1000);
              } catch {
                // ignore
              }
            }
            acceptStreamStart();
            return;
          }
          if (msg.type === 'close' || msg.stop) {
            stopStream('close_request');
          }
        } catch {
          safeWsSend(ws, { error: 'Invalid init message' });
        }
        return;
      }

      if (activeStreamer !== ws || !isInitialized) return;

      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      lastChunkAt = Date.now();
      if (!initChunk) initChunk = buf;
      chunkBuffer.push(buf);
      if (chunkBuffer.length > MAX_CHUNK_BUFFER) chunkBuffer.shift();
      sendToViewers(buf, true);
    } catch (outerErr) {
      console.error('WebSocket message handler error:', outerErr);
      safeWsSend(ws, { error: 'internal_stream_error' });
    }
  });

  ws.on('close', () => {
    viewerSockets.delete(ws);
    stopStream('ws_closed');
  });
});

server.listen(PORT, () => {
  console.log(`Stream host server: http://localhost:${PORT}/ (시청 가능)`);
});
