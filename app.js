// ═══════════════════════════════════════════════════════════
//   ELNUSA AI — Alarm Receiver App
//   Connects to VPS via SSE to receive violation alerts
// ═══════════════════════════════════════════════════════════

let eventSource = null;
let isConnected = false;
let alarmAudio = null;

// ── ALARM SOUND (generate programmatically — no external file needed) ────────
function createAlarmSound() {
  let ctx = null;
  let activeOscillators = [];

  function playAlarm() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Sirene 2 nada bergantian
    const duration = 2; 
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc1.type = 'square';
    osc2.type = 'square';
    gain.gain.value = 0.3;
    
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    
    // Sirene naik-turun
    const now = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      osc1.frequency.setValueAtTime(800, now + i * 0.5);
      osc1.frequency.setValueAtTime(1200, now + i * 0.5 + 0.25);
    }
    
    osc1.start(now);
    osc1.stop(now + duration);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    activeOscillators.push(osc1, osc2);
  }

  function stopAlarm() {
    if (ctx) {
      activeOscillators.forEach(osc => {
        try { osc.stop(); } catch(e) {}
      });
      activeOscillators = [];
    }
    const flash = document.getElementById('alert-flash');
    if (flash) flash.classList.remove('active');
  }
  
  return { play: playAlarm, stop: stopAlarm };
}

// ── AUDIO INTERCOM RECEIVER (WebRTC Callee) ─────────────────────────────────
let rtcRecv = null;

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

async function handleRTCOffer(offer) {
  const vpsUrl = document.getElementById('vps-url').value.trim();
  const isVercel = location.protocol === 'https:' && location.hostname.includes('vercel.app');
  const base = isVercel ? '' : vpsUrl;

  // Tutup koneksi lama jika ada
  if (rtcRecv) { rtcRecv.close(); rtcRecv = null; }

  rtcRecv = new RTCPeerConnection(RTC_CONFIG);

  // Putar audio masuk dari dashboard ke <audio>
  rtcRecv.ontrack = (e) => {
    const audio = document.getElementById('intercom-audio');
    if (audio) {
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
    }
    addLog('system', '🎙️ Interkom aktif — suara dari dashboard masuk');
  };

  rtcRecv.onconnectionstatechange = () => {
    const s = rtcRecv?.connectionState;
    if (s === 'connected')   addLog('system', '✅ Interkom terhubung');
    if (s === 'disconnected') addLog('system', '⚠️ Interkom terputus');
  };

  // Kirim ICE candidate ke VPS
  rtcRecv.onicecandidate = async (e) => {
    if (!e.candidate) return;
    try {
      await fetch(`${base}/api/rtc/ice/recv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(e.candidate.toJSON())
      });
    } catch(_) {}
  };

  // Set remote description (offer dari dashboard)
  await rtcRecv.setRemoteDescription(new RTCSessionDescription(offer));

  // Buat answer
  const answer = await rtcRecv.createAnswer();
  await rtcRecv.setLocalDescription(answer);

  // Kirim answer ke VPS
  await fetch(`${base}/api/rtc/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: answer.type, sdp: answer.sdp })
  });
}


// ── SSE CONNECTION ───────────────────────────────────────────────────────────
function toggleConnection() {
  if (isConnected) {
    disconnect();
  } else {
    connect();
  }
}

function connect() {
  const vpsUrl = document.getElementById('vps-url').value.trim();
  if (!vpsUrl) return;

  // Initialize audio on user interaction (required by browsers)
  if (!alarmAudio) {
    alarmAudio = createAlarmSound();
  }

  updateStatus('connecting');

  // Deteksi apakah dijalankan dari Vercel (HTTPS) atau lokal
  // Jika Vercel: gunakan path relatif /api/ (di-proxy oleh vercel.json)
  // Jika lokal: gunakan URL VPS langsung
  const isVercel = location.protocol === 'https:' && location.hostname.includes('vercel.app');
  const sseUrl = isVercel
    ? '/api/alerts/stream'
    : `${vpsUrl}/api/alerts/stream`;

  try {
    eventSource = new EventSource(sseUrl);
    
    eventSource.onopen = () => {
      isConnected = true;
      updateStatus('connected');
      addLog('system', 'Terhubung ke server VPS');
    };
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connected') {
          console.log('[SSE] Connected to VPS');
          return;
        }
        
        if (data.type === 'alarm') {
          triggerAlarm(data);
        }

        if (data.type === 'clear_alarm') {
          if (alarmAudio) alarmAudio.stop();
          addLog('system', 'Buzzer dimatikan oleh admin dashboard');
        }

        // WebRTC: terima offer dari dashboard
        if (data.type === 'rtc_offer' && data.offer) {
          handleRTCOffer(data.offer).catch(e => {
            console.error('[RTC Receiver]', e);
            addLog('system', '❌ Gagal terima interkom: ' + e.message);
          });
        }

        // WebRTC: terima ICE candidate dari dashboard
        if (data.type === 'rtc_ice_dash' && data.candidate && rtcRecv) {
          rtcRecv.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
        }
      } catch (e) {
        console.error('[SSE] Parse error:', e);
      }
    };
    
    eventSource.onerror = () => {
      if (isConnected) {
        updateStatus('reconnecting');
        addLog('system', 'Koneksi terputus, mencoba reconnect...');
      }
    };
    
  } catch (e) {
    updateStatus('disconnected');
    addLog('error', `Gagal connect: ${e.message}`);
  }
}

function disconnect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  isConnected = false;
  updateStatus('disconnected');
  addLog('system', 'Disconnected dari server');
}

// ── ALARM TRIGGER ────────────────────────────────────────────────────────────
function triggerAlarm(data) {
  // Play alarm sound
  if (alarmAudio) {
    alarmAudio.play();
  }
  
  // Visual flash
  const flash = document.getElementById('alert-flash');
  const alertText = document.getElementById('alert-text');
  const alertDetail = document.getElementById('alert-detail');
  
  alertText.textContent = `⚠️ ${data.object} TERDETEKSI`;
  alertDetail.textContent = `${data.location} — ${data.time}`;
  
  flash.classList.add('active');
  
  // Auto-hide after 5 seconds
  setTimeout(() => {
    flash.classList.remove('active');
  }, 5000);
  
  // Add to log
  addLog('alarm', `${data.object} — ${data.location} — ${data.time}`);
}

// ── UI HELPERS ───────────────────────────────────────────────────────────────
function updateStatus(status) {
  const el = document.getElementById('conn-status');
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('span:last-child');
  
  dot.className = 'status-dot';
  
  switch (status) {
    case 'connected':
      dot.classList.add('connected');
      text.textContent = 'CONNECTED';
      document.getElementById('connect-btn').textContent = 'DISCONNECT';
      break;
    case 'connecting':
      dot.classList.add('connecting');
      text.textContent = 'CONNECTING...';
      break;
    case 'reconnecting':
      dot.classList.add('connecting');
      text.textContent = 'RECONNECTING...';
      break;
    default:
      dot.classList.add('disconnected');
      text.textContent = 'DISCONNECTED';
      document.getElementById('connect-btn').textContent = 'CONNECT';
  }
}

function addLog(type, message) {
  const container = document.getElementById('log-container');
  
  // Remove "empty" placeholder
  const empty = container.querySelector('.log-empty');
  if (empty) empty.remove();
  
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  
  const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
  entry.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-msg">${message}</span>
  `;
  
  container.insertBefore(entry, container.firstChild);
  
  // Keep max 100 entries
  while (container.children.length > 100) {
    container.removeChild(container.lastChild);
  }
}
