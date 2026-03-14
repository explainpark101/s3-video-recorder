/**
 * 라이브 스트리밍 호스팅 서버
 * 브라우저에서 WebSocket으로 전송한 WebM 청크를 시청자 WebSocket으로 그대로 전달합니다. (ts 변환 없음, ffmpeg 불필요)
 * 사용: bun run server 또는 node server/index.js
 */
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3030;

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>라이브 시청 - S3 Video Recorder</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f172a; color: #e2e8f0; font-family: system-ui, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1rem; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; color: #94a3b8; }
    .player-wrap { width: 100%; max-width: 960px; aspect-ratio: 16/9; background: #000; border-radius: 1rem; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: contain; }
    .status { margin-top: 1rem; padding: 0.75rem 1rem; background: #1e293b; border-radius: 0.5rem; font-size: 0.875rem; color: #94a3b8; }
    .status.live { color: #22c55e; }
    .status.waiting { color: #f59e0b; }
  </style>
</head>
<body>
  <h1>라이브 스트림 (WebM)</h1>
  <div class="player-wrap">
    <video id="video" controls muted playsinline></video>
  </div>
  <div id="status" class="status waiting">스트림 대기 중...</div>
  <script>
    const video = document.getElementById('video');
    const statusEl = document.getElementById('status');
    const mime = 'video/webm; codecs="vp9,opus"';
    if (!MediaSource.isTypeSupported(mime)) {
      statusEl.textContent = '이 브라우저는 WebM VP9 재생을 지원하지 않습니다.';
      statusEl.className = 'status';
    } else {
      const mediaSource = new MediaSource();
      video.src = URL.createObjectURL(mediaSource);
      let sourceBuffer = null;
      const chunkQueue = [];
      let connecting = true;

      function appendNext() {
        if (!sourceBuffer || sourceBuffer.updating || chunkQueue.length === 0) return;
        const chunk = chunkQueue.shift();
        try {
          sourceBuffer.appendBuffer(chunk);
        } catch (e) {
          console.warn('appendBuffer error', e);
          appendNext();
        }
      }

      mediaSource.addEventListener('sourceopen', () => {
        try {
          sourceBuffer = mediaSource.addSourceBuffer(mime);
          sourceBuffer.addEventListener('updateend', appendNext);
          statusEl.textContent = 'LIVE';
          statusEl.className = 'status live';
          video.play().catch(() => {});
          appendNext();
        } catch (e) {
          statusEl.textContent = 'SourceBuffer 오류: ' + e.message;
        }
      });

      const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(wsScheme + '//' + location.host);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
          chunkQueue.push(e.data);
          appendNext();
        }
      };
      ws.onopen = () => { connecting = false; };
      ws.onerror = () => {
        if (connecting) statusEl.textContent = '서버 연결 실패. 방송이 시작되면 자동으로 재연결합니다.';
      };
      ws.onclose = () => {
        if (document.hasFocus()) setTimeout(() => location.reload(), 3000);
      };
    }
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  try {
    const url = req.url === '/' ? '/index.html' : req.url;
    if (url === '/index.html' || url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(VIEWER_HTML);
      return;
    }
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'stream-host' }));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    console.error('HTTP handler error:', err);
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_server_error' }));
    } catch {
      // ignore secondary errors
    }
  }
});

const wss = new WebSocketServer({ server });

let activeStreamer = null;
const viewerSockets = new Set();
let initChunk = null;

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
      if (ws.readyState === ws.OPEN) ws.send(initChunk);
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
