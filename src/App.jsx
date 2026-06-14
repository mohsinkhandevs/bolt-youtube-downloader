import { useState, useEffect, useRef, useCallback } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';

/* ─────────────────────────────────────────────────────────────
   Tauri Bridge
   ───────────────────────────────────────────────────────────── */
const isTauri = typeof window !== 'undefined' && window.__TAURI__ !== undefined;

const invoke = isTauri
  ? window.__TAURI__.core.invoke
  : async (cmd, args) => {
      console.warn(`[Simulator] invoke "${cmd}"`, args);
      if (cmd === 'analyze_video') {
        if (args.analysis_mode === 'playlist') return JSON.stringify({
          _type: 'playlist', title: 'Simulated Playlist',
          entries: [
            { title: 'DevOps Basics', url: 'https://youtube.com/watch?v=1' },
            { title: 'Advanced Rust', url: 'https://youtube.com/watch?v=2' },
            { title: 'Tauri Setup',   url: 'https://youtube.com/watch?v=3' },
          ],
        });
        return JSON.stringify({
          title: 'Simulated Video (Browser Preview)', uploader: 'Creator Name',
          view_count: 1500000, duration_string: '10:30',
          thumbnail: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800',
          formats: [
            { format_id: '137', height: 1080, format_note: 'HQ', filesize: 104857600, vcodec: 'avc1', acodec: 'mp4a', ext: 'mp4' },
            { format_id: '136', height: 720,  format_note: 'MQ', filesize: 52428800,  vcodec: 'avc1', acodec: 'mp4a', ext: 'mp4' },
            { format_id: '135', height: 480,  format_note: 'SQ', filesize: 26214400,  vcodec: 'avc1', acodec: 'mp4a', ext: 'mp4' },
          ],
        });
      }
      if (cmd === 'resolve_unique_playlist_dir') return args.playlistTitle;
      if (cmd === 'get_default_download_directory') return 'C:\\Users\\MockUser\\Downloads';
      return '{}';
    };

const listen = isTauri
  ? window.__TAURI__.event.listen
  : async (_name, _cb) => () => {};

/* ─────────────────────────────────────────────────────────────
   Helpers & Robust URL Parser
   ───────────────────────────────────────────────────────────── */
const mapHeightToLabel = (h) => {
  const m = { 2160: '4K Ultra HD', 1440: '2K Quad HD', 1080: '1080p Full HD',
              720: '720p HD', 480: '480p SD', 360: '360p', 240: '240p', 144: '144p' };
  return m[parseInt(h)] || (h ? `${h}p` : 'Unknown');
};

const initSlot = () => ({
  progress: 0, speed: '—', eta: '—', size: '—',
  step: '', track: '', active: false, taskId: null, itemIndex: null,
});
const makeSlots = (n) => Array.from({ length: n }, initSlot);

const parseSpeedToBytes = (speedStr) => {
  if (!speedStr || speedStr === '—' || speedStr.includes('ffmpeg')) return 0;
  const match = speedStr.match(/([\d.]+)\s*([a-zA-Z/]+)/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.includes('gb') || unit.includes('gib')) return val * 1024 * 1024 * 1024;
  if (unit.includes('mb') || unit.includes('mib')) return val * 1024 * 1024;
  if (unit.includes('kb') || unit.includes('kib')) return val * 1024;
  return val;
};

const formatBytesToSpeed = (bytes) => {
  if (bytes === 0) return '—';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB/s`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB/s`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB/s`;
  return `${bytes} B/s`;
};

/**
 * Highly robust YouTube URL routing scanner.
 * Extracts video IDs and playlist IDs cleanly, ignoring trailing referral queries.
 */
const parseYoutubeUrl = (urlStr) => {
  const cleaned = urlStr.trim();
  if (!cleaned) return { isValid: false, hasVideo: false, hasPlaylist: false };

  let videoId = null;
  const videoRegexes = [
    /v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
    /embed\/([a-zA-Z0-9_-]{11})/,
    /live\/([a-zA-Z0-9_-]{11})/,
    /watch\/([a-zA-Z0-9_-]{11})/,
    /video\/([a-zA-Z0-9_-]{11})/,
    /vi\/([a-zA-Z0-9_-]{11})/,
    /\/v\/([a-zA-Z0-9_-]{11})/
  ];
  for (const rx of videoRegexes) {
    const match = cleaned.match(rx);
    if (match && match[1]) {
      videoId = match[1];
      break;
    }
  }

  let playlistId = null;
  const playlistRegexes = [
    /[&?]list=([a-zA-Z0-9_-]+)/,
    /\/playlist\?list=([a-zA-Z0-9_-]+)/,
    /\/@([a-zA-Z0-9_.-]+)/,
    /\/channel\/([a-zA-Z0-9_-]+)/,
    /\/c\/([a-zA-Z0-9_-]+)/,
    /\/user\/([a-zA-Z0-9_-]+)/
  ];
  for (const rx of playlistRegexes) {
    const match = cleaned.match(rx);
    if (match && match[1]) {
      playlistId = match[1];
      break;
    }
  }

  return {
    isValid: !!(videoId || playlistId),
    hasVideo: !!videoId,
    hasPlaylist: !!playlistId,
    videoId,
    playlistId
  };
};

/**
 * Strips playlist-related params from a URL so yt-dlp treats it as a single video.
 * Safely handles both standard and short-form URLs.
 */
const stripPlaylistParams = (urlStr) => {
  try {
    const u = new URL(urlStr.trim());
    u.searchParams.delete('list');
    u.searchParams.delete('index');
    u.searchParams.delete('start_radio');
    return u.toString();
  } catch {
    // Fallback regex strip for malformed URLs
    return urlStr
      .replace(/[?&]list=[^&#]*/g, '')
      .replace(/[?&]index=[^&#]*/g, '')
      .replace(/[?&]start_radio=[^&#]*/g, '')
      .replace(/\?&/, '?')
      .replace(/&&/, '&')
      .replace(/[?&]$/, '');
  }
};

/* ─────────────────────────────────────────────────────────────
   Design tokens
   ───────────────────────────────────────────────────────────── */
const T = {
  bg:      '#0b0908',
  surf:    '#141110',
  surf2:   '#1a1715',
  border:  '#272320',
  border2: '#332e2b',
  accent:  '#f97316',
  accentD: '#ea580c',
  text:    '#e7e5e4',
  muted:   '#78716c',
  hint:    '#44403c',
  mono:    "'JetBrains Mono', 'Fira Code', monospace",
  sans:    "'Outfit', system-ui, sans-serif",
};

/* ─────────────────────────────────────────────────────────────
   Shared sub-components
   ───────────────────────────────────────────────────────────── */
const Badge = ({ children, accent, color }) => (
  <span style={{
    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    padding: '2px 7px', borderRadius: 5, fontFamily: T.mono,
    background: accent ? 'rgba(249,115,22,0.12)' : color ? `${color}18` : T.surf2,
    border: `1px solid ${accent ? 'rgba(249,115,22,0.28)' : color ? `${color}40` : T.border}`,
    color: accent ? T.accent : color ?? T.muted,
  }}>{children}</span>
);

const stepColor = (step) => {
  if (!step) return T.accent;
  if (step.includes('JS'))    return '#f59e0b';
  if (step.includes('audio') || step.includes('Mux') || step.includes('Processing')) return '#a78bfa';
  return T.accent;
};

const SlotCard = ({ slot, index }) => (
  <div style={{
    background: T.bg, border: `1px solid ${slot.active ? T.border2 : T.border}`,
    borderRadius: 10, padding: '10px 12px',
    opacity: slot.active ? 1 : 0.45, transition: 'opacity 0.3s',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
      <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: slot.active ? T.accent : T.hint,
        background: slot.active ? 'rgba(249,115,22,0.1)' : T.surf2,
        border: `1px solid ${slot.active ? 'rgba(249,115,22,0.25)' : T.border}`,
        padding: '1px 6px', borderRadius: 4 }}>
        W{index + 1}
      </span>
      {slot.step && slot.active && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: stepColor(slot.step), animation: 'pulse-dot 1s ease-in-out infinite' }}/>
          <span style={{ fontFamily: T.mono, fontSize: 9, color: stepColor(slot.step), fontWeight: 600 }}>{slot.step}</span>
        </div>
      )}
    </div>

    {slot.track && (
      <p style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', marginBottom: 7 }} title={slot.track}>
        {slot.track}
      </p>
    )}

    <div style={{ height: 2, background: '#1c1917', borderRadius: 1, overflow: 'hidden', marginBottom: 6 }}>
      <div style={{ height: '100%', width: `${slot.progress}%`, background: `linear-gradient(90deg, ${T.accent}, ${T.accentD})`,
        borderRadius: 1, transition: 'width 0.3s' }}/>
    </div>

    <div style={{ display: 'flex', gap: 6, justifyContent: 'space-between' }}>
      {[['%', slot.progress.toFixed(1)], ['spd', slot.speed], ['eta', slot.eta]].map(([lbl, val]) => (
        <div key={lbl} style={{ textAlign: 'center', flex: 1 }}>
          <div style={{ fontSize: 8, color: T.hint, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{lbl}</div>
          <div style={{ fontFamily: T.mono, fontSize: 9, color: '#a8a29e', marginTop: 1 }}>{val}</div>
        </div>
      ))}
    </div>
  </div>
);

/* ─────────────────────────────────────────────────────────────
   Settings Panel
   ───────────────────────────────────────────────────────────── */
const SettingsPanel = ({ 
  open, 
  onClose, 
  concurrency, 
  setConcurrency, 
  fragmentConcurrency, 
  setFragmentConcurrency, 
  speedLimit, 
  setSpeedLimit,
  cookiesSource,
  setCookiesSource,
  cookiesBrowser,
  setCookiesBrowser,
  cookiesFilePath,
  setCookiesFilePath,
  onSelectCookiesFile
}) => {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={onClose}/>
      <div style={{
        position: 'relative', zIndex: 1, width: 350, height: '100%',
        background: T.surf, borderLeft: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '18px 20px 14px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/>
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
            </svg>
            <span style={{ fontWeight: 700, fontSize: 14 }}>Workspace Tuning</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', padding: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          
          {/* Section: Performance Tuning */}
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.hint, marginBottom: 16 }}>
              Engine Concurrency
            </p>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Parallel Slots</span>
                <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.accent }}>{concurrency}</span>
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                {Array.from({ length: 8 }, (_, i) => (
                  <button key={i} onClick={() => setConcurrency(i + 1)}
                    style={{
                      flex: 1, height: 24, borderRadius: 5, border: 'none', cursor: 'pointer',
                      background: i < concurrency ? T.accent : T.bg,
                      opacity: i < concurrency ? 1 : 0.3,
                      transition: 'all 0.15s',
                    }}/>
                ))}
              </div>
              <input type="range" min={1} max={8} value={concurrency}
                onChange={e => setConcurrency(Number(e.target.value))}
                style={{ width: '100%', accentColor: T.accent }}/>
            </div>
            
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Fragment Threads</span>
                  <p style={{ fontSize: 10, color: T.hint, marginTop: 2 }}>Parallel download chunks per file</p>
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.muted }}>{fragmentConcurrency}</span>
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                {[1, 2, 3, 4, 5, 6].map(n => (
                  <button key={n} onClick={() => setFragmentConcurrency(n)}
                    style={{
                      flex: 1, height: 22, borderRadius: 5, border: `1px solid ${fragmentConcurrency === n ? T.accent : T.border}`,
                      background: fragmentConcurrency === n ? 'rgba(249,115,22,0.15)' : T.bg,
                      color: fragmentConcurrency === n ? T.accent : T.hint,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s',
                    }}>{n}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Section: Bandwidth Rate-Limiting */}
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.hint, marginBottom: 16 }}>
              Network & Traffic Control
            </p>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>Speed Limit</span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['No limit', '1M', '2M', '5M', '10M'].map(v => (
                  <button key={v} onClick={() => setSpeedLimit(v)}
                    style={{
                      padding: '5px 12px', borderRadius: 7, border: `1px solid ${speedLimit === v ? T.accent : T.border}`,
                      background: speedLimit === v ? 'rgba(249,115,22,0.1)' : T.bg,
                      color: speedLimit === v ? T.accent : T.hint,
                      fontFamily: T.mono, fontSize: 11, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                    }}>{v}</button>
                ))}
              </div>
            </div>
          </div>

          {/* Section: YouTube Bot Bypass Configuration */}
          <div style={{ marginBottom: 20, borderTop: `1px solid ${T.border}`, paddingTop: 20 }}>
            <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.accent, marginBottom: 14 }}>
              Bot Check Bypass (Cookies)
            </p>
            
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 8 }}>Bypass Method</label>
              <select 
                value={cookiesSource} 
                onChange={e => setCookiesSource(e.target.value)}
                style={{ width: '100%', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px', color: T.text, fontSize: 12, fontFamily: T.sans }}
              >
                <option value="none">Disabled (Direct Unauthenticated)</option>
                <option value="browser">Import Session from Browser</option>
                <option value="file">Load Custom cookies.txt File</option>
              </select>
            </div>

            {cookiesSource === 'browser' && (
              <div style={{ marginBottom: 16, background: 'rgba(249,115,22,0.05)', border: `1px dashed ${T.border}`, borderRadius: 8, padding: 12 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Target Web Browser</label>
                <select 
                  value={cookiesBrowser} 
                  onChange={e => setCookiesBrowser(e.target.value)}
                  style={{ width: '100%', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', color: T.text, fontSize: 11 }}
                >
                  <option value="chrome">Google Chrome</option>
                  <option value="firefox">Mozilla Firefox</option>
                  <option value="edge">Microsoft Edge</option>
                  <option value="brave">Brave Browser</option>
                  <option value="safari">Apple Safari</option>
                  <option value="opera">Opera</option>
                  <option value="vivaldi">Vivaldi</option>
                </select>
                <p style={{ fontSize: 10, color: T.muted, marginTop: 8, lineHeight: 1.45 }}>
                  ⚠️ <strong>Note:</strong> Chromium browsers (Chrome, Edge, Brave, etc.) lock their database while open. Close your browser briefly before running downloads to allow database reads.
                </p>
              </div>
            )}

            {cookiesSource === 'file' && (
              <div style={{ marginBottom: 16, background: 'rgba(56,189,248,0.04)', border: `1px dashed ${T.border}`, borderRadius: 8, padding: 12 }}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 6 }}>Select cookies.txt File</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input 
                    type="text" 
                    readOnly 
                    placeholder="Path to cookies.txt..."
                    value={cookiesFilePath}
                    style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: '4px 8px', color: T.muted, fontFamily: T.mono, fontSize: 9 }}
                  />
                  <button 
                    onClick={onSelectCookiesFile}
                    style={{ background: T.border, border: `1px solid ${T.border2}`, color: T.text, borderRadius: 6, padding: '0 10px', fontSize: 11, fontWeight: 600 }}
                  >
                    Select
                  </button>
                </div>
                <p style={{ fontSize: 10, color: T.muted, marginTop: 8, lineHeight: 1.45 }}>
                  💡 Use standard extensions (e.g. <em>Get cookies.txt LOCALLY</em>) to export Netscape format cookies directly from your active YouTube tab.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ─────────────────────────────────────────────────────────────
   Main App Component
   ───────────────────────────────────────────────────────────── */
export default function App() {
  const handleOpenLink = async (targetUrl) => {
    if (isTauri) {
      try {
        await openUrl(targetUrl);
      } catch (err) {
        console.error('Failed to open link in system browser:', err);
        window.open(targetUrl, '_blank');
      }
    } else {
      window.open(targetUrl, '_blank');
    }
  };

  const [url, setUrl]               = useState('');
  const [loading, setLoading]       = useState(false);
  const [videoInfo, setVideoInfo]   = useState(null);
  const [rawJson, setRawJson]       = useState(null);
  const [selectedFormat, setSelectedFormat] = useState('');
  const [downloadDir, setDownloadDir] = useState('');
  const [isPlaylistMode, setIsPlaylistMode] = useState(false);
  const [isAudioOnly, setIsAudioOnly]     = useState(false);
  const [logs, setLogs]             = useState([]);

  // Default to single video mode
  const [analysisMode, setAnalysisMode] = useState('video');

  // Floating readable Toast notifications
  const [toast, setToast] = useState(null);

  const [tasks, setTasks]           = useState([]);
  const [concurrency, setConcurrency]               = useState(3);
  const [fragmentConcurrency, setFragmentConcurrency] = useState(2);
  const [speedLimit, setSpeedLimit]                 = useState('No limit');
  const [showSettings, setShowSettings]             = useState(false);

  // Bot Check Bypass States
  const [cookiesSource, setCookiesSource]     = useState('none'); // 'none' | 'browser' | 'file'
  const [cookiesBrowser, setCookiesBrowser]   = useState('chrome');
  const [cookiesFilePath, setCookiesFilePath] = useState('');

  const [slots, setSlots] = useState(() => makeSlots(3));

  const terminalRef        = useRef(null);
  const activeDownloadsRef = useRef({});
  const pausedTasksRef     = useRef({}); // Synchronous reference mapping representing explicit user pause requests

  // State Synchronization Refs
  const slotsRef               = useRef(slots);
  const tasksRef               = useRef(tasks);
  const fragmentConcurrencyRef = useRef(fragmentConcurrency);
  const speedLimitRef          = useRef(speedLimit);

  // Authentication bypass refs
  const cookiesSourceRef       = useRef(cookiesSource);
  const cookiesBrowserRef     = useRef(cookiesBrowser);
  const cookiesFilePathRef    = useRef(cookiesFilePath);

  // Synchronous State-to-Ref Writers to prevent render timing race conditions
  const setAndRefSlots = useCallback((updater) => {
    setSlots(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      slotsRef.current = next;
      return next;
    });
  }, []);

  const setAndRefTasks = useCallback((updater) => {
    setTasks(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      tasksRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => { fragmentConcurrencyRef.current = fragmentConcurrency; }, [fragmentConcurrency]);
  useEffect(() => { speedLimitRef.current = speedLimit; },     [speedLimit]);
  useEffect(() => { cookiesSourceRef.current = cookiesSource; },     [cookiesSource]);
  useEffect(() => { cookiesBrowserRef.current = cookiesBrowser; },   [cookiesBrowser]);
  useEffect(() => { cookiesFilePathRef.current = cookiesFilePath; }, [cookiesFilePath]);

  // Toast Notification handler with automatic fade-out
  const triggerToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, []);

  const addLog = useCallback((line) => {
    setLogs(prev => [...prev.slice(-300), line]);
    
    // Auto-intercept any stream errors in background to trigger human-readable popup
    if (line.includes('[error]') || line.includes('Error:') || line.includes('failed:')) {
      let readable = "System process encountered an issue. Check connection.";
      if (line.includes("Sign in to confirm you are not a bot")) {
        readable = "⚠️ YouTube Bot Check Triggered! Please enable 'Bot Check Bypass' in settings.";
      } else if (line.includes("Unsupported URL")) {
        readable = "⚠️ Invalid URL address format. Double check your YouTube link.";
      } else if (line.includes("Permission denied") || line.includes("locked")) {
        readable = "⚠️ Output directory locked or read-only. Run as admin or change path.";
      } else if (line.includes("ffmpeg")) {
        readable = "⚠️ Muxing engine issue. Re-try or verify audio/video profile.";
      }
      triggerToast(readable, "error");
    }
  }, [triggerToast]);

  const updateSlot = useCallback((idx, patch) => {
    setAndRefSlots(prev => {
      if (idx < 0 || idx >= prev.length) return prev;
      if (prev[idx].taskId === null && patch.taskId === undefined) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }, [setAndRefSlots]);

  /* Font injection */
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }, []);

  /* Default download dir */
  useEffect(() => {
    invoke('get_default_download_directory')
      .then(setDownloadDir)
      .catch(err => addLog(`[error] ${err}`));
  }, [addLog]);

  /* Re-parse formats when rawJson or audio toggle changes */
  useEffect(() => {
    if (!rawJson) { setVideoInfo(null); return; }
    const parsed = rawJson;
    if (parsed._type === 'playlist') {
      const fmts = isAudioOnly
        ? [{ id: 'bestaudio', label: '320 kbps', sub: 'Best quality MP3',  size: 'Auto' },
           { id: '128',       label: '128 kbps', sub: 'Standard MP3',      size: 'Auto' }]
        : [{ id: '1080', label: '1080p Full HD', sub: 'Dynamic', size: 'Auto' },
           { id: '720',  label: '720p HD',       sub: 'Dynamic', size: 'Auto' },
           { id: '480',  label: '480p SD',        sub: 'Dynamic', size: 'Auto' },
           { id: '360',  label: '360p',           sub: 'Dynamic', size: 'Auto' }];
      setVideoInfo({ isPlaylist: true, title: parsed.title || 'Playlist',
        author: parsed.uploader || '—', views: `${parsed.entries?.length ?? 0} videos`,
        duration: 'Multiple', thumbnail: null, formats: fmts });
      if (fmts.length > 0) setSelectedFormat(fmts[0].id);
    } else {
      let unique = [];
      if (isAudioOnly) {
        const af = (parsed.formats || []).filter(f => f.vcodec === 'none' && f.acodec !== 'none').map(f => {
          const abr = f.abr || 128;
          const sz  = f.filesize || f.filesize_approx;
          return { id: f.format_id, label: abr >= 250 ? '320 kbps' : abr >= 190 ? '256 kbps' : abr >= 120 ? '128 kbps' : '96 kbps',
            sub: abr >= 250 ? 'Extreme' : abr >= 190 ? 'High' : abr >= 120 ? 'Standard' : 'Economy',
            abr, size: sz ? `~${(sz / 1048576).toFixed(1)} MB` : 'Auto' };
        });
        const seen = new Set();
        for (const f of af) { if (!seen.has(f.label)) { seen.add(f.label); unique.push(f); } }
        unique.sort((a, b) => b.abr - a.abr);
      } else {
        const vf = (parsed.formats || []).filter(f => f.vcodec !== 'none' && f.height).map(f => {
          const sz = f.filesize || f.filesize_approx;
          return { id: f.format_id, label: mapHeightToLabel(f.height),
            sub: f.format_note || 'Standard', height: f.height,
            size: sz ? `~${(sz / 1048576).toFixed(1)} MB` : 'Auto' };
        });
        const seen = new Set();
        for (const f of vf) { if (!seen.has(f.height)) { seen.add(f.height); unique.push(f); } }
        unique.sort((a, b) => b.height - a.height);
      }
      const finalFormats = unique.slice(0, 8);
      setVideoInfo({ isPlaylist: false, title: parsed.title, author: parsed.uploader || 'Unknown',
        views: parsed.view_count ? `${(parsed.view_count / 1e6).toFixed(1)}M views` : '—',
        duration: parsed.duration_string || '—', thumbnail: parsed.thumbnail || null,
        formats: finalFormats });
      if (finalFormats.length > 0) setSelectedFormat(finalFormats[0].id);
    }
  }, [rawJson, isAudioOnly]);

  /* Log event listener */
  useEffect(() => {
    let unsub;
    let active = true;

    const setup = async () => {
      const unlistenFn = await listen('download-log', (event) => {
        if (!active) return;

        const payload  = event.payload;
        const slotIdx  = (typeof payload === 'object' && payload !== null) ? (payload.slot ?? 0) : 0;
        const line     = (typeof payload === 'object' && payload !== null) ? payload.line : payload;

        addLog(line);

        // Destination / track name
        const destMatch = line.match(/\[download\] Destination:.*[/\\](.+)\.(webm|mp4|m4a|opus|ogg)$/i);
        if (destMatch) {
          updateSlot(slotIdx, { track: destMatch[1].replace(/^\d+ - /, ''), step: 'Downloading', active: true });
          return;
        }

        // Processing steps
        if (line.includes('Downloading webpage'))   { updateSlot(slotIdx, { step: 'Fetching page',    active: true }); return; }
        if (line.includes('Downloading android'))   { updateSlot(slotIdx, { step: 'Fetching API',     active: true }); return; }
        if (line.includes('[jsc:deno]'))            { updateSlot(slotIdx, { step: 'Solving JS…',      active: true }); return; }
        if (line.includes('Downloading m3u8'))      { updateSlot(slotIdx, { step: 'Stream info',      active: true }); return; }
        if (line.includes('[ExtractAudio]'))        { updateSlot(slotIdx, { step: 'Extracting audio', speed: 'ffmpeg', eta: '—', active: true }); return; }
        if (line.includes('Deleting original'))     { updateSlot(slotIdx, { step: 'Cleaning up' });   return; }
        if (line.includes('[ffmpeg]'))              { updateSlot(slotIdx, { step: 'Muxing', speed: 'ffmpeg', eta: '—' }); return; }

        // Per-file download progress
        if (line.includes('[download]') && line.includes('%')) {
          const pct = line.match(/(\d+(?:\.\d+)?)%/);
          const spd = line.match(/at\s+([\d.]+\s*\S+\/s)/);
          const et  = line.match(/ETA\s+(\S+)/);
          const sz  = line.match(/of\s+([\d.]+\S+)/);
          const patch = { active: true };
          if (pct) {
            const parsedPct = parseFloat(pct[1]);
            patch.progress = parsedPct;
            if (parsedPct >= 100) patch.step = 'Processing';
          }
          if (spd) patch.speed = spd[1];
          if (et && !et[1].includes('Unknown')) patch.eta = et[1];
          if (sz)  patch.size = sz[1];
          updateSlot(slotIdx, patch);
        }
      });

      if (!active) {
        unlistenFn();
      } else {
        unsub = unlistenFn;
      }
    };

    setup();
    return () => { active = false; if (unsub) unsub(); };
  }, [addLog, updateSlot]);

  /* Auto-scroll terminal */
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [logs]);

  /* Synchronous Runtime Concurrency Controller - fixes concurrency resize bugs */
  const handleUpdateConcurrency = (newVal) => {
    setConcurrency(newVal);
    const prevSlots = slotsRef.current;
    
    // Immediately terminate orphaned background tasks if parallel slot capability is reduced
    if (newVal < prevSlots.length) {
      for (let i = newVal; i < prevSlots.length; i++) {
        const s = prevSlots[i];
        if (s?.active) {
          invoke('cancel_slot', { slotId: i });
          if (s.taskId) {
            delete activeDownloadsRef.current[`${s.taskId}-${s.itemIndex}`];
          }
        }
      }
    }

    // Synchronously resize backing slot array model immediately to prevent race conditions in scheduler
    const nextSlots = makeSlots(newVal);
    prevSlots.forEach((s, i) => { if (i < newVal) nextSlots[i] = s; });
    setAndRefSlots(nextSlots);
  };

  /* ── Analyze ─────────────────────────────────────────────── */
  const handleAnalyze = async () => {
    if (!url.trim()) return;

    // Run semantic link scanning
    const parsedUrl = parseYoutubeUrl(url);

    // Strict validation based on target workspace mode
    if (analysisMode === 'video' && !parsedUrl.hasVideo) {
      setVideoInfo(null);
      setSelectedFormat('');
      setRawJson(null);
      triggerToast("Provided link is not a video URL", "error");
      addLog("[error] Provided link contains no video ID");
      return;
    }

    if (analysisMode === 'playlist' && !parsedUrl.hasPlaylist) {
      setVideoInfo(null);
      setSelectedFormat('');
      setRawJson(null);
      triggerToast("Provided link is not a playlist URL", "error");
      addLog("[error] Provided link contains no playlist ID");
      return;
    }

    // For dual URLs (video + playlist): sanitize before passing to backend
    let effectiveUrl = url.trim();
    if (parsedUrl.hasVideo && parsedUrl.hasPlaylist) {
      if (analysisMode === 'video') {
        effectiveUrl = stripPlaylistParams(effectiveUrl);
        addLog('[sys] Dual URL detected: playlist params stripped for Single Video mode.');
      } else {
        addLog('[sys] Dual URL detected: using full Playlist mode.');
      }
    }

    setLoading(true); setVideoInfo(null); setSelectedFormat(''); setRawJson(null);
    addLog(`[sys] Scanning target link under ${analysisMode === 'video' ? 'SINGLE VIDEO' : 'PLAYLIST'} workspace mode...`);
    try {
      const payload = {
        url: effectiveUrl,
        analysisMode,
        cookiesSource,
        cookiesBrowser,
        cookiesFilePath
      };
      
      const parsed = JSON.parse(await invoke('analyze_video', payload));
      if (parsed._type === 'playlist') {
        setIsPlaylistMode(true);
        triggerToast("✓ Playlist successfully parsed!", "success");
        addLog(`[sys] Link identified: Playlist containing ${parsed.entries?.length ?? 0} items.`);
      } else {
        setIsPlaylistMode(false);
        triggerToast("✓ Video stream analyzed!", "success");
        addLog('[sys] Link identified: Single Video context.');
      }
      setRawJson(parsed);
    } catch (err) {
      addLog(`[error] ${err}`);
      triggerToast("⚠️ Connection failed. Please check network link.", "error");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectFolder = async () => {
    try {
      const sel = await invoke('select_download_directory');
      if (sel) { setDownloadDir(sel); addLog(`[sys] Output path: ${sel}`); }
    } catch (err) { addLog(`[error] ${err}`); }
  };

  const handleOpenFolder = async () => {
    if (!downloadDir) return;
    try { await invoke('open_folder', { path: downloadDir }); }
    catch (err) { addLog(`[error] ${err}`); }
  };

  const handleSelectCookiesFile = async () => {
    try {
      const path = await invoke('select_cookies_file');
      if (path) {
        setCookiesFilePath(path);
        addLog(`[sys] Cookies file loaded: ${path}`);
      }
    } catch (err) {
      addLog(`[error] Failed to select cookies file: ${err}`);
    }
  };

  /* ── Queue Management ───────────────────────────────────── */
  const handleAddTask = async () => {
    if (!videoInfo || !rawJson) return;

    let playlistFolder = null;
    if (rawJson._type === 'playlist') {
      // Automatically append quality profile directly to the playlist folder name to keep it distinct
      const formatLabel = isAudioOnly 
        ? (selectedFormat === '128' ? '128kbps' : '320kbps') 
        : `${selectedFormat}p`;
        
      const folderWithQuality = `${videoInfo.title} [${formatLabel}]`;
      
      playlistFolder = await invoke('resolve_unique_playlist_dir', {
        customDir: downloadDir,
        playlistTitle: folderWithQuality
      });
      addLog(`[sys] Resolved unique folder: ${playlistFolder}`);
    }

    const items = rawJson._type === 'playlist'
      ? rawJson.entries.map((entry, idx) => {
          const entryUrl = entry.url || entry.id;
          const fullUrl = (entryUrl && !entryUrl.startsWith('http'))
            ? `https://www.youtube.com/watch?v=${entryUrl}`
            : entryUrl;
          return { index: idx, title: entry.title || `Item ${idx + 1}`, url: fullUrl || entry.url, status: 'queued', progress: 0 };
        })
      : [{ index: 0, title: videoInfo.title, url, status: 'queued', progress: 0 }];

    const newTask = {
      id: crypto.randomUUID(),
      title: videoInfo.title,
      type: rawJson._type === 'playlist' ? 'playlist' : 'video',
      totalItems: items.length,
      completedItems: 0,
      status: 'queued',
      formatId: selectedFormat,
      isAudioOnly,
      customDir: downloadDir,
      playlistFolder,
      cookiesSource,
      cookiesBrowser,
      cookiesFilePath,
      items,
    };

    setAndRefTasks(prev => [...prev, newTask]);
    triggerToast("✓ Stream added to download manager!", "success");
    addLog(`[sys] Task added to queue: "${videoInfo.title}" (${items.length} file${items.length > 1 ? 's' : ''})`);

    setUrl('');
    setVideoInfo(null);
    setRawJson(null);
  };

  /* Bulletproof Pausing Action - Terminates processes on the backend synchronously */
  const handlePauseTask = useCallback((taskId) => {
    pausedTasksRef.current[taskId] = true;

    // Immediately update standard React tasks list state in batch
    setAndRefTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t;
      return {
        ...t,
        status: 'paused',
        items: t.items.map(it =>
          it.status === 'downloading' ? { ...it, status: 'queued', progress: 0 } : it
        ),
      };
    }));

    // Synchronously instruct backend to cancel all running downloads for this task
    invoke('cancel_task', { taskId });

    // Instantly wipe running slots matching paused task ID on frontend
    setAndRefSlots(prev => prev.map(s => {
      if (s.taskId === taskId) {
        delete activeDownloadsRef.current[`${taskId}-${s.itemIndex}`];
        return initSlot();
      }
      return s;
    }));

    triggerToast("Task paused.", "info");
    addLog('[sys] Task queue paused.');
  }, [addLog, triggerToast, setAndRefTasks, setAndRefSlots]);

  const handleResumeTask = useCallback((taskId) => {
    delete pausedTasksRef.current[taskId];
    setAndRefTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status: 'queued' } : t
    ));
    triggerToast("Resuming download sequence...", "success");
    addLog('[sys] Task queue resumed.');
  }, [addLog, triggerToast, setAndRefTasks]);

  /* Bulletproof Deletion & Thread Cleanups */
  const handleRemoveTask = useCallback((taskId) => {
    // Synchronously tell backend to cancel all processes associated with this task ID
    invoke('cancel_task', { taskId });

    // Remove task from state list
    setAndRefTasks(prev => prev.filter(t => t.id !== taskId));

    // Clear locks
    const slotsToCancel = slotsRef.current.filter(s => s.taskId === taskId);
    slotsToCancel.forEach(s => {
      delete activeDownloadsRef.current[`${taskId}-${s.itemIndex}`];
    });

    // Clear slot views
    setAndRefSlots(prev => prev.map(s => {
      if (s.taskId === taskId) {
        return initSlot();
      }
      return s;
    }));

    triggerToast("Task canceled and deleted.", "info");
    addLog('[sys] Task completely terminated and removed from workspace.');
  }, [addLog, triggerToast, setAndRefTasks, setAndRefSlots]);

  /* ── Download Trigger Task ── */
  const triggerSingleDownload = useCallback(async (task, item, slotId) => {
    activeDownloadsRef.current[`${task.id}-${item.index}`] = true;

    updateSlot(slotId, {
      active:    true,
      taskId:    task.id,
      itemIndex: item.index,
      track:     item.title,
      step:      'Connecting…',
      progress:  0,
      speed:     '—',
      eta:       '—',
    });

    try {
      await invoke('download_single_item', {
        url:                 item.url,
        videoTitle:          item.title,
        formatId:            task.formatId,
        customDir:           task.customDir,
        playlistFolder:      task.playlistFolder,
        isAudioOnly:         task.isAudioOnly,
        slotId,
        fragmentConcurrency: fragmentConcurrencyRef.current,
        speedLimit:          speedLimitRef.current === 'No limit' ? '' : speedLimitRef.current,
        cookiesSource:       task.cookiesSource || cookiesSourceRef.current,
        cookiesBrowser:      task.cookiesBrowser || cookiesBrowserRef.current,
        cookiesFilePath:     task.cookiesFilePath || cookiesFilePathRef.current,
        taskId:              task.id,
        itemIndex:           item.index,
        totalItems:          task.totalItems,
      });

      setAndRefTasks(prevTasks => prevTasks.map(t => {
        if (t.id !== task.id) return t;
        const nextItems = t.items.map((it, idx) =>
          idx === item.index ? { ...it, status: 'completed', progress: 100 } : it
        );
        const completedCount = nextItems.filter(it => it.status === 'completed').length;
        const isFinished = completedCount === t.totalItems;
        return { ...t, items: nextItems, completedItems: completedCount, status: isFinished ? 'completed' : t.status };
      }));
      addLog(`[sys] ✓ Completed: ${item.title}`);

    } catch (err) {
      const errStr = String(err);
      const isExplicitlyPaused = pausedTasksRef.current[task.id];

      setAndRefTasks(prevTasks => {
        if (!prevTasks.some(t => t.id === task.id)) return prevTasks;
        return prevTasks.map(t => {
          if (t.id !== task.id) return t;
          const nextItems = t.items.map((it, idx) =>
            idx === item.index && it.status === 'downloading'
              ? { ...it, status: 'queued', progress: 0 }
              : it
          );
          return { 
            ...t, 
            items: nextItems, 
            status: isExplicitlyPaused ? 'paused' : (t.status === 'downloading' ? 'queued' : t.status) 
          };
        });
      });
      if (!errStr.includes('aborted') && !errStr.includes('cancelled') && !errStr.includes('slot controller')) {
        addLog(`[error] Download failed: ${errStr}`);
      }

    } finally {
      delete activeDownloadsRef.current[`${task.id}-${item.index}`];
      setAndRefSlots(prev => {
        const next = [...prev];
        if (next[slotId] && next[slotId].taskId === task.id && next[slotId].itemIndex === item.index) {
          next[slotId] = initSlot();
        }
        return next;
      });
    }
  }, [addLog, updateSlot, setAndRefTasks, setAndRefSlots]);

  /* Robust Parallel Scheduler Hook */
  const runScheduler = useCallback(() => {
    const currentSlots = slotsRef.current;
    const currentTasks = tasksRef.current;

    const activeSlotsList = currentSlots
      .map((s, idx) => ({ ...s, idx }))
      .filter(s => s.active);
    const activeCount = activeSlotsList.length;

    // Handle high-priority downsizing requests dynamically without thread locks
    if (activeCount > concurrency) {
      const toKill = [...activeSlotsList]
        .sort((a, b) => a.progress - b.progress)
        .slice(0, activeCount - concurrency);

      toKill.forEach(s => {
        invoke('cancel_slot', { slotId: s.idx });
        delete activeDownloadsRef.current[`${s.taskId}-${s.itemIndex}`];
        setAndRefSlots(prev => {
          const next = [...prev];
          next[s.idx] = initSlot();
          return next;
        });
        setAndRefTasks(prev => prev.map(t =>
          t.id === s.taskId
            ? {
                ...t,
                items: t.items.map((it, i) =>
                  i === s.itemIndex && it.status === 'downloading'
                    ? { ...it, status: 'queued', progress: 0 }
                    : it
                ),
              }
            : t
        ));
      });
      return;
    }

    const emptySlotIds = [];
    for (let i = 0; i < concurrency; i++) {
      if (!currentSlots[i]?.active) emptySlotIds.push(i);
    }
    if (emptySlotIds.length === 0) return;

    const toStart = [];
    for (const t of currentTasks) {
      if (t.status === 'paused' || t.status === 'completed' || t.status === 'failed') continue;
      for (const item of t.items) {
        if (item.status !== 'queued') continue;
        const key = `${t.id}-${item.index}`;
        if (activeDownloadsRef.current[key]) continue;
        if (toStart.length >= emptySlotIds.length) break;
        toStart.push({ task: t, item, slotId: emptySlotIds[toStart.length] });
      }
      if (toStart.length >= emptySlotIds.length) break;
    }

    if (toStart.length === 0) return;

    setAndRefTasks(prev => prev.map(t => {
      const starting = toStart.filter(s => s.task.id === t.id);
      if (starting.length === 0) return t;
      return {
        ...t,
        status: t.status === 'queued' ? 'downloading' : t.status,
        items: t.items.map(item => {
          const found = starting.find(s => s.item.index === item.index);
          return found ? { ...item, status: 'downloading' } : item;
        }),
      };
    }));

    toStart.forEach(({ task, item, slotId }) => {
      triggerSingleDownload(task, item, slotId);
    });
  }, [concurrency, triggerSingleDownload, setAndRefSlots, setAndRefTasks]);

  useEffect(() => {
    runScheduler();
  }, [tasks, concurrency, runScheduler]);

  const handleReset = async () => {
    if (loading) {
      try { await invoke('abort_analysis'); addLog('[sys] Analysis terminated.'); }
      catch (err) { console.error('Failed to abort analysis:', err); }
      setLoading(false);
    }

    try { await invoke('cancel_all'); } catch (_) {}

    activeDownloadsRef.current = {};
    pausedTasksRef.current = {};

    setUrl('');
    setVideoInfo(null);
    setRawJson(null);
    setAndRefTasks([]);
    setAndRefSlots(makeSlots(concurrency));
    setLogs(['[sys] Software fully refreshed. Ready.']);
    triggerToast("System completely refreshed.", "success");

    try {
      const dir = await invoke('get_default_download_directory');
      setDownloadDir(dir);
    } catch (_) {}
  };

  const getCombinedSpeed = () => {
    let totalBytes = 0;
    slots.forEach(s => { if (s.active && s.speed) totalBytes += parseSpeedToBytes(s.speed); });
    return formatBytesToSpeed(totalBytes);
  };

  const cumulativeSpeed = getCombinedSpeed();
  const activeCount     = slots.filter(s => s.active).length;

  return (
    <div style={{ fontFamily: T.sans, background: T.bg, minHeight: '100vh', color: T.text, padding: '20px 24px' }}>
      <style>{`
        @keyframes spin      { to { transform: rotate(360deg); } }
        @keyframes pulse-dot { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
        @keyframes slide-in  { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:${T.border2}; border-radius:4px; }
        input::placeholder { color:${T.hint}; }
        input:focus { outline:none; }
        button { cursor:pointer; font-family:${T.sans}; }
        button:disabled { cursor:not-allowed; }
        .fmt-card:hover { border-color:${T.border2} !important; }
        .fmt-card.sel { border-color:rgba(249,115,22,0.5) !important; background:rgba(249,115,22,0.07) !important; }
        .link-btn { background:none; border:none; font-size:11px; font-weight:600; padding:0; transition:color 0.15s; }
        .tog-btn  { padding:5px 14px; border-radius:7px; border:none; font-size:11px; font-weight:700; transition:all 0.2s; }
        .small-tog { padding:5px 16px; border-radius:6px; border:1px solid transparent; font-size:12px; font-weight:700; transition:all 0.15s; }
        input[type=range] { width:100%; accent-color:${T.accent}; }
      `}</style>

      {/* DevOps Floating Toast Message popup */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 100,
          background: toast.type === 'error' ? 'rgba(239,68,68,0.95)' : toast.type === 'success' ? 'rgba(16,185,129,0.95)' : 'rgba(249,115,22,0.95)',
          color: '#ffffff', padding: '12px 24px', borderRadius: 10, fontWeight: 700, fontSize: 13,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)', border: '1px solid rgba(255,255,255,0.15)',
          display: 'flex', alignItems: 'center', gap: 10, animation: 'slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards'
        }}>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer', opacity: 0.7, marginLeft: 8 }}>✕</button>
        </div>
      )}

      <SettingsPanel
        open={showSettings} onClose={() => setShowSettings(false)}
        concurrency={concurrency} setConcurrency={handleUpdateConcurrency}
        fragmentConcurrency={fragmentConcurrency} setFragmentConcurrency={setFragmentConcurrency}
        speedLimit={speedLimit} setSpeedLimit={setSpeedLimit}
        cookiesSource={cookiesSource} setCookiesSource={setCookiesSource}
        cookiesBrowser={cookiesBrowser} setCookiesBrowser={setCookiesBrowser}
        cookiesFilePath={cookiesFilePath} setCookiesFilePath={setCookiesFilePath}
        onSelectCookiesFile={handleSelectCookiesFile}
      />

      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Header */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 16, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 9, overflow: 'hidden', flexShrink: 0, border: `1px solid ${T.border}` }}>
              <img src="/bolt_logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.02em' }}>Bolt</span>
                <Badge>v1.0.0</Badge>
                {activeCount > 0 && <Badge accent>{activeCount}/{concurrency} active</Badge>}
              </div>
              <p style={{ fontSize: 11, color: T.muted, marginTop: 1 }}>
                High-performance parallel video downloader •{' '}
                <span 
                  onClick={() => handleOpenLink('https://boltyt.mohsinkhandevs.com')} 
                  style={{ color: T.accent, cursor: 'pointer', textDecoration: 'none', fontWeight: 600, transition: 'opacity 0.15s' }}
                  onMouseEnter={e => e.target.style.opacity = '0.8'}
                  onMouseLeave={e => e.target.style.opacity = '1'}
                >
                  boltyt.mohsinkhandevs.com
                </span>
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {cookiesSource !== 'none' && (
              <span style={{ fontSize: 10, fontWeight: 700, fontFamily: T.mono, color: T.accent, background: 'rgba(249,115,22,0.08)', padding: '5px 10px', borderRadius: 6, border: `1px solid rgba(249,115,22,0.2)` }}>
                🛡️ Cookie Bypass Active ({cookiesSource.toUpperCase()})
              </span>
            )}
            <button onClick={() => setShowSettings(true)} title="Settings"
              style={{ width: 34, height: 34, background: showSettings ? 'rgba(249,115,22,0.1)' : T.surf, border: `1px solid ${showSettings ? 'rgba(249,115,22,0.3)' : T.border}`, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', color: showSettings ? T.accent : T.muted, transition: 'all 0.2s' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93a10 10 0 000 14.14"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>
              </svg>
            </button>
            <button onClick={handleReset} title="Refresh / Cancel All"
              style={{ width: 34, height: 34, background: T.surf, border: `1px solid ${T.border}`, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, transition: 'color 0.15s' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>
              </svg>
            </button>
          </div>
        </header>

        {/* URL Input & Strict Selected Mode Toggle */}
        <div style={{ background: T.surf, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: T.hint, pointerEvents: 'none' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
                </svg>
              </span>
              <input type="text"
                placeholder="Paste YouTube video or playlist URL here..."
                value={url} onChange={e => setUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !loading && url.trim()) handleAnalyze(); }}
                disabled={loading}
                onFocus={e => e.target.style.borderColor = T.accent}
                onBlur={e => e.target.style.borderColor = T.border}
                style={{ width: '100%', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 9,
                  paddingLeft: 38, paddingRight: 14, paddingTop: 10, paddingBottom: 10,
                  color: T.text, fontFamily: T.mono, fontSize: 12, transition: 'border-color 0.2s' }}
              />
            </div>
            <button onClick={handleAnalyze} disabled={loading || !url.trim()}
              style={{ padding: '0 22px', borderRadius: 9, border: 'none', fontWeight: 700, fontSize: 13,
                display: 'flex', alignItems: 'center', gap: 8, transition: 'all 0.2s', whiteSpace: 'nowrap',
                background: loading || !url.trim() ? T.surf2 : T.accent,
                color: loading || !url.trim() ? T.hint : '#fff' }}>
              {loading && <div style={{ width: 13, height: 13, border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }}/>}
              Analyze
            </button>
          </div>

          {/* Smart URL Disambiguation Banner */}
          {(() => {
            if (!url.trim() || loading) return null;
            const p = parseYoutubeUrl(url);
            if (!p.isValid) return null;

            const isDual        = p.hasVideo && p.hasPlaylist;
            const isVideoOnly   = p.hasVideo && !p.hasPlaylist;
            const isPlaylistOnly = !p.hasVideo && p.hasPlaylist;

            // Dual URL: show which mode will be used and offer to switch
            if (isDual) {
              const willDownload = analysisMode === 'video'
                ? 'single video only (playlist param will be stripped)'
                : 'full playlist';
              const switchTo = analysisMode === 'video' ? 'playlist' : 'video';
              const switchLabel = analysisMode === 'video' ? '📂 Switch to Playlist Mode' : '📹 Switch to Video Mode';
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(249,115,22,0.07)', border: '1px solid rgba(249,115,22,0.22)', borderRadius: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: T.accent, fontWeight: 700, flexShrink: 0 }}>⚡ Dual URL</span>
                  <span style={{ fontSize: 11, color: T.muted, flex: 1, minWidth: 160 }}>
                    Contains both a video and a playlist. Will download <span style={{ color: T.text, fontWeight: 600 }}>{willDownload}</span>.
                  </span>
                  <button onClick={() => setAnalysisMode(switchTo)} disabled={loading}
                    style={{ background: 'rgba(249,115,22,0.12)', border: '1px solid rgba(249,115,22,0.3)', color: T.accent, borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {switchLabel}
                  </button>
                </div>
              );
            }

            // Video-only URL but playlist mode is selected
            if (isVideoOnly && analysisMode === 'playlist') {
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#38bdf8', fontWeight: 700, flexShrink: 0 }}>ℹ️ Single Video URL</span>
                  <span style={{ fontSize: 11, color: T.muted, flex: 1, minWidth: 160 }}>This URL has no playlist. It cannot be analyzed in Playlist mode.</span>
                  <button onClick={() => setAnalysisMode('video')} disabled={loading}
                    style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)', color: '#38bdf8', borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    📹 Switch to Video Mode
                  </button>
                </div>
              );
            }

            // Playlist-only URL but video mode is selected
            if (isPlaylistOnly && analysisMode === 'video') {
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 8, padding: '8px 12px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: '#38bdf8', fontWeight: 700, flexShrink: 0 }}>ℹ️ Playlist URL</span>
                  <span style={{ fontSize: 11, color: T.muted, flex: 1, minWidth: 160 }}>This URL has no video ID. It cannot be analyzed in Single Video mode.</span>
                  <button onClick={() => setAnalysisMode('playlist')} disabled={loading}
                    style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.25)', color: '#38bdf8', borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    📂 Switch to Playlist Mode
                  </button>
                </div>
              );
            }

            return null;
          })()}

          {/* DevOps Strict 2-Button Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 3, display: 'flex', gap: 2 }}>
                {[
                  { id: 'video', label: '📹 Single Video Mode' },
                  { id: 'playlist', label: '📂 Playlist Mode' }
                ].map((mode) => (
                  <button key={mode.id} className="small-tog"
                    onClick={() => setAnalysisMode(mode.id)}
                    disabled={loading}
                    style={{
                      background: analysisMode === mode.id ? 'rgba(249,115,22,0.12)' : 'transparent',
                      color: analysisMode === mode.id ? T.accent : T.muted,
                      borderColor: analysisMode === mode.id ? 'rgba(249,115,22,0.3)' : 'transparent',
                      padding: '6px 16px'
                    }}>
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: 3, display: 'flex', gap: 2 }}>
              {['Video (MP4)', 'Audio (MP3)'].map((label, i) => (
                <button key={label} className="small-tog"
                  onClick={() => { setIsAudioOnly(i === 1); setSelectedFormat(''); }}
                  disabled={loading}
                  style={{ background: isAudioOnly === (i === 1) ? 'rgba(249,115,22,0.12)' : 'transparent',
                    color: isAudioOnly === (i === 1) ? T.accent : T.muted,
                    borderColor: isAudioOnly === (i === 1) ? 'rgba(249,115,22,0.3)' : 'transparent' }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: `1px solid ${T.border}`, paddingTop: 12 }}>
            <div style={{ flex: 1, minWidth: 180, display: 'flex', alignItems: 'center', gap: 6, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 10px' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.hint} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
              </svg>
              <input type="text" value={downloadDir} onChange={e => setDownloadDir(e.target.value)}
                placeholder="Output folder…"
                style={{ flex: 1, background: 'transparent', border: 'none', color: T.muted, fontFamily: T.mono, fontSize: 10, minWidth: 0 }}/>
            </div>
            <button className="link-btn" onClick={handleSelectFolder} style={{ color: T.accent }}>Change</button>
            <button className="link-btn" onClick={handleOpenFolder} style={{ color: T.hint }}>Open ↗</button>
          </div>
        </div>

        {/* Responsive Combined Layout Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 0.85fr)', gap: 16 }}>

          {/* Left Column: Input, Format Picker */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {videoInfo ? (
              <>
                {/* Media Metadata Card */}
                <div style={{ background: T.surf, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16 }}>
                  <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                    <div style={{ width: 124, height: 74, borderRadius: 8, overflow: 'hidden', background: T.bg, border: `1px solid ${T.border}`, flexShrink: 0, position: 'relative' }}>
                      {videoInfo.thumbnail
                        ? <img src={videoInfo.thumbnail} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}/>
                        : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={T.border2} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
                            </svg>
                          </div>}
                      <span style={{ position: 'absolute', bottom: 4, right: 4, background: 'rgba(0,0,0,0.82)', borderRadius: 4, padding: '1px 5px', fontFamily: T.mono, fontSize: 9, color: T.text, fontWeight: 600 }}>
                        {videoInfo.duration}
                      </span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ marginBottom: 6 }}>
                        {videoInfo.isPlaylist ? <Badge accent>Playlist Resolved</Badge> : <Badge color="#38bdf8">Single Video Resolved</Badge>}
                      </div>
                      <h3 style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.45, color: T.text, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {videoInfo.title}
                      </h3>
                      <p style={{ marginTop: 5, fontSize: 11, color: T.muted }}>
                        {videoInfo.author}
                        <span style={{ color: T.border2, margin: '0 5px' }}>·</span>
                        <span style={{ color: T.hint }}>{videoInfo.views}</span>
                      </p>
                    </div>
                  </div>
                </div>

                {/* Profiles & Quality Toggles */}
                <div style={{ background: T.surf, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.hint }}>
                    {isAudioOnly ? 'Audio Quality' : 'Quality Profile'}
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {videoInfo.formats.map(f => (
                      <button key={f.id}
                        className={`fmt-card${selectedFormat === f.id ? ' sel' : ''}`}
                        onClick={() => setSelectedFormat(f.id)}
                        style={{ padding: '10px 12px', borderRadius: 9, textAlign: 'left', border: `1px solid ${T.border}`, background: T.bg, transition: 'all 0.15s', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: selectedFormat === f.id ? T.accent : '#d6d3d1' }}>{f.label}</span>
                          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.hint, background: T.surf2, border: `1px solid ${T.border}`, borderRadius: 4, padding: '1px 5px' }}>{f.size}</span>
                        </div>
                        <span style={{ fontSize: 10, color: T.hint }}>{f.sub}</span>
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button onClick={handleAddTask} disabled={!selectedFormat}
                      style={{ flex: 1, padding: 13, borderRadius: 10, border: 'none', fontWeight: 800, fontSize: 13, letterSpacing: '-0.01em',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 0.2s',
                        background: !selectedFormat ? T.surf2 : `linear-gradient(135deg, ${T.accent}, ${T.accentD})`,
                        color: !selectedFormat ? T.hint : '#fff' }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                      </svg>
                      Add to Download Queue
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ background: T.surf, border: `1px solid ${T.border}`, borderRadius: 14, padding: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, minHeight: 260 }}>
                <div style={{ width: 48, height: 48, borderRadius: 12, background: T.bg, border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.border2} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: T.hint }}>Paste a URL and click Analyze</p>
                  <p style={{ fontSize: 11, color: T.border2, marginTop: 4 }}>Dual URLs (video + playlist) are handled automatically based on the selected mode</p>
                </div>
              </div>
            )}
            {/* Task Queue Panel */}
            <div style={{ background: T.surf, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16 }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.hint, marginBottom: 12 }}>
                Task Queue Manager ({tasks.length})
              </p>

              {tasks.length === 0 ? (
                <div style={{ border: `1px dashed ${T.border}`, borderRadius: 10, padding: '24px', textAlign: 'center', color: T.hint, fontSize: 12 }}>
                  Queue is currently empty. Analyzed files will appear here.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '350px', overflowY: 'auto' }}>
                  {tasks.map(t => {
                    const progressPercent = t.totalItems > 0 ? (t.completedItems / t.totalItems) * 100 : 0;
                    return (
                      <div key={t.id} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                          <div style={{ minWidth: 0 }}>
                            <h4 style={{ fontSize: 12, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.title}>
                              {t.title}
                            </h4>
                            <p style={{ fontSize: 10, color: T.muted, marginTop: 2, fontFamily: T.mono }}>
                              Folder: {t.playlistFolder || 'Downloads'}
                            </p>
                          </div>
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            {t.status === 'downloading' && (
                              <button onClick={() => handlePauseTask(t.id)} title="Pause Task"
                                style={{ background: 'rgba(249,115,22,0.1)', border: 'none', color: T.accent, borderRadius: 5, padding: '3px 8px', fontSize: 10, fontWeight: 600 }}>
                                Pause
                              </button>
                            )}
                            {t.status === 'paused' && (
                              <button onClick={() => handleResumeTask(t.id)} title="Resume Task"
                                style={{ background: 'rgba(56,189,248,0.1)', border: 'none', color: '#38bdf8', borderRadius: 5, padding: '3px 8px', fontSize: 10, fontWeight: 600 }}>
                                Resume
                              </button>
                            )}
                            <button onClick={() => handleRemoveTask(t.id)} title={t.status === 'completed' ? "Remove Task" : "Terminate & Delete Task"}
                              style={{ 
                                background: t.status === 'completed' ? 'rgba(120,113,108,0.1)' : 'rgba(239,68,68,0.08)', 
                                border: 'none', 
                                color: t.status === 'completed' ? '#a8a29e' : '#f87171', 
                                borderRadius: 5, 
                                padding: '3px 8px', 
                                fontSize: 10, 
                                fontWeight: 600 
                              }}>
                              {t.status === 'completed' ? 'Remove' : 'Delete'}
                            </button>
                          </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                          <span style={{ fontSize: 10, fontFamily: T.mono, color: T.muted }}>
                            Downloaded: <span style={{ color: T.accent, fontWeight: 700 }}>{t.completedItems}</span> / {t.totalItems}
                          </span>
                          <span style={{ fontSize: 10, fontFamily: T.mono, fontWeight: 700, color: progressPercent === 100 ? '#4ade80' : T.accent }}>
                            {t.status.toUpperCase()}
                          </span>
                        </div>

                        <div style={{ height: 4, background: '#1c1917', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${progressPercent}%`,
                            background: progressPercent === 100 ? '#4ade80' : `linear-gradient(90deg, ${T.accent}, ${T.accentD})`,
                            borderRadius: 2, transition: 'width 0.4s' }}/>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Progress Monitor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Concurrent Workers Progress Monitor */}
            <div style={{ background: T.surf, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.hint }}>Progress Monitor</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 3 }}>
                    {Array.from({ length: Math.min(concurrency, 8) }, (_, i) => (
                      <div key={i} style={{ width: 5, height: 14, borderRadius: 2,
                        background: activeCount > 0 && i < activeCount ? T.accent : T.border,
                        transition: 'background 0.3s',
                        animation: activeCount > 0 && i < activeCount ? 'pulse-dot 1.2s ease-in-out infinite' : 'none',
                        animationDelay: `${i * 0.15}s` }}/>
                    ))}
                  </div>
                  <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 600, color: activeCount > 0 ? T.accent : T.hint }}>
                    {activeCount > 0 ? `${activeCount}/${concurrency} Thr` : 'IDLE'}
                  </span>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                {slots.map((slot, i) => <SlotCard key={i} slot={slot} index={i}/>)}
              </div>

              {activeCount > 0 && cumulativeSpeed !== '—' && (
                <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.hint }}>Combined Speed</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700 }}>{cumulativeSpeed}</span>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}