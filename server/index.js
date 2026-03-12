/**
 * 라이브 스트리밍 호스팅 서버
 * 브라우저에서 WebSocket으로 전송한 WebM 청크를 HLS로 변환하여 HTTP로 시청 가능하게 합니다.
 * 사용: bun run server 또는 node server/index.js
 * 환경: 시스템에 ffmpeg 설치 필요
 */
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3030;
const STREAM_DIR = join(__dirname, 'stream-output');

if (!existsSync(STREAM_DIR)) mkdirSync(STREAM_DIR, { recursive: true });

const VIEWER_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>라이브 시청 - S3 Video Recorder</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7"></script>
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
  <h1>라이브 스트림</h1>
  <div class="player-wrap">
    <video id="video" controls muted playsinline></video>
  </div>
  <div id="status" class="status waiting">스트림 대기 중...</div>
  <script>
    const video = document.getElementById('video');
    const statusEl = document.getElementById('status');
    let retryCount = 0;
    const maxRetries = 60;

    function tryLoad() {
      fetch('/stream.m3u8', { method: 'HEAD' }).then(r => {
        if (r.ok) {
          statusEl.textContent = 'LIVE';
          statusEl.className = 'status live';
          if (Hls.isSupported()) {
            const hls = new Hls();
            hls.loadSource('/stream.m3u8');
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
          } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = '/stream.m3u8';
            video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
          }
        } else if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(tryLoad, 2000);
        }
      }).catch(() => {
        if (retryCount < maxRetries) {
          retryCount++;
          setTimeout(tryLoad, 2000);
        }
      });
    }
    tryLoad();
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
    if (url === '/stream.m3u8' || (url.startsWith('/stream_') && url.endsWith('.ts'))) {
      const filePath = join(STREAM_DIR, url.slice(1));
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const content = readFileSync(filePath);
      const contentType = url.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(content);
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

function safeWsSend(ws, payload) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (err) {
    console.error('WebSocket send error:', err);
  }
}

wss.on('connection', (ws) => {
  let ffmpegProcess = null;
  let isInitialized = false;

  ws.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'start' || msg.start) {
            startFfmpeg().catch((err) => {
              console.error('startFfmpeg error:', err);
              safeWsSend(ws, { error: 'failed_to_start_ffmpeg' });
            });
            isInitialized = true;
            safeWsSend(ws, { ok: true, message: 'Stream started', viewerUrl: `http://localhost:${PORT}/` });
          }
        } catch {
          safeWsSend(ws, { error: 'Invalid init message' });
        }
        return;
      }

      if (!isInitialized || !ffmpegProcess || !ffmpegProcess.stdin.writable) return;

      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      try {
        const canWrite = ffmpegProcess.stdin.write(buf);
        if (!canWrite) {
          console.warn('ffmpeg stdin backpressure: pausing WebSocket temporarily');
        }
      } catch (err) {
        console.error('ffmpeg stdin write error:', err.message);
      }
    } catch (outerErr) {
      console.error('WebSocket message handler error:', outerErr);
      safeWsSend(ws, { error: 'internal_stream_error' });
    }
  });

  async function startFfmpeg() {
    try {
      if (ffmpegProcess) {
        try {
          ffmpegProcess.stdin.end();
          ffmpegProcess.kill('SIGTERM');
        } catch {
          // ignore
        }
      }

      const { spawn } = await import('child_process');
      const outputPath = join(STREAM_DIR, 'stream.m3u8');
      ffmpegProcess = spawn('ffmpeg', [
        '-i', 'pipe:0',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-c:a', 'aac',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '5',
        '-hls_flags', 'delete_segments+append_list',
        '-hls_segment_filename', join(STREAM_DIR, 'stream_%03d.ts'),
        outputPath,
      ], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });

      ffmpegProcess.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        if (str.includes('Error') || str.includes('error')) {
          console.error('[ffmpeg]', str);
        }
      });

      ffmpegProcess.on('error', (err) => {
        console.error('ffmpeg spawn error:', err.message);
        safeWsSend(ws, { error: `ffmpeg error: ${err.message}` });
      });

      ffmpegProcess.on('close', (code, signal) => {
        ffmpegProcess = null;
        if (code !== 0 && code !== null) {
          console.log('[ffmpeg] exited with code', code);
        }
      });
    } catch (err) {
      console.error('startFfmpeg fatal error:', err);
      safeWsSend(ws, { error: 'ffmpeg_start_failed' });
      throw err;
    }
  }

  ws.on('close', () => {
    if (ffmpegProcess) {
      try {
        ffmpegProcess.stdin.end();
        ffmpegProcess.kill('SIGTERM');
      } catch {}
      ffmpegProcess = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Stream host server: http://localhost:${PORT}/ (시청 가능)`);
});
