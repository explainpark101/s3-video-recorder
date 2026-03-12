import React, { useState, useRef, useEffect } from 'react';
import { Camera, Mic, StopCircle, Settings, CheckCircle, AlertCircle, Play, Radio, MonitorPlay, Eye, Download, RefreshCw, FileVideo, Lock, Unlock, X, Share, CircleArrowOutDownLeft } from 'lucide-react';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const App = () => {
  const [currentView, setCurrentView] = useState('broadcast');
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('idle');
  const [uploadProgress, setUploadProgress] = useState({ currentPart: 0, totalSent: 0 });
  const [error, setError] = useState(null);
  const [savedKey, setSavedKey] = useState("");
  const [liveStreamReady, setLiveStreamReady] = useState(false);
  const [viewerUrl, setViewerUrl] = useState('');
  const [liveStreamError, setLiveStreamError] = useState(null);

  // S3 연결 정보는 오직 useState(In-Memory)에만 저장됩니다.
  // localStorage나 indexedDB를 사용하지 않으므로 탭 종료 시 자동 삭제됩니다.
  const [s3Config, setS3Config] = useState({
    bucketName: '',
    endpoint: '',
    region: 'us-east-1',
    accessKeyId: '',
    secretAccessKey: '',
    streamServerUrl: 'ws://localhost:3030',
  });

  // 암호화 모달 상태
  const [cryptoModal, setCryptoModal] = useState({ show: false, mode: 'export', password: '', fileData: null });

  // 시청 및 목록 상태
  const [fileList, setFileList] = useState([]);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [viewUrl, setViewUrl] = useState("");
  const [activePlayKey, setActivePlayKey] = useState("");

  const mediaRecorderRef = useRef(null);
  const videoPreviewRef = useRef(null);
  const streamWsRef = useRef(null);
  const streamWsRetryTimerRef = useRef(null);
  const streamRetryActiveRef = useRef(false);
  const pendingWsSendsRef = useRef(Promise.resolve());
  const uploadStateRef = useRef({
    uploadId: null,
    key: null,
    parts: [],
    partNumber: 1,
    buffer: [],
    bufferSize: 0,
    uploadPromises: [],
  });

  const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 최소 5MB (마지막 파트 제외)

  // --- Crypto Helpers (Web Crypto API) ---
  const deriveKey = async (password, salt) => {
    const encoder = new TextEncoder();
    const baseKey = await window.crypto.subtle.importKey(
      "raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  };

  const encryptConfig = async (password) => {
    try {
      const encoder = new TextEncoder();
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(password, salt);
      
      const encrypted = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(JSON.stringify(s3Config))
      );

      const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
      result.set(salt, 0);
      result.set(iv, 16);
      result.set(new Uint8Array(encrypted), 28);

      const blob = new Blob([result], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `s3-config-${new Date().getTime()}.enc`;
      a.click();
      setCryptoModal({ show: false, mode: 'export', password: '', fileData: null });
    } catch (err) {
      setError("암호화 내보내기에 실패했습니다.");
    }
  };

  const decryptConfig = async (password) => {
    try {
      const data = new Uint8Array(cryptoModal.fileData);
      const salt = data.slice(0, 16);
      const iv = data.slice(16, 28);
      const ciphertext = data.slice(28);

      const key = await deriveKey(password, salt);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
      );

      const decoded = new TextDecoder().decode(decrypted);
      const parsed = JSON.parse(decoded);
      const defaultConfig = {
        bucketName: '',
        endpoint: '',
        region: 'us-east-1',
        accessKeyId: '',
        secretAccessKey: '',
        streamServerUrl: 'ws://localhost:3030',
      };
      setS3Config({ ...defaultConfig, ...parsed });
      setCryptoModal({ show: false, mode: 'export', password: '', fileData: null });
    } catch (err) {
      setError("비밀번호가 틀렸거나 파일이 손상되었습니다.");
    }
  };

  const handleImportFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCryptoModal({ show: true, mode: 'import', password: '', fileData: ev.target.result });
    };
    reader.readAsArrayBuffer(file);
    e.target.value = null;
  };

  // --- S3 Logics ---
  const getS3Client = () => {
    const config = {
      region: s3Config.region,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
      forcePathStyle: true,
    };
    if (s3Config.endpoint) config.endpoint = s3Config.endpoint;
    return new S3Client(config);
  };

  const getFormattedDate = () => {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  };

  const initMultipartUpload = async (fileName) => {
    const client = getS3Client();
    const res = await client.send(new CreateMultipartUploadCommand({
      Bucket: s3Config.bucketName,
      Key: fileName,
      ContentType: 'video/webm',
    }));
    return res;
  };

  const uploadPart = async (chunk, partNumber, uploadId, key) => {
    const client = getS3Client();
    return await client.send(new UploadPartCommand({
      Body: chunk,
      Bucket: s3Config.bucketName,
      Key: key,
      PartNumber: partNumber,
      UploadId: uploadId,
    }));
  };

  const completeUpload = async (uploadId, key, parts) => {
    const client = getS3Client();
    return await client.send(new CompleteMultipartUploadCommand({
      Bucket: s3Config.bucketName,
      Key: key,
      MultipartUpload: { Parts: parts },
      UploadId: uploadId,
    }));
  };

  const connectStreamServer = (serverUrl) => {
    if (!serverUrl?.trim()) return null;
    setLiveStreamError(null);
    if (streamWsRetryTimerRef.current) {
      clearTimeout(streamWsRetryTimerRef.current);
      streamWsRetryTimerRef.current = null;
    }
    const prevWs = streamWsRef.current;
    if (prevWs) {
      try { prevWs.close(); } catch {}
      streamWsRef.current = null;
    }
    setLiveStreamReady(false);
    setViewerUrl('');
    const scheduleRetry = () => {
      if (!streamRetryActiveRef.current) return;
      streamWsRetryTimerRef.current = setTimeout(() => {
        streamWsRetryTimerRef.current = null;
        connectStreamServer(serverUrl);
      }, 5000);
    };
    try {
      const ws = new WebSocket(serverUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'start' }));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.ok) {
            setLiveStreamReady(true);
            setLiveStreamError(null);
            if (msg.viewerUrl) setViewerUrl(msg.viewerUrl);
            else {
              const u = new URL(serverUrl.replace('ws://', 'http://').replace('ws:', 'http:'));
              setViewerUrl(`${u.origin}/`);
            }
          }
          if (msg.error) setLiveStreamError(`라이브 송출: ${msg.error}`);
        } catch {}
      };
      ws.onerror = () => setLiveStreamError("스트리밍 서버 연결 실패. 녹화는 계속됩니다.");
      ws.onclose = () => {
        if (streamRetryActiveRef.current && streamWsRef.current === ws) {
          streamWsRef.current = null;
          scheduleRetry();
        }
      };
      streamWsRef.current = ws;
      return ws;
    } catch {
      setLiveStreamError("스트리밍 서버 연결 오류. 녹화는 계속됩니다.");
      if (streamRetryActiveRef.current) scheduleRetry();
      return null;
    }
  };

  const startStreaming = async () => {
    if (!s3Config.bucketName || !s3Config.accessKeyId || !s3Config.secretAccessKey) {
      setError("S3 설정을 먼저 완료해주세요.");
      return;
    }
    try {
      setError(null);
      setLiveStreamError(null);
      if (streamWsRef.current) {
        streamWsRef.current.close();
        streamWsRef.current = null;
      }
      if (s3Config.streamServerUrl?.trim()) {
        streamRetryActiveRef.current = true;
        connectStreamServer(s3Config.streamServerUrl);
      }
      const fileName = `${getFormattedDate()}.webm`;
      setSavedKey(fileName);
      const { UploadId } = await initMultipartUpload(fileName);
      uploadStateRef.current = { uploadId: UploadId, key: fileName, parts: [], partNumber: 1, buffer: [], bufferSize: 0, uploadPromises: [] };
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const combinedStream = new MediaStream([...screenStream.getVideoTracks(), ...micStream.getAudioTracks()]);
      if (videoPreviewRef.current) videoPreviewRef.current.srcObject = combinedStream;
      const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm; codecs=vp9,opus' });
      pendingWsSendsRef.current = Promise.resolve();
      const flushBuffer = async (isLastPart = false) => {
        const state = uploadStateRef.current;
        if (state.buffer.length === 0) return;
        const totalSize = state.buffer.reduce((s, c) => s + c.byteLength, 0);
        if (!isLastPart && totalSize < MIN_PART_SIZE) return;
        const chunks = state.buffer;
        state.buffer = [];
        state.bufferSize = 0;
        const num = state.partNumber++;
        setUploadProgress(prev => ({ ...prev, currentPart: num }));
        const combined = new Uint8Array(totalSize);
        let offset = 0;
        for (const c of chunks) { combined.set(new Uint8Array(c), offset); offset += c.byteLength; }
        const p = uploadPart(combined, num, state.uploadId, state.key)
          .then(({ ETag }) => { state.parts.push({ ETag, PartNumber: num }); setUploadProgress(prev => ({ ...prev, totalSent: prev.totalSent + combined.byteLength })); })
          .catch((err) => setError(`업로드 실패: ${err.message}`));
        state.uploadPromises.push(p);
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          const sendTask = (async () => {
            const state = uploadStateRef.current;
            const ab = await event.data.arrayBuffer();
            state.buffer.push(ab);
            state.bufferSize += event.data.size;
            const ws = streamWsRef.current;
            if (ws?.readyState === WebSocket.OPEN) {
              try { ws.send(ab); } catch {}
            }
            if (state.bufferSize >= MIN_PART_SIZE) await flushBuffer(false);
          })();
          pendingWsSendsRef.current = pendingWsSendsRef.current.then(() => sendTask);
        }
      };
      recorder.onstop = async () => {
        setRecordingStatus('processing');
        streamRetryActiveRef.current = false;
        if (streamWsRetryTimerRef.current) {
          clearTimeout(streamWsRetryTimerRef.current);
          streamWsRetryTimerRef.current = null;
        }
        combinedStream.getTracks().forEach(t => t.stop());
        setLiveStreamReady(false);
        setViewerUrl('');
        const ws = streamWsRef.current;
        if (ws) {
          try {
            await pendingWsSendsRef.current;
            ws.close();
          } catch {}
          streamWsRef.current = null;
        }
        try {
          await flushBuffer(true);
          await Promise.all(uploadStateRef.current.uploadPromises);
          await completeUpload(uploadStateRef.current.uploadId, uploadStateRef.current.key, uploadStateRef.current.parts.sort((a, b) => a.PartNumber - b.PartNumber));
          setRecordingStatus('success');
        } catch (err) { setError("최종 저장 실패"); setRecordingStatus('idle'); }
      };
      recorder.start(5000); 
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingStatus('recording');
    } catch (err) { setError(err.message); }
  };

  const stopStreaming = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const fetchFileList = async () => {
    if (!s3Config.bucketName || !s3Config.accessKeyId || !s3Config.secretAccessKey) return;
    setIsLoadingList(true);
    try {
      const client = getS3Client();
      const data = await client.send(new ListObjectsV2Command({ Bucket: s3Config.bucketName }));
      setFileList((data.Contents || []).sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified)));
    } catch (err) { setError("목록 조회 실패"); } finally { setIsLoadingList(false); }
  };

  const getFileUrl = async (key, download = false) => {
    try {
      const client = getS3Client();
      const command = new GetObjectCommand({
        Bucket: s3Config.bucketName,
        Key: key,
        ResponseContentDisposition: download ? `attachment; filename="${key}"` : 'inline',
      });
      return await getSignedUrl(client, command, { expiresIn: 3600 });
    } catch (err) { return ""; }
  };

  useEffect(() => { if (currentView === 'view') fetchFileList(); }, [currentView]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      {/* Crypto Modal */}
      {cryptoModal.show && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-sm rounded-3xl p-8 shadow-2xl space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold flex items-center gap-2">
                {cryptoModal.mode === 'export' ? <Lock className="text-blue-500" /> : <Unlock className="text-green-500" />}
                {cryptoModal.mode === 'export' ? '설정 암호화 내보내기' : '설정 복호화 가져오기'}
              </h3>
              <button onClick={() => setCryptoModal({...cryptoModal, show: false})} className="p-1 hover:bg-slate-800 rounded-lg"><X size={20} /></button>
            </div>
            <p className="text-xs text-slate-400">
              {cryptoModal.mode === 'export' 
                ? '파일을 보호하기 위한 마스터 비밀번호를 설정하세요.' 
                : '파일을 내보낼 때 사용했던 비밀번호를 입력하세요.'}
            </p>
            <input 
              type="password" 
              autoFocus
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-4 text-center text-lg tracking-[0.5em] outline-none focus:border-blue-500"
              placeholder="••••••••"
              value={cryptoModal.password}
              onChange={(e) => setCryptoModal({...cryptoModal, password: e.target.value})}
              onKeyDown={(e) => e.key === 'Enter' && (cryptoModal.mode === 'export' ? encryptConfig(cryptoModal.password) : decryptConfig(cryptoModal.password))}
            />
            <button 
              onClick={() => cryptoModal.mode === 'export' ? encryptConfig(cryptoModal.password) : decryptConfig(cryptoModal.password)}
              className={`w-full py-4 rounded-xl font-bold text-white transition-all active:scale-95 ${cryptoModal.mode === 'export' ? 'bg-blue-600' : 'bg-green-600'}`}
            >
              {cryptoModal.mode === 'export' ? '암호화 및 저장' : '복호화 및 불러오기'}
            </button>
          </div>
        </div>
      )}

      <nav className="bg-slate-900 border-b border-slate-800 px-6 py-2 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-6">
          <h2 className="text-xl font-black text-blue-500 flex items-center gap-2">
            <Radio size={24} /> S3-VideoRecorder
          </h2>
          <div className="flex gap-1">
            <button onClick={() => setCurrentView('broadcast')} className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${currentView === 'broadcast' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              <Camera size={16} /> 방송하기
            </button>
            <button onClick={() => setCurrentView('view')} className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${currentView === 'view' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
              <Eye size={16} /> 시청하기
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto p-6 md:p-8">
        {currentView === 'broadcast' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="aspect-video bg-black rounded-3xl border border-slate-800 overflow-hidden relative shadow-2xl">
                <video ref={videoPreviewRef} autoPlay muted className="w-full h-full object-contain" />
                {isRecording && (
                  <div className="absolute top-6 right-6 flex gap-2">
                    <div className="bg-red-600 px-4 py-1.5 rounded-full text-xs font-black flex items-center gap-2 shadow-lg animate-pulse">LIVE</div>
                    {s3Config.streamServerUrl?.trim() && liveStreamReady && (
                      <div className="bg-amber-600 px-4 py-1.5 rounded-full text-xs font-black flex items-center gap-2 shadow-lg">라이브 송출중</div>
                    )}
                  </div>
                )}
                {recordingStatus === 'idle' && <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600"><MonitorPlay size={80} className="mb-4 opacity-10" /><p>방송 시작 버튼을 눌러주세요</p></div>}
                {recordingStatus === 'success' && (
                  <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-md flex flex-col items-center justify-center text-center p-8">
                    <CheckCircle size={60} className="text-green-500 mb-4" />
                    <h3 className="text-2xl font-black mb-2">저장 완료!</h3>
                    <p className="text-slate-400 mb-6 font-mono text-sm">{savedKey}</p>
                    <button onClick={() => setRecordingStatus('idle')} className="bg-blue-600 text-white px-8 py-3 rounded-full font-bold">새 녹화 준비</button>
                  </div>
                )}
              </div>
              {isRecording && viewerUrl && (
                <div className="p-4 bg-slate-900 rounded-2xl border border-slate-800 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs text-slate-500 uppercase font-bold mb-1">시청 주소</p>
                    <p className="text-sm font-mono text-blue-400 truncate">{viewerUrl}</p>
                  </div>
                  <button onClick={() => window.open(viewerUrl)} className="shrink-0 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg text-sm font-bold">새 탭에서 열기</button>
                </div>
              )}
              <div className="flex items-center justify-between p-6 bg-slate-900 rounded-2xl border border-slate-800">
                <div className="space-y-1">
                  <h3 className="font-bold">방송 컨트롤</h3>
                  <p className="text-xs text-slate-500">{isRecording ? `업로드 중 (Part ${uploadProgress.currentPart})` : '대기 중'}</p>
                </div>
                {isRecording ? (
                  <button onClick={stopStreaming} className="bg-red-600 hover:bg-red-700 px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition-transform active:scale-95">
                    <StopCircle size={20} /> 방송 종료 및 저장
                  </button>
                ) : (
                  <button onClick={startStreaming} disabled={recordingStatus === 'processing'} className="bg-blue-600 hover:bg-blue-700 px-8 py-3 rounded-xl font-bold flex items-center gap-2 transition-transform active:scale-95">
                    <Mic size={20} /> 방송 시작하기
                  </button>
                )}
              </div>
            </div>
            
            <div className="space-y-6">
              <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="font-bold flex items-center gap-2 text-blue-400"><Settings size={18} /> 서버 설정</h3>
                  <div className="flex gap-2">
                    {/* 내보내기 버튼 */}
                    <button 
                      onClick={() => setCryptoModal({ show: true, mode: 'export', password: '', fileData: null })}
                      className="p-2 bg-slate-800 hover:bg-blue-600 rounded-lg transition-colors text-slate-300" 
                      title="내보내기"
                    >
                      <Share size={16} />
                    </button>
                    {/* 불러오기 버튼 */}
                    <label 
                      className="p-2 bg-slate-800 hover:bg-green-600 rounded-lg transition-colors text-slate-300 cursor-pointer" 
                      title="불러오기"
                    >
                      <CircleArrowOutDownLeft size={16} />
                      <input type="file" className="hidden" accept=".enc" onChange={handleImportFile} />
                    </label>
                  </div>
                </div>
                <div className="space-y-4">
                  {[{ label: "Endpoint", key: "endpoint", placeholder: "https://minio.yours.com" }, { label: "Bucket Name", key: "bucketName" }, { label: "Region", key: "region" }, { label: "Access Key", key: "accessKeyId", type: "password" }, { label: "Secret Key", key: "secretAccessKey", type: "password" }].map(f => (
                    <div key={f.key}>
                      <label className="block text-[10px] uppercase font-black text-slate-500 mb-1">{f.label}</label>
                      <input type={f.type || "text"} className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm focus:border-blue-500 outline-none transition-colors" value={s3Config[f.key]} placeholder={f.placeholder} onChange={(e) => setS3Config({...s3Config, [f.key]: e.target.value})} />
                    </div>
                  ))}
                  <div>
                    <label className="block text-[10px] uppercase font-black text-slate-500 mb-1">라이브 스트리밍 서버 (선택)</label>
                    <input type="text" className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm focus:border-blue-500 outline-none transition-colors" value={s3Config.streamServerUrl} placeholder="ws://localhost:3030" onChange={(e) => setS3Config({...s3Config, streamServerUrl: e.target.value})} />
                    {liveStreamError && <p className="mt-1 text-xs text-red-500">{liveStreamError}</p>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-6">
              <div className="aspect-video bg-black rounded-3xl border border-slate-800 overflow-hidden shadow-2xl relative">
                {viewUrl ? <video key={viewUrl} src={viewUrl} controls autoPlay className="w-full h-full object-contain" /> : <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-700"><Play size={80} className="mb-4 opacity-10" /><p>목록에서 영상을 선택하세요</p></div>}
              </div>
              {activePlayKey && (
                <div className="p-4 bg-slate-900 rounded-2xl border border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileVideo className="text-blue-500" />
                    <div><p className="text-sm font-bold truncate max-w-xs">{activePlayKey}</p><p className="text-[10px] text-slate-500 uppercase tracking-widest">Now Playing</p></div>
                  </div>
                  <button onClick={async () => { const url = await getFileUrl(activePlayKey, true); if (url) window.open(url); }} className="bg-slate-800 hover:bg-slate-700 p-2 rounded-lg transition-colors"><Download size={20} /></button>
                </div>
              )}
            </div>
            <div className="space-y-4">
              <div className="flex items-center justify-between px-2">
                <h3 className="font-bold flex items-center gap-2"><Eye size={18} className="text-blue-500" /> 녹화 목록</h3>
                <button onClick={fetchFileList} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-white"><RefreshCw size={16} className={isLoadingList ? 'animate-spin' : ''} /></button>
              </div>
              <div className="bg-slate-900 rounded-2xl border border-slate-800 overflow-hidden max-h-[600px] overflow-y-auto custom-scrollbar">
                {fileList.length === 0 ? <div className="p-12 text-center text-slate-600"><FileVideo size={48} className="mx-auto mb-2 opacity-10" /><p className="text-sm">저장된 영상이 없습니다.</p></div> : (
                  <div className="divide-y divide-slate-800">
                    {fileList.map((file) => (
                      <div key={file.Key} className={`p-4 hover:bg-slate-800/50 transition-colors group ${activePlayKey === file.Key ? 'bg-blue-900/10 border-l-4 border-l-blue-500' : ''}`}>
                        <div className="flex flex-col gap-2">
                          <p className="text-sm font-medium truncate text-slate-300">{file.Key}</p>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-slate-500">{(file.Size / 1024 / 1024).toFixed(2)} MB</span>
                            <div className="flex gap-2">
                              <button onClick={async () => { const url = await getFileUrl(file.Key); if (url) { setViewUrl(url); setActivePlayKey(file.Key); } }} className="text-[10px] font-bold bg-blue-600/20 text-blue-400 px-2 py-1 rounded hover:bg-blue-600 hover:text-white transition-all">재생</button>
                              <button onClick={async () => { const url = await getFileUrl(file.Key, true); if (url) window.open(url); }} className="text-[10px] font-bold bg-slate-800 text-slate-400 px-2 py-1 rounded hover:bg-slate-700 hover:text-white transition-all">다운로드</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="fixed bottom-8 right-8 bg-red-600/90 backdrop-blur text-white p-4 rounded-xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-4">
            <AlertCircle size={20} />
            <span className="text-sm font-bold">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;