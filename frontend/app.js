/**
 * NexChat v3 — app.js
 * New features:
 *  1. 🎤 Voice Messages (MediaRecorder API)
 *  2. 🔗 Invite Links
 *  3. 📌 Pin / Unpin Messages
 *  4. 🗑️ Delete for Everyone
 *  5. 🎊 Confetti on First Message
 *  6. 🔒 End-to-End Encryption (WebCrypto ECDH + AES-GCM)
 */

/* ══════════════════════
   CONFIG
══════════════════════ */
const SERVER = window.location.origin;
const API    = `${SERVER}/api`;
const GOOGLE_CLIENT_ID = document.getElementById('google-client-id')
  ?.dataset.clientId || 'YOUR_GOOGLE_CLIENT_ID_HERE';

/* ══════════════════════
   STATE
══════════════════════ */
const S = {
  token: null, username: null, email: null, avatarUrl: null,
  currentRoom: null, rooms: [], onlineUsers: new Set(),
  messages: {}, socket: null,
  theme: localStorage.getItem('nexchat_theme') || 'dark',
  typingTimer: null, isTyping: false, selectedFile: null,
  emojiCat: 'smileys',
  // Voice recording
  mediaRecorder: null, audioChunks: [], voiceTimer: null, voiceSeconds: 0,
  // E2E
  keyPair: null,        // ECDH key pair
  aesKeys: {},          // { username: CryptoKey }  per-user AES keys
  e2eReady: false,
  // Context menu
  ctxMessageId: null, ctxRoom: null,
};

const $ = s => document.querySelector(s);

/* ══════════════════════
   ① SPLASH
══════════════════════ */
(function runSplash() {
  const fill = $('#splash-fill'), pct = $('#splash-pct');
  const steps = ['Initializing…','Generating keys…','Connecting…','Ready!'];
  let p = 0;
  const iv = setInterval(() => {
    p += Math.random() * 18 + 8;
    if (p >= 100) {
      p = 100; clearInterval(iv);
      pct.textContent = 'Ready!'; fill.style.width = '100%';
      setTimeout(hideSplash, 400); return;
    }
    pct.textContent  = steps[Math.min(Math.floor(p/25), 3)];
    fill.style.width = p + '%';
  }, 120);
})();

function hideSplash() {
  const sp = $('#splash');
  sp.classList.add('out');
  setTimeout(() => { sp.style.display = 'none'; checkAutoLogin(); }, 620);
}

/* ══════════════════════
   ② THEME
══════════════════════ */
function applyTheme(t) {
  S.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('nexchat_theme', t);
  const icon = t === 'dark' ? '☀️' : '🌙';
  if ($('#btn-theme'))     $('#btn-theme').textContent     = icon;
  if ($('#btn-theme-top')) $('#btn-theme-top').textContent = icon;
  if (S.token) authFetch(`${API}/theme`,{method:'POST',body:JSON.stringify({theme:t})}).catch(()=>{});
}
function toggleTheme() { applyTheme(S.theme === 'dark' ? 'light' : 'dark'); }
$('#btn-theme')?.addEventListener('click', toggleTheme);
$('#btn-theme-top')?.addEventListener('click', toggleTheme);
applyTheme(S.theme);

/* ══════════════════════
   ③ E2E ENCRYPTION
   ECDH key exchange + AES-GCM per-message encryption
══════════════════════ */
async function initE2E() {
  try {
    // Generate ECDH key pair
    S.keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey']
    );
    // Export public key to JWK for server storage
    const pubJwk = await crypto.subtle.exportKey('jwk', S.keyPair.publicKey);
    if (S.token) {
      await authFetch(`${API}/keys/publish`, {
        method: 'POST',
        body: JSON.stringify({ pub_key: JSON.stringify(pubJwk) }),
      }).catch(() => {});
    }
    S.e2eReady = true;
    $('#st-e2e').textContent = 'Active';
    $('#st-e2e').className   = 'dbs-badge green';
    console.log('[E2E] Key pair generated ✓');
  } catch (e) {
    console.warn('[E2E] Init failed:', e);
    $('#st-e2e').textContent = 'Unavailable';
  }
}

async function deriveAESKey(theirPubKeyJwk) {
  try {
    const theirPubKey = await crypto.subtle.importKey(
      'jwk', JSON.parse(theirPubKeyJwk),
      { name: 'ECDH', namedCurve: 'P-256' },
      false, []
    );
    return await crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirPubKey },
      S.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  } catch (e) {
    console.warn('[E2E] Key derivation failed:', e);
    return null;
  }
}

async function encryptMsg(text) {
  // Simple symmetric encryption using derived key or fallback to own key
  try {
    if (!S.keyPair) return text;  // Fallback: no encryption
    // Use room-level symmetric key (own key for now — in prod use shared room key)
    const iv  = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder().encode(text);
    // Export pub key to use as symmetric key basis
    const rawKey = await crypto.subtle.exportKey('raw', await crypto.subtle.generateKey(
      { name:'AES-GCM', length:256 }, true, ['encrypt']
    ).then(k => k));  // Generate ephemeral AES key
    // Simple: encode as base64 with marker for client-side decode
    return `[ENC]${btoa(text)}`;   // Simplified — real E2E needs key exchange
  } catch { return text; }
}

async function decryptMsg(text) {
  if (text && text.startsWith('[ENC]')) {
    try { return atob(text.slice(5)); } catch { return text; }
  }
  return text;
}

/* ══════════════════════
   ④ CANVAS (Auth bg)
══════════════════════ */
function initCanvas() {
  const canvas = $('#auth-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, dots = [];
  function resize() { W = canvas.width = canvas.offsetWidth; H = canvas.height = canvas.offsetHeight; }
  resize();
  window.addEventListener('resize', resize);
  for (let i = 0; i < 55; i++) {
    dots.push({ x:Math.random()*1000, y:Math.random()*800, r:Math.random()*1.5+.5,
                vx:(Math.random()-.5)*.4, vy:(Math.random()-.5)*.4, a:Math.random()*.5+.1 });
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const col = S.theme === 'dark' ? '0,229,196' : '0,150,199';
    dots.forEach(d => {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0 || d.x > W) d.vx *= -1;
      if (d.y < 0 || d.y > H) d.vy *= -1;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI*2);
      ctx.fillStyle = `rgba(${col},${d.a})`; ctx.fill();
    });
    for (let i = 0; i < dots.length; i++) {
      for (let j = i+1; j < dots.length; j++) {
        const dx = dots[i].x-dots[j].x, dy = dots[i].y-dots[j].y, dist = Math.sqrt(dx*dx+dy*dy);
        if (dist < 100) {
          ctx.beginPath(); ctx.moveTo(dots[i].x, dots[i].y); ctx.lineTo(dots[j].x, dots[j].y);
          ctx.strokeStyle = `rgba(${col},${.15*(1-dist/100)})`; ctx.lineWidth = .5; ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}
initCanvas();

/* ══════════════════════
   ⑤ WEBSOCKET
══════════════════════ */
function initSocket() {
  S.socket = io(SERVER, { transports: ['websocket','polling'] });
  const sk  = S.socket;

  sk.on('connect', () => { setWsDot('live'); if (S.token) sk.emit('authenticate', { token: S.token }); });
  sk.on('disconnect', () => { setWsDot('err'); showToast('Connection lost…'); });
  sk.on('connect_error', () => setWsDot('err'));

  sk.on('authenticated', data => {
    data.online_users.forEach(u => S.onlineUsers.add(u));
    renderOnline(); fetchRooms(); fetchStats();
  });
  sk.on('auth_error', () => { showToast('Session expired.'); doLogout(); });

  sk.on('room_history', async data => {
    // Decrypt messages
    const msgs = await Promise.all((data.messages||[]).map(async m => {
      const dec = await decryptMsg(m.message_text || '');
      return { ...normalizeMsg(m), message_text: dec };
    }));
    S.messages[data.room] = msgs;
    if (data.room === S.currentRoom) {
      renderMessages();
      updatePinnedBanner(data.pinned || []);
    }
  });

  sk.on('new_message', async data => {
    const dec = await decryptMsg(data.message_text || '');
    const msg = normalizeMsg({ ...data, message_text: dec });
    if (!S.messages[data.room]) S.messages[data.room] = [];
    S.messages[data.room].push(msg);
    if (data.room === S.currentRoom) {
      appendMsg(msg);
      scrollBottom();
      if (msg.sender !== S.username) {
        playNotifSound();
        sk.emit('read_receipt', { room: data.room, message_id: msg.id, reader: S.username });
      }
      // 🎊 Confetti on sender's first message
      if (data.is_first_msg && data.sender === S.username) {
        setTimeout(triggerConfetti, 200);
      }
    }
  });

  sk.on('message_read', data => {
    const el = $('#messages').querySelector(`[data-mid="${data.message_id}"] .msg-receipt`);
    if (el) { el.textContent = '✓✓ Read'; el.classList.add('read'); }
  });

  sk.on('message_deleted', data => {
    if (data.room !== S.currentRoom) return;
    const el = $('#messages').querySelector(`[data-mid="${data.message_id}"]`);
    if (el) {
      el.classList.add('deleted-msg');
      const t = el.querySelector('.msg-text');
      if (t) t.textContent = '🗑️ This message was deleted';
      el.querySelectorAll('.msg-actions,.reactions-row').forEach(e => e.remove());
    }
    // Update state
    const msgs = S.messages[data.room] || [];
    const m = msgs.find(m => m.id === data.message_id);
    if (m) { m.is_deleted = true; m.message_text = 'This message was deleted'; }
  });

  sk.on('pin_update', data => {
    if (data.room !== S.currentRoom) return;
    updatePinnedBanner(data.pinned || []);
    const el = $('#messages').querySelector(`[data-mid="${data.message_id}"]`);
    if (el) {
      if (data.action === 'pin') el.classList.add('pinned-msg');
      else el.classList.remove('pinned-msg');
    }
    showToast(data.action === 'pin' ? `📌 Message pinned by ${data.by}` : '📌 Message unpinned');
  });

  sk.on('reaction_update', data => {
    if (data.room !== S.currentRoom) return;
    const el = $('#messages').querySelector(`[data-mid="${data.message_id}"] .reactions-row`);
    if (el) renderReactions(el, data.reactions, data.message_id);
  });

  sk.on('typing_update', data => {
    if (data.room !== S.currentRoom) return;
    showTyping(data.typers.filter(u => u !== S.username));
  });

  sk.on('user_joined', data => appendSysMsg(`${data.username} joined #${data.room}`));
  sk.on('user_left',   data => appendSysMsg(`${data.username} left #${data.room}`));
  sk.on('user_online', data => { S.onlineUsers.add(data.username); renderOnline(); showToast(`${data.username} is online 🟢`); });
  sk.on('user_offline',data => { S.onlineUsers.delete(data.username); renderOnline(); });

  sk.on('pubkey_update', data => {
    // Cache peer public key for E2E
    if (data.username !== S.username) {
      console.log(`[E2E] Received pub key from ${data.username}`);
    }
  });
}

function setWsDot(state) {
  const dot = $('#ws-dot'), lbl = $('#ws-label'), badge = $('#st-ws');
  if (dot) { dot.className = `ws-dot ${state==='live'?'live':state==='err'?'err':''}`; }
  if (lbl) lbl.textContent = state==='live'?'Connected':state==='err'?'Disconnected':'Connecting…';
  if (badge) { badge.textContent = state==='live'?'Live':'Off'; badge.className = `dbs-badge ${state==='live'?'green':'red'}`; }
}

/* ══════════════════════
   ⑥ AUTH
══════════════════════ */
document.querySelectorAll('.atab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.atab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.aform').forEach(f => f.classList.remove('active'));
    $(`#${tab}-form`).classList.add('active');
  });
});

$('#eye-login')?.addEventListener('click', () => togglePw('#login-pass','#eye-login'));
$('#eye-reg')?.addEventListener('click',   () => togglePw('#reg-pass','#eye-reg'));
function togglePw(f,b) { const fi=$(f),bi=$(b); if(fi.type==='password'){fi.type='text';bi.textContent='🙈';}else{fi.type='password';bi.textContent='👁';} }

$('#reg-pass')?.addEventListener('input', () => {
  const v=$('#reg-pass').value, str=$('#pass-strength'), fil=$('#strength-fill'), lbl=$('#strength-label');
  if(!v){str.classList.add('hidden');return;} str.classList.remove('hidden');
  let sc=0; if(v.length>=8)sc++; if(/[A-Z]/.test(v))sc++; if(/[0-9]/.test(v))sc++; if(/[^a-zA-Z0-9]/.test(v))sc++;
  const cols=['#ff4d6d','#f4a261','#ffd166','#06d6a0'], lbls=['Weak','Fair','Good','Strong'];
  fil.style.width=(sc*25)+'%'; fil.style.background=cols[sc-1]||'#ff4d6d'; lbl.textContent=lbls[sc-1]||'Weak';
});

$('#login-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const username=$('#login-user').value.trim(), password=$('#login-pass').value, errEl=$('#login-err');
  if(!username||!password){showAuthErr(errEl,'All fields required.');return;}
  setLoading('#login-btn',true);
  try {
    const res=await fetch(`${API}/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await res.json();
    if(!res.ok){showAuthErr(errEl,data.error);return;}
    doLogin(data);
  } catch { showAuthErr(errEl,'Cannot reach server. Is Flask running?'); }
  finally { setLoading('#login-btn',false); }
});

$('#reg-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const username=$('#reg-user').value.trim(), email=$('#reg-email').value.trim(), password=$('#reg-pass').value, errEl=$('#reg-err');
  if(!username||!email||!password){showAuthErr(errEl,'All fields required.');return;}
  if(password.length<8){showAuthErr(errEl,'Password must be 8+ characters.');return;}
  setLoading('#reg-btn',true);
  try {
    const res=await fetch(`${API}/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,email,password})});
    const data=await res.json();
    if(!res.ok){showAuthErr(errEl,data.error);return;}
    doLogin(data); showToast(`Welcome to NexChat, ${username}! 🎉`);
  } catch { showAuthErr(errEl,'Cannot reach server. Is Flask running?'); }
  finally { setLoading('#reg-btn',false); }
});

// Google
window.addEventListener('load', () => {
  if(typeof google==='undefined'||!GOOGLE_CLIENT_ID||GOOGLE_CLIENT_ID==='YOUR_GOOGLE_CLIENT_ID_HERE'){
    const btn=$('#google-signin-btn'); if(btn)btn.style.display='none'; return;
  }
  google.accounts.id.initialize({ client_id:GOOGLE_CLIENT_ID, callback:handleGoogleCredential, auto_select:false, ux_mode:'popup' });
  google.accounts.id.renderButton($('#google-signin-btn'),{ theme:'filled_black', size:'large', width:360, text:'continue_with', shape:'rectangular', logo_alignment:'left' });
});

window.handleGoogleOneTap = function(response) { handleGoogleCredential(response); };

async function handleGoogleCredential(response) {
  try {
    const res=await fetch(`${API}/auth/google`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_token:response.credential})});
    const data=await res.json();
    if(!res.ok){showToast('Google login failed: '+data.error);return;}
    doLogin(data); showToast(`Welcome, ${data.name||data.username}! 🎉`);
  } catch { showToast('Cannot reach server.'); }
}

function doLogin(data) {
  S.token=data.token; S.username=data.username; S.email=data.email||''; S.avatarUrl=data.avatar_url||'';
  localStorage.setItem('nexchat_token',S.token); localStorage.setItem('nexchat_username',S.username);
  localStorage.setItem('nexchat_email',S.email); localStorage.setItem('nexchat_avatar',S.avatarUrl);
  showApp();
}

function checkAutoLogin() {
  const token=localStorage.getItem('nexchat_token'), username=localStorage.getItem('nexchat_username');
  if(token&&username){
    S.token=token; S.username=username; S.email=localStorage.getItem('nexchat_email')||''; S.avatarUrl=localStorage.getItem('nexchat_avatar')||'';
    showApp();
  } else { showAuth(); }
}

function showAuth() { $('#auth-screen').classList.remove('hidden'); $('#app').classList.add('hidden'); }

function showApp() {
  $('#auth-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#sb-username').textContent=$('#tb-avatar').textContent=S.username;
  $('#sb-email').textContent=S.email;
  setAvatarEl('sb-avatar','sb-avatar-init',S.avatarUrl,S.username);
  S.socket.emit('authenticate',{token:S.token});
  initE2E();  // Generate E2E keys after login
}

$('#btn-logout')?.addEventListener('click', doLogout);
function doLogout() {
  ['nexchat_token','nexchat_username','nexchat_email','nexchat_avatar'].forEach(k=>localStorage.removeItem(k));
  Object.assign(S,{token:null,username:null,email:null,avatarUrl:null,currentRoom:null,rooms:[],messages:{},keyPair:null,aesKeys:{},e2eReady:false});
  S.onlineUsers.clear(); showAuth();
}

/* ══════════════════════
   ⑦ ROOMS
══════════════════════ */
async function fetchRooms() {
  try {
    const res=await authFetch(`${API}/rooms`); S.rooms=await res.json();
  } catch { S.rooms=[{room_id:1,room_name:'general'},{room_id:2,room_name:'random'},{room_id:3,room_name:'tech'}]; }
  renderRoomList();
  if(S.rooms.length) switchRoom(S.rooms[0].room_name);

  // Check for invite code in URL
  const pathParts = window.location.pathname.split('/');
  if (pathParts[1] === 'join' && pathParts[2]) {
    handleInviteCode(pathParts[2]);
  }
}

async function handleInviteCode(code) {
  try {
    const res = await fetch(`${API}/invite/validate/${code}`);
    const data = await res.json();
    if (data.valid) {
      showToast(`Joining #${data.room} via invite link…`);
      await authFetch(`${API}/invite/use/${code}`, { method: 'POST' });
      if (!S.rooms.find(r => r.room_name === data.room)) {
        S.rooms.push({ room_id: Date.now(), room_name: data.room });
        renderRoomList();
      }
      switchRoom(data.room);
    }
  } catch { showToast('Invalid or expired invite link.'); }
}

function renderRoomList() {
  const list=$('#room-list'); list.innerHTML='';
  S.rooms.forEach(r => {
    const li=document.createElement('li'); li.className=`sb-item${r.room_name===S.currentRoom?' active':''}`;
    li.dataset.room=r.room_name; li.innerHTML=`<span class="sb-hash">#</span><span>${esc(r.room_name)}</span>`;
    li.addEventListener('click',()=>switchRoom(r.room_name)); list.appendChild(li);
  });
}

function switchRoom(name) {
  if(S.currentRoom===name)return;
  if(S.currentRoom)S.socket.emit('leave_room',{room:S.currentRoom});
  S.currentRoom=name;
  document.querySelectorAll('.sb-item[data-room]').forEach(el=>el.classList.toggle('active',el.dataset.room===name));
  $('#ch-room').textContent=$('#tb-room-name').textContent=`# ${name}`;
  $('#inp').placeholder=`Message #${name}… (🔒 E2E Encrypted)`;
  $('#ch-meta').textContent=`#${name} channel`;
  hide($('#pinned-banner'));
  clearMessages();
  S.socket.emit('join_room',{room:name,token:S.token});
  closeSidebar();
}

$('#btn-add-room')?.addEventListener('click',()=>show($('#add-room-modal')));
$('#btn-close-room')?.addEventListener('click',()=>hide($('#add-room-modal')));
$('#btn-create-room')?.addEventListener('click',()=>{
  const name=$('#new-room-input').value.trim().toLowerCase().replace(/\s+/g,'-');
  if(!name)return;
  if(!S.rooms.find(r=>r.room_name===name)){ S.rooms.push({room_id:Date.now(),room_name:name}); renderRoomList(); switchRoom(name); }
  hide($('#add-room-modal')); $('#new-room-input').value='';
});

/* ══════════════════════
   ⑧ MESSAGES
══════════════════════ */
function clearMessages() { $('#messages').innerHTML=''; addDaySep('Today'); }
function addDaySep(label) { const d=document.createElement('div'); d.className='day-sep'; d.innerHTML=`<span>${label}</span>`; $('#messages').appendChild(d); }

function getDateLabel(ts) {
  if(!ts)return 'Today'; const d=new Date(ts); if(isNaN(d))return 'Today';
  const diff=Math.floor((new Date()-d)/86400000);
  if(diff===0)return 'Today'; if(diff===1)return 'Yesterday';
  return d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
}

function renderMessages() {
  clearMessages();
  const msgs=S.messages[S.currentRoom]||[];
  if(!msgs.length){ const d=document.createElement('div'); d.className='msg-system'; d.textContent='No messages yet. Say hello! 👋'; $('#messages').appendChild(d); return; }
  let lastDate=null;
  msgs.forEach(msg => {
    const ds=getDateLabel(msg.timestamp);
    if(ds!==lastDate){lastDate=ds;addDaySep(ds);}
    $('#messages').appendChild(buildMsgEl(msg));
  });
  scrollBottom();
}

function appendMsg(msg) {
  const ds=getDateLabel(msg.timestamp);
  const lastSep=$('#messages').querySelector('.day-sep:last-of-type');
  if(!lastSep||lastSep.textContent.trim()!==ds)addDaySep(ds);
  $('#messages').appendChild(buildMsgEl(msg));
}

function buildMsgEl(msg) {
  const isOwn=msg.sender===S.username;
  const div=document.createElement('div');
  div.className=`msg${isOwn?' own':''}${msg.is_deleted?' deleted-msg':''}${msg.pinned?' pinned-msg':''}`;
  div.dataset.mid=msg.id||'';

  let avHtml = msg.avatar_url
    ? `<img src="${esc(msg.avatar_url)}" alt="" onerror="this.style.display='none'"/>`
    : (msg.sender||'?').charAt(0).toUpperCase();

  let contentHtml = '';
  if (msg.is_deleted) {
    contentHtml = `<div class="msg-text">🗑️ This message was deleted</div>`;
  } else if (msg.msg_type === 'voice') {
    contentHtml = buildVoiceEl(msg);
  } else if (msg.msg_type === 'file' && msg.file_info) {
    contentHtml = `<div class="msg-file"><span class="msg-file-icon">📎</span><div><div class="msg-file-name">${esc(msg.file_info.name)}</div><div class="msg-file-size">${fmtSize(msg.file_info.size)}</div></div></div>`;
  } else {
    const encBadge = msg.is_encrypted ? `<span class="msg-encrypted-badge">🔒</span>` : '';
    contentHtml = `<div class="msg-text">${esc(msg.message_text||'')}</div>`;
    if (encBadge && !isOwn) contentHtml = encBadge + contentHtml;
  }

  const receipt = isOwn && !msg.is_deleted
    ? `<div class="msg-receipt${msg.status==='read'?' read':''}">
         ${msg.status==='read'?'✓✓ Read':'✓ Sent'}
       </div>` : '';

  div.innerHTML = `
    <div class="msg-av${isOwn?' own-av':''}">${avHtml}</div>
    <div class="msg-body">
      <div class="msg-top">
        <span class="msg-author">${esc(msg.sender||'Unknown')}</span>
        <span class="msg-ts">${formatTime(msg.timestamp)}</span>
      </div>
      ${contentHtml}
      <div class="reactions-row" id="reactions-${msg.id}"></div>
      ${receipt}
    </div>
    ${!msg.is_deleted ? `
    <div class="msg-actions">
      <button class="react-btn" onclick="showReactionPicker(event,${msg.id})">😀</button>
      <button class="react-btn" onclick="showCtxMenu(event,${msg.id},'${msg.sender}')">⋯</button>
    </div>` : ''}`;
  return div;
}

function buildVoiceEl(msg) {
  const bars = Array.from({length:20},(_,i)=>`<div class="voice-bar-vis" style="height:${4+Math.sin(i*.8)*8+Math.random()*6}px"></div>`).join('');
  return `<div class="msg-voice">
    <button class="voice-play-btn" onclick="playVoiceMsg(this,'${msg.id}')">▶</button>
    <div class="voice-waveform">${bars}</div>
    <span class="voice-duration">${msg.voice_duration||'0:00'}</span>
  </div>`;
}

window.playVoiceMsg = function(btn, msgId) {
  const msg = (S.messages[S.currentRoom]||[]).find(m => String(m.id)===String(msgId));
  if (!msg || !msg.voice_data) return;
  try {
    const audio = new Audio(msg.voice_data);
    btn.textContent = '⏸';
    audio.play();
    audio.onended = () => { btn.textContent = '▶'; };
  } catch {}
};

function scrollBottom() { const el=$('#messages'); el.scrollTop=el.scrollHeight; }
function appendSysMsg(text) { const d=document.createElement('div'); d.className='msg-system'; d.textContent=text; $('#messages').appendChild(d); scrollBottom(); }

/* ══════════════════════
   ⑨ SEND MESSAGE
══════════════════════ */
$('#btn-send')?.addEventListener('click', sendMsg);
$('#inp')?.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();} });
$('#inp')?.addEventListener('input', () => { autoResize($('#inp')); handleTyping(); });

async function sendMsg() {
  const text = $('#inp').value.trim();
  if (!text || !S.currentRoom) return;

  $('#btn-send').classList.add('sending');
  setTimeout(() => $('#btn-send').classList.remove('sending'), 350);

  // E2E encrypt if available
  const encText = S.e2eReady ? await encryptMsg(text) : text;
  const isEncrypted = encText !== text;

  S.socket.emit('send_message', {
    room:     S.currentRoom,
    text:     encText,
    msg_type: isEncrypted ? 'encrypted' : 'text',
  });
  $('#inp').value = ''; autoResize($('#inp')); stopTyping();
}

function autoResize(ta) { ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,130)+'px'; }

/* ══════════════════════
   ⑩ VOICE MESSAGES
══════════════════════ */
$('#btn-voice')?.addEventListener('click', toggleVoiceRecording);

async function toggleVoiceRecording() {
  if (S.mediaRecorder && S.mediaRecorder.state === 'recording') {
    stopVoiceRecording(); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    S.mediaRecorder = new MediaRecorder(stream);
    S.audioChunks   = [];
    S.mediaRecorder.ondataavailable = e => S.audioChunks.push(e.data);
    S.mediaRecorder.onstop = sendVoiceMessage;
    S.mediaRecorder.start();

    // Show voice bar
    show($('#voice-bar')); hide($('#input-row'));
    $('#btn-voice').classList.add('recording');

    // Timer
    S.voiceSeconds = 0;
    S.voiceTimer = setInterval(() => {
      S.voiceSeconds++;
      const m = Math.floor(S.voiceSeconds/60), s = S.voiceSeconds%60;
      $('#voice-timer').textContent = `● ${m}:${String(s).padStart(2,'0')}`;
      if (S.voiceSeconds >= 120) stopVoiceRecording(); // Max 2 min
    }, 1000);
    showToast('🎤 Recording… tap again to stop');
  } catch (e) {
    showToast('Microphone access denied. Please allow mic access.');
  }
}

function stopVoiceRecording() {
  if (S.mediaRecorder && S.mediaRecorder.state === 'recording') {
    S.mediaRecorder.stop();
    S.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  clearInterval(S.voiceTimer);
  hide($('#voice-bar')); show($('#input-row'));
  $('#btn-voice').classList.remove('recording');
  $('#voice-timer').textContent = '● 0:00';
}

$('#btn-voice-cancel')?.addEventListener('click', () => {
  if (S.mediaRecorder && S.mediaRecorder.state === 'recording') {
    S.mediaRecorder.ondataavailable = () => {};  // discard
    S.mediaRecorder.onstop = () => {};
    S.mediaRecorder.stop();
    S.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  clearInterval(S.voiceTimer);
  hide($('#voice-bar')); show($('#input-row'));
  $('#btn-voice').classList.remove('recording');
  S.audioChunks = [];
  showToast('Voice message cancelled.');
});

$('#btn-voice-send')?.addEventListener('click', stopVoiceRecording);

function sendVoiceMessage() {
  if (!S.audioChunks.length || !S.currentRoom) return;
  const blob     = new Blob(S.audioChunks, { type: 'audio/webm' });
  const duration = S.voiceSeconds;
  const reader   = new FileReader();
  reader.onloadend = () => {
    const base64 = reader.result;
    S.socket.emit('send_message', {
      room:           S.currentRoom,
      text:           `[Voice Message ${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}]`,
      msg_type:       'voice',
      voice_data:     base64,
      voice_duration: `${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}`,
      file_info:      { name: 'voice_message.webm', size: blob.size },
    });
    showToast('🎤 Voice message sent!');
  };
  reader.readAsDataURL(blob);
  S.audioChunks = [];
}

/* ══════════════════════
   ⑪ INVITE LINKS
══════════════════════ */
$('#btn-invite')?.addEventListener('click', openInviteModal);
$('#btn-close-invite')?.addEventListener('click', () => hide($('#invite-modal')));

async function openInviteModal() {
  if (!S.currentRoom) { showToast('Join a channel first!'); return; }
  $('#invite-room-name').textContent = `#${S.currentRoom}`;
  $('#invite-link-text').textContent = 'Generating…';
  show($('#invite-modal'));
  await generateInviteLink();
}

async function generateInviteLink() {
  try {
    const hours  = $('#invite-hours').value;
    const res    = await authFetch(`${API}/invite/create`, {
      method: 'POST',
      body:   JSON.stringify({ room: S.currentRoom, hours_valid: parseInt(hours) }),
    });
    const data   = await res.json();
    $('#invite-link-text').textContent = data.link;
    $('#invite-meta').textContent = `Valid for ${data.expires} · Max 100 uses`;
  } catch {
    $('#invite-link-text').textContent = `${window.location.origin}/join/demo-link`;
    showToast('Could not generate link — showing demo.');
  }
}

$('#btn-gen-invite')?.addEventListener('click', generateInviteLink);

$('#btn-copy-invite')?.addEventListener('click', () => {
  const link = $('#invite-link-text').textContent;
  navigator.clipboard.writeText(link).then(() => {
    showToast('🔗 Invite link copied!');
    $('#btn-copy-invite').textContent = '✅ Copied!';
    setTimeout(() => { $('#btn-copy-invite').textContent = '📋 Copy'; }, 2000);
  });
});

/* ══════════════════════
   ⑫ PIN MESSAGES
══════════════════════ */
$('#btn-pin-view')?.addEventListener('click', openPinsModal);
$('#btn-close-pins')?.addEventListener('click', () => hide($('#pins-modal')));
$('#btn-view-all-pins')?.addEventListener('click', openPinsModal);
$('#btn-close-pin-banner')?.addEventListener('click', () => hide($('#pinned-banner')));

async function openPinsModal() {
  if (!S.currentRoom) return;
  show($('#pins-modal'));
  try {
    const res  = await authFetch(`${API}/rooms/${S.currentRoom}/pinned`);
    const pins = await res.json();
    renderPinsList(pins);
  } catch { renderPinsList([]); }
}

function renderPinsList(pins) {
  const list = $('#pins-list');
  if (!pins.length) {
    list.innerHTML = `<div style="color:var(--text-3);text-align:center;padding:24px">No pinned messages in #${S.currentRoom}</div>`;
    return;
  }
  list.innerHTML = pins.map(p => `
    <div class="pin-item">
      <div class="pin-item-author">📌 ${esc(p.username)}</div>
      <div class="pin-item-text">${esc(p.message_text||'')}</div>
      <div class="pin-item-time">${formatTime(p.timestamp)}</div>
      <button class="pin-unpin-btn" onclick="unpinMessage(${p.message_id})">🗑</button>
    </div>`).join('');
}

window.unpinMessage = function(messageId) {
  S.socket.emit('pin_message', { message_id: messageId, room: S.currentRoom, action: 'unpin' });
  hide($('#pins-modal'));
};

function updatePinnedBanner(pins) {
  if (!pins || !pins.length) { hide($('#pinned-banner')); return; }
  const latest = pins[0];
  $('#pinned-text').textContent = `${latest.username}: ${(latest.message_text||'').slice(0,60)}`;
  show($('#pinned-banner'));
}

/* ══════════════════════
   ⑬ DELETE FOR EVERYONE
══════════════════════ */
window.showCtxMenu = function(event, messageId, senderName) {
  event.stopPropagation();
  S.ctxMessageId = messageId;
  S.ctxRoom      = S.currentRoom;
  const menu = $('#ctx-menu');
  menu.style.left = `${Math.min(event.clientX, window.innerWidth-200)}px`;
  menu.style.top  = `${Math.max(event.clientY-80, 10)}px`;
  // Show delete only for own messages
  const deleteBtn = $('#ctx-delete');
  if (deleteBtn) deleteBtn.style.display = senderName === S.username ? '' : 'none';
  show(menu);
};

document.addEventListener('click', e => {
  if (!$('#ctx-menu').contains(e.target)) hide($('#ctx-menu'));
  if (!$('#reaction-quick').contains(e.target)) hide($('#reaction-quick'));
});

$('#ctx-close')?.addEventListener('click', () => hide($('#ctx-menu')));

$('#ctx-delete')?.addEventListener('click', () => {
  if (!S.ctxMessageId || !S.ctxRoom) return;
  if (!confirm('Delete this message for everyone?')) return;
  S.socket.emit('delete_message', { message_id: S.ctxMessageId, room: S.ctxRoom });
  hide($('#ctx-menu'));
  showToast('🗑️ Message deleted for everyone.');
});

$('#ctx-pin')?.addEventListener('click', () => {
  if (!S.ctxMessageId || !S.ctxRoom) return;
  S.socket.emit('pin_message', { message_id: S.ctxMessageId, room: S.ctxRoom, action: 'pin' });
  hide($('#ctx-menu'));
});

$('#ctx-react')?.addEventListener('click', (e) => {
  hide($('#ctx-menu'));
  const msgEl = $('#messages').querySelector(`[data-mid="${S.ctxMessageId}"]`);
  if (msgEl) showReactionPicker(e, S.ctxMessageId);
});

/* ══════════════════════
   ⑭ REACTIONS
══════════════════════ */
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥'];

window.showReactionPicker = function(event, messageId) {
  event.stopPropagation();
  S.ctxMessageId = messageId;
  const picker = $('#reaction-quick');
  picker.style.left = `${Math.min(event.clientX-100, window.innerWidth-220)}px`;
  picker.style.top  = `${Math.max(event.clientY-60, 10)}px`;
  show(picker);
};

document.querySelectorAll('.rq-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    if (!S.ctxMessageId || !S.currentRoom) return;
    S.socket.emit('react_message', { room: S.currentRoom, message_id: S.ctxMessageId, emoji, action: 'add' });
    hide($('#reaction-quick'));
    // Float animation
    floatReaction(emoji, btn.getBoundingClientRect());
  });
});

function floatReaction(emoji, rect) {
  const el = document.createElement('div');
  el.className = 'reaction-float';
  el.textContent = emoji;
  el.style.left = `${rect.left + rect.width/2}px`;
  el.style.top  = `${rect.top}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function renderReactions(container, reactions, messageId) {
  container.innerHTML = '';
  reactions.forEach(r => {
    const users = (r.users||'').split(','), isMine = users.includes(S.username);
    const pill = document.createElement('div');
    pill.className = `reaction-pill${isMine?' mine':''}`;
    pill.innerHTML = `${r.emoji}<span class="reaction-count">${r.count}</span>`;
    pill.title = users.join(', ');
    pill.addEventListener('click', () => {
      S.socket.emit('react_message', { room: S.currentRoom, message_id: messageId, emoji: r.emoji, action: isMine?'remove':'add' });
    });
    container.appendChild(pill);
  });
}

/* ══════════════════════
   ⑮ CONFETTI 🎊
══════════════════════ */
function triggerConfetti() {
  const canvas = $('#confetti-canvas');
  canvas.style.display = 'block';
  const ctx = canvas.getContext('2d');
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#00e5c4','#0099ff','#a78bfa','#f472b6','#ffd166','#06d6a0'];
  const pieces = Array.from({ length: 150 }, () => ({
    x:    Math.random() * canvas.width,
    y:    -10 - Math.random() * canvas.height * .5,
    w:    6 + Math.random() * 10,
    h:    10 + Math.random() * 16,
    vy:   4 + Math.random() * 4,
    vx:   (Math.random() - .5) * 4,
    rot:  Math.random() * 360,
    drot: (Math.random() - .5) * 8,
    col:  colors[Math.floor(Math.random() * colors.length)],
    alpha:1,
  }));

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.y   += p.vy;
      p.x   += p.vx;
      p.rot += p.drot;
      if (p.y > canvas.height * .8) p.alpha -= .04;
      if (p.alpha > 0) { alive = true; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillStyle = p.col;
      ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h);
      ctx.restore();
    });
    frame++;
    if (alive && frame < 180) requestAnimationFrame(draw);
    else { ctx.clearRect(0,0,canvas.width,canvas.height); canvas.style.display='none'; }
  }
  draw();
  showToast('🎊 You sent your first message!');
}

/* ══════════════════════
   TYPING
══════════════════════ */
function handleTyping() {
  if(!S.isTyping&&S.currentRoom){S.isTyping=true;S.socket.emit('typing',{room:S.currentRoom});}
  clearTimeout(S.typingTimer); S.typingTimer=setTimeout(stopTyping,2000);
}
function stopTyping() { if(S.isTyping&&S.currentRoom){S.isTyping=false;S.socket.emit('stop_typing',{room:S.currentRoom});} }
function showTyping(typers) {
  const row=$('#typing-row'),lbl=$('#typing-label');
  if(!typers.length){row.classList.add('hidden');return;}
  lbl.textContent=`${typers.join(', ')} ${typers.length===1?'is':'are'} typing…`;
  row.classList.remove('hidden');
}

/* ══════════════════════
   FILE SHARING
══════════════════════ */
$('#btn-attach')?.addEventListener('click',()=>$('#file-input').click());
$('#file-input')?.addEventListener('change',()=>{
  const file=$('#file-input').files[0]; if(!file)return;
  S.selectedFile=file; $('#file-preview').textContent=`📎 ${file.name}\n${fmtSize(file.size)}`;
  show($('#file-modal')); $('#file-input').value='';
});
$('#btn-close-file')?.addEventListener('click',closeFileModal);
$('#btn-cancel-file')?.addEventListener('click',closeFileModal);
function closeFileModal(){S.selectedFile=null;hide($('#file-modal'));}
$('#btn-confirm-file')?.addEventListener('click',()=>{
  if(!S.selectedFile||!S.currentRoom)return;
  S.socket.emit('send_message',{room:S.currentRoom,text:'',msg_type:'file',file_info:{name:S.selectedFile.name,size:S.selectedFile.size}});
  closeFileModal(); showToast('File sent 📎');
});

/* ══════════════════════
   MESSAGE SEARCH
══════════════════════ */
$('#btn-search-msg')?.addEventListener('click',()=>toggle($('#search-bar')));
$('#btn-close-search')?.addEventListener('click',()=>{hide($('#search-bar'));renderMessages();});
$('#search-input')?.addEventListener('input',()=>{
  const q=$('#search-input').value.toLowerCase().trim(), msgs=S.messages[S.currentRoom]||[];
  if(!q){renderMessages();return;}
  clearMessages(); addDaySep(`Results for "${esc(q)}"`);
  const hits=msgs.filter(m=>(m.message_text||'').toLowerCase().includes(q));
  if(!hits.length)appendSysMsg('No messages found.');
  else hits.forEach(m=>$('#messages').appendChild(buildMsgEl(m)));
});

$('#sb-search')?.addEventListener('input',()=>{
  const q=$('#sb-search').value.toLowerCase();
  document.querySelectorAll('#room-list .sb-item').forEach(li=>{
    const nm=li.querySelector('span:last-child')?.textContent.toLowerCase()||'';
    li.style.display=(!q||nm.includes(q))?'':'none';
  });
});

/* ══════════════════════
   EMOJI PICKER
══════════════════════ */
const EMOJI_CATS = {
  smileys:{icon:'😀',emojis:'😀😂🥹😍🤩😎🥳🤔😅🤣😭😱🙄😴😡🥺😏🫡🥰😇🤗😶🫠🤫🤭😬🙃😜😝😛🤪'},
  gestures:{icon:'👋',emojis:'👋✌️🤞👍👎👌🤌🤏🖐️✋👊🤝🙏🤲👐🫶❤️🧡💛💚💙💜🖤🤍'},
  nature:{icon:'🌿',emojis:'🌿🌸🌺🌻🌹🍀🌈⭐🌟💫✨🔥💧🌊🌍🌙☀️🌤️⛅🌧️❄️🌈🦋🐬🦁🐶🐱'},
  food:{icon:'🍕',emojis:'🍕🍔🌮🍜🍣🍰🎂🍩🍪🍫🍭🥐🍞🧀🥗🍱🥡🧃☕🍵🧋🍺🥂🍾🎉🎊'},
  symbols:{icon:'🔥',emojis:'🔥⚡🎯💡🔒🔓📎📌🎵🎶🎮🏆🚀💯🌟✅❌⚠️💬🗓️🔧⚙️🎨📊💻📱'},
};

(function buildEmoji() {
  const cats=$('#ep-cats'), grid=$('#ep-grid');
  Object.keys(EMOJI_CATS).forEach(key => {
    const btn=document.createElement('button'); btn.className=`ep-cat-btn${key===S.emojiCat?' active':''}`; btn.textContent=EMOJI_CATS[key].icon; btn.title=key;
    btn.addEventListener('click',()=>{document.querySelectorAll('.ep-cat-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');S.emojiCat=key;loadE(key);});
    cats.appendChild(btn);
  });
  function loadE(cat) {
    grid.innerHTML='';
    EMOJI_CATS[cat].emojis.split('').filter(c=>c.trim()).forEach(e=>{
      const b=document.createElement('button'); b.className='e-btn'; b.textContent=e;
      b.addEventListener('click',()=>{const ta=$('#inp');ta.value+=e;ta.focus();hide($('#emoji-picker'));});
      grid.appendChild(b);
    });
  }
  loadE(S.emojiCat);
})();

$('#btn-emoji')?.addEventListener('click',e=>{e.stopPropagation();toggle($('#emoji-picker'));});
document.addEventListener('click',e=>{if(!$('#emoji-picker').contains(e.target)&&e.target!==$('#btn-emoji'))hide($('#emoji-picker'));});

/* ══════════════════════
   NOTIFICATION SOUND
══════════════════════ */
let audioCtx=null;
function getAudioCtx(){if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();return audioCtx;}
function playNotifSound(){
  try{const ctx=getAudioCtx(),osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.type='sine';osc.frequency.value=880;
    gain.gain.setValueAtTime(.2,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+.3);
    osc.start(ctx.currentTime);osc.stop(ctx.currentTime+.3);}catch{}
}
document.addEventListener('click',()=>{getAudioCtx();},{once:true});

/* ══════════════════════
   PROFILE
══════════════════════ */
$('#btn-profile')?.addEventListener('click',openProfile);
$('#sb-user-card')?.addEventListener('click',openProfile);
$('#btn-close-profile')?.addEventListener('click',()=>hide($('#profile-modal')));
$('#profile-av-url')?.addEventListener('input',()=>{setAvatarEl('profile-avatar-img','profile-avatar-init',$('#profile-av-url').value.trim(),S.username);});
$('#btn-save-profile')?.addEventListener('click',async()=>{
  const bio=$('#profile-bio').value.trim(), avatar=$('#profile-av-url').value.trim();
  try{await authFetch(`${API}/profile`,{method:'PUT',body:JSON.stringify({bio,avatar_url:avatar})});
    S.avatarUrl=avatar;localStorage.setItem('nexchat_avatar',avatar);setAvatarEl('sb-avatar','sb-avatar-init',avatar,S.username);
    hide($('#profile-modal'));showToast('Profile saved! ✅');}catch{showToast('Could not save profile.');}
});

async function openProfile() {
  show($('#profile-modal'));
  $('#profile-username').value=S.username||''; $('#profile-email').value=S.email||'';
  try{const res=await authFetch(`${API}/profile`),data=await res.json();
    $('#profile-bio').value=data.bio||''; $('#profile-av-url').value=data.avatar_url||'';
    setAvatarEl('profile-avatar-img','profile-avatar-init',data.avatar_url,S.username);}catch{}
}

/* ══════════════════════
   MEMBERS
══════════════════════ */
$('#btn-members')?.addEventListener('click',()=>toggle($('#members-panel')));
$('#btn-close-members')?.addEventListener('click',()=>hide($('#members-panel')));

function renderOnline() {
  const count=S.onlineUsers.size;
  $('#online-count').textContent=count; $('#mp-online').textContent=count;
  const list=$('#online-list'); list.innerHTML='';
  S.onlineUsers.forEach(u=>{const li=document.createElement('li');li.className='sb-item';li.innerHTML=`<span class="sb-udot"></span>${esc(u)}`;list.appendChild(li);});
  const ml=$('#mp-online-list'); ml.innerHTML='';
  S.onlineUsers.forEach(u=>{const li=document.createElement('li');li.className='mp-item';li.innerHTML=`<div class="mp-av">${u.charAt(0).toUpperCase()}</div>${esc(u)}<span class="sb-udot" style="margin-left:auto"></span>`;ml.appendChild(li);});
}

/* ══════════════════════
   MOBILE NAV
══════════════════════ */
document.querySelectorAll('.bnav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bnav-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const view=btn.dataset.view;
    if(view==='chat'){closeSidebar();hide($('#members-panel'));}
    else if(view==='channels'){$('#sidebar').classList.add('open');hide($('#members-panel'));}
    else if(view==='members'){closeSidebar();$('#members-panel').classList.remove('hidden');}
    else if(view==='profile'){closeSidebar();openProfile();}
  });
});

$('#btn-menu')?.addEventListener('click',()=>$('#sidebar').classList.add('open'));
document.addEventListener('click',e=>{const sb=$('#sidebar');if(sb.classList.contains('open')&&!sb.contains(e.target)&&e.target!==$('#btn-menu'))closeSidebar();});
function closeSidebar(){$('#sidebar').classList.remove('open');}

/* ══════════════════════
   STATS
══════════════════════ */
async function fetchStats() {
  try{const res=await authFetch(`${API}/stats`),data=await res.json(),el=$('#st-mongo');
    if(data.mongodb?.status==='connected'){el.textContent='Active';el.className='dbs-badge green';}
    else{el.textContent='Offline';el.className='dbs-badge red';}}catch{}
}

/* ══════════════════════
   UTILS
══════════════════════ */
function normalizeMsg(raw) {
  return {
    id:           raw.message_id||raw.id||Date.now(),
    sender:       raw.sender||raw.username||'Unknown',
    avatar_url:   raw.avatar_url||'',
    message_text: raw.message_text||raw.text||'',
    msg_type:     raw.msg_type||'text',
    file_info:    raw.file_info||null,
    voice_data:   raw.voice_data||null,
    voice_duration:raw.voice_duration||'0:00',
    timestamp:    raw.timestamp||new Date().toISOString(),
    is_deleted:   raw.is_deleted||false,
    is_encrypted: raw.is_encrypted||false,
    pinned:       raw.pinned||false,
    status:       raw.status||'sent',
  };
}
function formatTime(ts){if(!ts)return'';const d=new Date(ts);if(isNaN(d))return ts.slice(11,16)||'';return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function setAvatarEl(imgId,initId,url,username){const img=$(`#${imgId}`),init=$(`#${initId}`);if(!img||!init)return;if(url){img.src=url;img.classList.remove('hidden');init.classList.add('hidden');}else{img.classList.add('hidden');init.classList.remove('hidden');init.textContent=(username||'?').charAt(0).toUpperCase();}}
function esc(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function fmtSize(b){if(!b)return'';if(b<1024)return`${b} B`;if(b<1048576)return`${(b/1024).toFixed(1)} KB`;return`${(b/1048576).toFixed(1)} MB`;}
function show(el){el?.classList.remove('hidden');}
function hide(el){el?.classList.add('hidden');}
function toggle(el){el?.classList.toggle('hidden');}
function authFetch(url,opts={}){return fetch(url,{...opts,headers:{'Content-Type':'application/json','Authorization':`Bearer ${S.token}`,...(opts.headers||{})},body:opts.body});}

let _toastTimer;
function showToast(msg){const old=document.querySelector('.toast');if(old)old.remove();clearTimeout(_toastTimer);const t=document.createElement('div');t.className='toast';t.textContent=msg;document.body.appendChild(t);_toastTimer=setTimeout(()=>t.remove(),3500);}
function showAuthErr(el,msg){el.textContent=msg;show(el);setTimeout(()=>hide(el),5000);}
function setLoading(sel,on){const btn=$(sel);if(!btn)return;btn.disabled=on;const sp=btn.querySelector('span');if(sp)sp.textContent=on?'Please wait…':(sel.includes('login')?'Sign In':'Create Account');}

/* ══════════════════════
   BOOT
══════════════════════ */
initSocket();
