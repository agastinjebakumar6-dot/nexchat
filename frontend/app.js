/**
 * NexChat v2 — app.js
 * Features: Google OAuth, Splash, Dark/Light, Reactions,
 *           Notification Sound, Timestamp Groups, Profile,
 *           Animated Send, Mobile Bottom Nav, Message Search
 */

/* ══════════════════════════════════════
   CONFIG
══════════════════════════════════════ */
const SERVER = window.location.origin;
const API    = `${SERVER}/api`;
// Set your Google Client ID here or in the HTML data attribute
const GOOGLE_CLIENT_ID = document.getElementById('google-client-id')
  ?.dataset.clientId || 'YOUR_GOOGLE_CLIENT_ID_HERE';

/* ══════════════════════════════════════
   STATE
══════════════════════════════════════ */
const S = {
  token:        null,
  username:     null,
  email:        null,
  avatarUrl:    null,
  currentRoom:  null,
  rooms:        [],
  onlineUsers:  new Set(),
  messages:     {},          // { room: [...] }
  socket:       null,
  theme:        localStorage.getItem('nexchat_theme') || 'dark',
  typingTimer:  null,
  isTyping:     false,
  selectedFile: null,
  emojiCat:     'smileys',
};

/* ══════════════════════════════════════
   DOM
══════════════════════════════════════ */
const $ = s => document.querySelector(s);

/* ══════════════════════════════════════
   ① SPLASH SCREEN
══════════════════════════════════════ */
(function runSplash() {
  const fill  = $('#splash-fill');
  const pct   = $('#splash-pct');
  const steps = ['Initializing…', 'Loading assets…', 'Connecting…', 'Ready!'];
  let p = 0;

  const iv = setInterval(() => {
    p += Math.random() * 18 + 8;
    if (p >= 100) {
      p = 100;
      clearInterval(iv);
      pct.textContent = 'Ready!';
      fill.style.width = '100%';
      setTimeout(hideSplash, 400);
      return;
    }
    const idx = Math.floor((p / 100) * steps.length);
    pct.textContent  = steps[Math.min(idx, steps.length - 1)];
    fill.style.width = p + '%';
  }, 120);
})();

function hideSplash() {
  const splash = $('#splash');
  splash.classList.add('out');
  setTimeout(() => {
    splash.style.display = 'none';
    checkAutoLogin();
  }, 620);
}

/* ══════════════════════════════════════
   ② THEME — DARK / LIGHT
══════════════════════════════════════ */
function applyTheme(t) {
  S.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('nexchat_theme', t);
  const icon = t === 'dark' ? '☀️' : '🌙';
  const btn  = $('#btn-theme');
  const btnT = $('#btn-theme-top');
  if (btn)  btn.textContent  = icon;
  if (btnT) btnT.textContent = icon;

  // Save to server if logged in
  if (S.token) {
    authFetch(`${API}/theme`, {
      method: 'POST',
      body: JSON.stringify({ theme: t }),
    }).catch(() => {});
  }
}

function toggleTheme() {
  applyTheme(S.theme === 'dark' ? 'light' : 'dark');
}

$('#btn-theme')?.addEventListener('click', toggleTheme);
$('#btn-theme-top')?.addEventListener('click', toggleTheme);
applyTheme(S.theme);  // Apply saved theme on load


/* ══════════════════════════════════════
   ③ PARTICLE CANVAS (Auth BG)
══════════════════════════════════════ */
function initCanvas() {
  const canvas = $('#auth-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  let W, H, dots = [];

  function resize() {
    W = canvas.width  = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 55; i++) {
    dots.push({
      x: Math.random() * 1000,
      y: Math.random() * 800,
      r: Math.random() * 1.5 + 0.5,
      vx: (Math.random() - .5) * .4,
      vy: (Math.random() - .5) * .4,
      a: Math.random() * .5 + .1,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const col = S.theme === 'dark' ? '0,229,196' : '0,150,199';
    dots.forEach(d => {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0 || d.x > W) d.vx *= -1;
      if (d.y < 0 || d.y > H) d.vy *= -1;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col},${d.a})`;
      ctx.fill();
    });
    // Connect nearby dots
    for (let i = 0; i < dots.length; i++) {
      for (let j = i+1; j < dots.length; j++) {
        const dx = dots[i].x - dots[j].x;
        const dy = dots[i].y - dots[j].y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 100) {
          ctx.beginPath();
          ctx.moveTo(dots[i].x, dots[i].y);
          ctx.lineTo(dots[j].x, dots[j].y);
          ctx.strokeStyle = `rgba(${col},${.15 * (1 - dist/100)})`;
          ctx.lineWidth = .5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}
initCanvas();


/* ══════════════════════════════════════
   ④ WEBSOCKET
══════════════════════════════════════ */
function initSocket() {
  S.socket = io(SERVER, { transports: ['websocket', 'polling'] });
  const sk  = S.socket;

  sk.on('connect', () => {
    setWsDot('live');
    if (S.token) sk.emit('authenticate', { token: S.token });
  });
  sk.on('disconnect', () => { setWsDot('err'); showToast('Connection lost…'); });
  sk.on('connect_error', () => setWsDot('err'));

  sk.on('authenticated', data => {
    data.online_users.forEach(u => S.onlineUsers.add(u));
    renderOnline();
    fetchRooms();
    fetchStats();
  });
  sk.on('auth_error', () => { showToast('Session expired.'); doLogout(); });

  sk.on('room_history', data => {
    S.messages[data.room] = data.messages.map(normalizeMsg);
    if (data.room === S.currentRoom) renderMessages();
  });

  sk.on('new_message', data => {
    const msg = normalizeMsg(data);
    if (!S.messages[data.room]) S.messages[data.room] = [];
    S.messages[data.room].push(msg);
    if (data.room === S.currentRoom) {
      appendMsg(msg);
      scrollBottom();
      if (msg.sender !== S.username) {
        playNotifSound();
        sk.emit('read_receipt', { room: data.room, message_id: msg.id, reader: S.username });
      }
    }
  });

  sk.on('message_read', data => {
    const el = $('#messages').querySelector(`[data-mid="${data.message_id}"] .msg-receipt`);
    if (el) { el.textContent = '✓✓ Read'; el.classList.add('read'); }
  });

  sk.on('reaction_update', data => {
    if (data.room !== S.currentRoom) return;
    const el = $('#messages').querySelector(`[data-mid="${data.message_id}"] .reactions-row`);
    if (el) renderReactions(el, data.reactions, data.message_id);
  });

  sk.on('typing_update', data => {
    if (data.room !== S.currentRoom) return;
    const typers = data.typers.filter(u => u !== S.username);
    showTyping(typers);
  });

  sk.on('user_joined', data => appendSysMsg(`${data.username} joined #${data.room}`));
  sk.on('user_left',   data => appendSysMsg(`${data.username} left #${data.room}`));

  sk.on('user_online', data => {
    S.onlineUsers.add(data.username);
    renderOnline();
    showToast(`${data.username} is online 🟢`);
  });
  sk.on('user_offline', data => {
    S.onlineUsers.delete(data.username);
    renderOnline();
  });
}

function setWsDot(state) {
  const dot  = $('#ws-dot');
  const lbl  = $('#ws-label');
  const badge = $('#st-ws');
  const cls   = state === 'live' ? 'live' : (state === 'err' ? 'err' : '');
  if (dot) dot.className = `ws-dot ${cls}`;
  if (lbl) lbl.textContent = state === 'live' ? 'Connected' : state === 'err' ? 'Disconnected' : 'Connecting…';
  if (badge) {
    badge.textContent  = state === 'live' ? 'Live' : 'Off';
    badge.className    = `dbs-badge ${state === 'live' ? 'green' : 'red'}`;
  }
}


/* ══════════════════════════════════════
   ⑤ AUTH — Email / Password
══════════════════════════════════════ */
// Tab switcher
document.querySelectorAll('.atab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.atab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.aform').forEach(f => f.classList.remove('active'));
    $(`#${tab}-form`).classList.add('active');
  });
});

// Show/hide password
$('#eye-login')?.addEventListener('click', () => togglePw('#login-pass', '#eye-login'));
$('#eye-reg')?.addEventListener('click',   () => togglePw('#reg-pass',   '#eye-reg'));
function togglePw(fieldSel, btnSel) {
  const f = $(fieldSel); const b = $(btnSel);
  if (f.type === 'password') { f.type = 'text';  b.textContent = '🙈'; }
  else                       { f.type = 'password'; b.textContent = '👁'; }
}

// Password strength
$('#reg-pass')?.addEventListener('input', () => {
  const val = $('#reg-pass').value;
  const str = $('#pass-strength');
  const fil = $('#strength-fill');
  const lbl = $('#strength-label');
  if (!val) { str.classList.add('hidden'); return; }
  str.classList.remove('hidden');
  let score = 0;
  if (val.length >= 8)  score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^a-zA-Z0-9]/.test(val)) score++;
  const colors = ['#ff4d6d','#f4a261','#ffd166','#06d6a0'];
  const labels = ['Weak','Fair','Good','Strong'];
  fil.style.width     = (score * 25) + '%';
  fil.style.background = colors[score - 1] || '#ff4d6d';
  lbl.textContent     = labels[score - 1] || 'Weak';
});

// Login
$('#login-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  const errEl    = $('#login-err');
  if (!username || !password) { showAuthErr(errEl, 'All fields required.'); return; }
  setLoading('#login-btn', true);
  try {
    const res  = await fetch(`${API}/login`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { showAuthErr(errEl, data.error); return; }
    doLogin(data);
  } catch { showAuthErr(errEl, 'Cannot reach server. Is Flask running?'); }
  finally { setLoading('#login-btn', false); }
});

// Register
$('#reg-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('#reg-user').value.trim();
  const email    = $('#reg-email').value.trim();
  const password = $('#reg-pass').value;
  const errEl    = $('#reg-err');
  if (!username || !email || !password) { showAuthErr(errEl, 'All fields required.'); return; }
  if (password.length < 8) { showAuthErr(errEl, 'Password must be 8+ characters.'); return; }
  setLoading('#reg-btn', true);
  try {
    const res  = await fetch(`${API}/register`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) { showAuthErr(errEl, data.error); return; }
    doLogin(data);
    showToast(`Welcome to NexChat, ${username}! 🎉`);
  } catch { showAuthErr(errEl, 'Cannot reach server. Is Flask running?'); }
  finally { setLoading('#reg-btn', false); }
});


/* ══════════════════════════════════════
   ⑥ GOOGLE OAUTH
══════════════════════════════════════ */
window.addEventListener('load', () => {
  if (typeof google === 'undefined' || !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID_HERE') {
    // Google SDK not loaded or not configured — hide button
    const btn = $('#google-signin-btn');
    if (btn) btn.style.display = 'none';
    return;
  }

  google.accounts.id.initialize({
    client_id:  GOOGLE_CLIENT_ID,
    callback:   handleGoogleCredential,
    auto_select: false,
  });

  // Manual button click triggers Google's popup
  $('#google-signin-btn')?.addEventListener('click', () => {
    const clientId = GOOGLE_CLIENT_ID;
    const redirectUri = window.location.origin;
    const url = `https://accounts.google.com/o/oauth2/v2/auth` +
        `?client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=token` +
        `&scope=openid%20email%20profile` +
        `&prompt=select_account`;
    window.location.href = url;
});
});

async function handleGoogleCredential(response) {
  try {
    const res  = await fetch(`${API}/auth/google`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ id_token: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) { showToast('Google login failed: ' + data.error); return; }
    doLogin(data);
    showToast(`Welcome, ${data.name || data.username}! 🎉`);
  } catch { showToast('Cannot reach server.'); }
}


/* ══════════════════════════════════════
   SESSION
══════════════════════════════════════ */
function doLogin(data) {
  S.token     = data.token;
  S.username  = data.username;
  S.email     = data.email || '';
  S.avatarUrl = data.avatar_url || '';

  localStorage.setItem('nexchat_token',    S.token);
  localStorage.setItem('nexchat_username', S.username);
  localStorage.setItem('nexchat_email',    S.email);
  localStorage.setItem('nexchat_avatar',   S.avatarUrl);

  showApp();
}

function checkAutoLogin() {
  const token    = localStorage.getItem('nexchat_token');
  const username = localStorage.getItem('nexchat_username');
  if (token && username) {
    S.token     = token;
    S.username  = username;
    S.email     = localStorage.getItem('nexchat_email')  || '';
    S.avatarUrl = localStorage.getItem('nexchat_avatar') || '';
    showApp();
  } else {
    showAuth();
  }
}

function showAuth() {
  $('#auth-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');

  // Set user info in sidebar
  $('#sb-username').textContent = S.username;
  $('#sb-email').textContent    = S.email;
  $('#tb-avatar').textContent   = S.username.charAt(0).toUpperCase();
  setAvatarEl('sb-avatar', 'sb-avatar-init', S.avatarUrl, S.username);

  S.socket.emit('authenticate', { token: S.token });
}

$('#btn-logout')?.addEventListener('click', doLogout);
function doLogout() {
  localStorage.removeItem('nexchat_token');
  localStorage.removeItem('nexchat_username');
  localStorage.removeItem('nexchat_email');
  localStorage.removeItem('nexchat_avatar');
  Object.assign(S, { token:null, username:null, email:null, avatarUrl:null,
                      currentRoom:null, rooms:[], messages:{} });
  S.onlineUsers.clear();
  showAuth();
}


/* ══════════════════════════════════════
   ⑦ ROOMS
══════════════════════════════════════ */
async function fetchRooms() {
  try {
    const res   = await authFetch(`${API}/rooms`);
    S.rooms     = await res.json();
  } catch {
    S.rooms = [
      { room_id:1, room_name:'general' },
      { room_id:2, room_name:'random' },
      { room_id:3, room_name:'tech' },
    ];
  }
  renderRoomList();
  if (S.rooms.length) switchRoom(S.rooms[0].room_name);
}

function renderRoomList() {
  const list = $('#room-list'); list.innerHTML = '';
  S.rooms.forEach(r => {
    const li = document.createElement('li');
    li.className = `sb-item${r.room_name === S.currentRoom ? ' active' : ''}`;
    li.dataset.room = r.room_name;
    li.innerHTML = `<span class="sb-hash">#</span><span>${esc(r.room_name)}</span>`;
    li.addEventListener('click', () => switchRoom(r.room_name));
    list.appendChild(li);
  });
}

function switchRoom(name) {
  if (S.currentRoom === name) return;
  if (S.currentRoom) S.socket.emit('leave_room', { room: S.currentRoom });
  S.currentRoom = name;

  document.querySelectorAll('.sb-item[data-room]').forEach(el =>
    el.classList.toggle('active', el.dataset.room === name)
  );
  $('#ch-room').textContent        = name;
  $('#tb-room-name').textContent   = `# ${name}`;
  $('#inp').placeholder            = `Message #${name}…`;
  $('#ch-meta').textContent        = `#${name} channel`;

  clearMessages();
  S.socket.emit('join_room', { room: name, token: S.token });
  closeSidebar();
}

// Add room modal
$('#btn-add-room')?.addEventListener('click', () => show($('#add-room-modal')));
$('#btn-close-room')?.addEventListener('click', () => hide($('#add-room-modal')));
$('#btn-create-room')?.addEventListener('click', () => {
  const name = $('#new-room-input').value.trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return;
  if (!S.rooms.find(r => r.room_name === name)) {
    S.rooms.push({ room_id: Date.now(), room_name: name });
    renderRoomList();
    switchRoom(name);
  }
  hide($('#add-room-modal'));
  $('#new-room-input').value = '';
});


/* ══════════════════════════════════════
   ⑧ MESSAGES
══════════════════════════════════════ */
function clearMessages() {
  $('#messages').innerHTML = '';
  addDaySep('Today');
}

function addDaySep(label) {
  const div = document.createElement('div');
  div.className = 'day-sep';
  div.innerHTML = `<span>${label}</span>`;
  $('#messages').appendChild(div);
}

function renderMessages() {
  clearMessages();
  const msgs = S.messages[S.currentRoom] || [];
  if (!msgs.length) {
    const d = document.createElement('div');
    d.className = 'msg-system'; d.textContent = 'No messages yet. Say hello! 👋';
    $('#messages').appendChild(d);
    return;
  }

  // Timestamp grouping
  let lastDate = null;
  msgs.forEach(msg => {
    const dateStr = getDateLabel(msg.timestamp);
    if (dateStr !== lastDate) {
      lastDate = dateStr;
      addDaySep(dateStr);
    }
    $('#messages').appendChild(buildMsgEl(msg));
  });
  scrollBottom();
}

function appendMsg(msg) {
  const dateStr = getDateLabel(msg.timestamp);
  const lastSep = $('#messages').querySelector('.day-sep:last-of-type');
  if (!lastSep || lastSep.textContent.trim() !== dateStr) addDaySep(dateStr);
  $('#messages').appendChild(buildMsgEl(msg));
}

function appendSysMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg-system'; d.textContent = text;
  $('#messages').appendChild(d);
  scrollBottom();
}

function buildMsgEl(msg) {
  const isOwn = msg.sender === S.username;
  const div = document.createElement('div');
  div.className = `msg${isOwn ? ' own' : ''}`;
  div.dataset.mid = msg.id || '';

  // Avatar
  let avHtml = '';
  if (msg.avatar_url) {
    avHtml = `<img src="${esc(msg.avatar_url)}" alt="" onerror="this.style.display='none'"/>`;
  } else {
    avHtml = (msg.sender || '?').charAt(0).toUpperCase();
  }

  // Content
  let contentHtml = '';
  if (msg.msg_type === 'file' && msg.file_info) {
    contentHtml = `<div class="msg-file">
      <span class="msg-file-icon">📎</span>
      <div>
        <div class="msg-file-name">${esc(msg.file_info.name)}</div>
        <div class="msg-file-size">${fmtSize(msg.file_info.size)}</div>
      </div>
    </div>`;
  } else {
    contentHtml = `<div class="msg-text">${esc(msg.message_text || '')}</div>`;
  }

  const receipt = isOwn
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
    <div class="msg-actions">
      ${REACTION_EMOJIS.map(e =>
        `<button class="react-btn" title="${e}"
           onclick="sendReaction(${msg.id},'${e}')">${e}</button>`
      ).join('')}
    </div>`;
  return div;
}

function scrollBottom() {
  const el = $('#messages');
  el.scrollTop = el.scrollHeight;
}


/* ══════════════════════════════════════
   ⑨ SEND MESSAGE
══════════════════════════════════════ */
$('#btn-send')?.addEventListener('click', sendMsg);
$('#inp')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
$('#inp')?.addEventListener('input', () => { autoResize($('#inp')); handleTyping(); });

function sendMsg() {
  const text = $('#inp').value.trim();
  if (!text || !S.currentRoom) return;

  // Animate send button
  $('#btn-send').classList.add('sending');
  setTimeout(() => $('#btn-send').classList.remove('sending'), 350);

  S.socket.emit('send_message', { room: S.currentRoom, text, msg_type: 'text' });
  $('#inp').value = '';
  autoResize($('#inp'));
  stopTyping();
}

function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
}


/* ══════════════════════════════════════
   ⑩ TYPING INDICATOR
══════════════════════════════════════ */
function handleTyping() {
  if (!S.isTyping && S.currentRoom) {
    S.isTyping = true;
    S.socket.emit('typing', { room: S.currentRoom });
  }
  clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(stopTyping, 2000);
}
function stopTyping() {
  if (S.isTyping && S.currentRoom) {
    S.isTyping = false;
    S.socket.emit('stop_typing', { room: S.currentRoom });
  }
}
function showTyping(typers) {
  const row   = $('#typing-row');
  const label = $('#typing-label');
  if (!typers.length) { row.classList.add('hidden'); return; }
  label.textContent = `${typers.join(', ')} ${typers.length===1?'is':'are'} typing…`;
  row.classList.remove('hidden');
}


/* ══════════════════════════════════════
   ⑪ REACTIONS
══════════════════════════════════════ */
const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🔥'];

window.sendReaction = function(messageId, emoji) {
  if (!S.currentRoom) return;
  S.socket.emit('react_message', {
    room: S.currentRoom, message_id: messageId, emoji, action: 'add',
  });
};

function renderReactions(container, reactions, messageId) {
  container.innerHTML = '';
  reactions.forEach(r => {
    const users   = (r.users || '').split(',');
    const isMine  = users.includes(S.username);
    const pill    = document.createElement('div');
    pill.className = `reaction-pill${isMine?' mine':''}`;
    pill.innerHTML = `${r.emoji}<span class="reaction-count">${r.count}</span>`;
    pill.title     = users.join(', ');
    pill.addEventListener('click', () => {
      S.socket.emit('react_message', {
        room: S.currentRoom, message_id: messageId,
        emoji: r.emoji, action: isMine ? 'remove' : 'add',
      });
    });
    container.appendChild(pill);
  });
}


/* ══════════════════════════════════════
   ⑫ NOTIFICATION SOUND (Web Audio API)
══════════════════════════════════════ */
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playNotifSound() {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type            = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .35);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + .35);
  } catch { /* audio not available */ }
}

// Unlock audio context on first user interaction
document.addEventListener('click', () => { getAudioCtx(); }, { once: true });


/* ══════════════════════════════════════
   ⑬ EMOJI PICKER
══════════════════════════════════════ */
const EMOJI_CATS = {
  smileys:  { icon:'😀', emojis:'😀😂🥹😍🤩😎🥳🤔😅🤣😭😱🙄😴😡🥺😏🫡🥰😇🤗😶🫠🤫🤭😬🙃😜😝😛🤪' },
  gestures: { icon:'👋', emojis:'👋✌️🤞👍👎👌🤌🤏🖐️✋👊🤝🙏🤲👐🫶❤️🧡💛💚💙💜🖤🤍' },
  nature:   { icon:'🌿', emojis:'🌿🌸🌺🌻🌹🍀🌈⭐🌟💫✨🔥💧🌊🌍🌙☀️🌤️⛅🌧️❄️🌈🦋🐬🦁🐶🐱' },
  food:     { icon:'🍕', emojis:'🍕🍔🌮🍜🍣🍰🎂🍩🍪🍫🍭🥐🍞🧀🥗🍱🥡🧃☕🍵🧋🍺🥂🍾🎉🎊' },
  symbols:  { icon:'🔥', emojis:'🔥⚡🎯💡🔒🔓📎📌🎵🎶🎮🏆🚀💯🌟⬡✅❌⚠️💬🗓️🔧⚙️🎨📊💻📱' },
};

(function buildEmojiPicker() {
  const cats = $('#ep-cats');
  const grid = $('#ep-grid');

  Object.keys(EMOJI_CATS).forEach(key => {
    const btn = document.createElement('button');
    btn.className = `ep-cat-btn${key === S.emojiCat ? ' active' : ''}`;
    btn.textContent = EMOJI_CATS[key].icon;
    btn.title = key;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ep-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      S.emojiCat = key;
      loadEmojis(key);
    });
    cats.appendChild(btn);
  });

  function loadEmojis(cat) {
    grid.innerHTML = '';
    const emojis = EMOJI_CATS[cat].emojis.split('').filter(c => c.trim());
    emojis.forEach(e => {
      const b = document.createElement('button');
      b.className = 'e-btn'; b.textContent = e;
      b.addEventListener('click', () => {
        const ta = $('#inp'); ta.value += e; ta.focus();
        hide($('#emoji-picker'));
      });
      grid.appendChild(b);
    });
  }
  loadEmojis(S.emojiCat);
})();

$('#btn-emoji')?.addEventListener('click', e => {
  e.stopPropagation();
  toggle($('#emoji-picker'));
});
document.addEventListener('click', e => {
  if (!$('#emoji-picker').contains(e.target) && e.target !== $('#btn-emoji')) {
    hide($('#emoji-picker'));
  }
});


/* ══════════════════════════════════════
   ⑭ FILE SHARING
══════════════════════════════════════ */
$('#btn-attach')?.addEventListener('click', () => $('#file-input').click());
$('#file-input')?.addEventListener('change', () => {
  const file = $('#file-input').files[0];
  if (!file) return;
  S.selectedFile = file;
  $('#file-preview').textContent = `📎 ${file.name}\n${fmtSize(file.size)}`;
  show($('#file-modal'));
  $('#file-input').value = '';
});
$('#btn-close-file')?.addEventListener('click', closeFileModal);
$('#btn-cancel-file')?.addEventListener('click', closeFileModal);
function closeFileModal() { S.selectedFile = null; hide($('#file-modal')); }

$('#btn-confirm-file')?.addEventListener('click', () => {
  if (!S.selectedFile || !S.currentRoom) return;
  S.socket.emit('send_message', {
    room: S.currentRoom, text: '', msg_type: 'file',
    file_info: { name: S.selectedFile.name, size: S.selectedFile.size },
  });
  closeFileModal();
  showToast('File sent 📎');
});


/* ══════════════════════════════════════
   ⑮ MESSAGE SEARCH
══════════════════════════════════════ */
$('#btn-search-msg')?.addEventListener('click', () => toggle($('#search-bar')));
$('#btn-close-search')?.addEventListener('click', () => {
  hide($('#search-bar')); renderMessages();
});
$('#search-input')?.addEventListener('input', () => {
  const q    = $('#search-input').value.toLowerCase().trim();
  const msgs = S.messages[S.currentRoom] || [];
  if (!q) { renderMessages(); return; }
  clearMessages();
  addDaySep(`Results for "${esc(q)}"`);
  const hits = msgs.filter(m => (m.message_text||'').toLowerCase().includes(q));
  if (!hits.length) appendSysMsg('No messages found.');
  else hits.forEach(m => $('#messages').appendChild(buildMsgEl(m)));
});

// Sidebar channel search
$('#sb-search')?.addEventListener('input', () => {
  const q = $('#sb-search').value.toLowerCase();
  document.querySelectorAll('#room-list .sb-item').forEach(li => {
    const nm = li.querySelector('span:last-child')?.textContent.toLowerCase() || '';
    li.style.display = (!q || nm.includes(q)) ? '' : 'none';
  });
});


/* ══════════════════════════════════════
   ⑯ PROFILE MODAL
══════════════════════════════════════ */
$('#btn-profile')?.addEventListener('click', openProfile);
$('#sb-user-card')?.addEventListener('click', openProfile);
$('#btn-close-profile')?.addEventListener('click', () => hide($('#profile-modal')));

async function openProfile() {
  show($('#profile-modal'));
  $('#profile-username').value = S.username || '';
  $('#profile-email').value    = S.email    || '';

  try {
    const res  = await authFetch(`${API}/profile`);
    const data = await res.json();
    $('#profile-bio').value     = data.bio || '';
    $('#profile-av-url').value  = data.avatar_url || '';
    $('#pstat-joined').textContent = data.created_at
      ? new Date(data.created_at).toLocaleDateString() : '—';

    setAvatarEl('profile-avatar-img', 'profile-avatar-init', data.avatar_url, S.username);
  } catch { /* offline */ }
}

$('#profile-av-url')?.addEventListener('input', () => {
  const url = $('#profile-av-url').value.trim();
  setAvatarEl('profile-avatar-img', 'profile-avatar-init', url, S.username);
});

$('#btn-change-av')?.addEventListener('click', () => $('#profile-av-url').focus());

$('#btn-save-profile')?.addEventListener('click', async () => {
  const bio    = $('#profile-bio').value.trim();
  const avatar = $('#profile-av-url').value.trim();
  try {
    await authFetch(`${API}/profile`, {
      method: 'PUT',
      body: JSON.stringify({ bio, avatar_url: avatar }),
    });
    S.avatarUrl = avatar;
    localStorage.setItem('nexchat_avatar', avatar);
    setAvatarEl('sb-avatar', 'sb-avatar-init', avatar, S.username);
    hide($('#profile-modal'));
    showToast('Profile saved! ✅');
  } catch { showToast('Could not save profile.'); }
});


/* ══════════════════════════════════════
   ⑰ MEMBERS PANEL
══════════════════════════════════════ */
$('#btn-members')?.addEventListener('click', () => toggle($('#members-panel')));
$('#btn-close-members')?.addEventListener('click', () => hide($('#members-panel')));

function renderOnline() {
  const count  = S.onlineUsers.size;
  $('#online-count').textContent = count;
  $('#mp-online').textContent    = count;

  // Sidebar mini list
  const list = $('#online-list'); list.innerHTML = '';
  S.onlineUsers.forEach(u => {
    const li = document.createElement('li');
    li.className = 'sb-item';
    li.innerHTML = `<span class="sb-udot"></span>${esc(u)}`;
    list.appendChild(li);
  });

  // Members panel
  const ml = $('#mp-online-list'); ml.innerHTML = '';
  S.onlineUsers.forEach(u => {
    const li = document.createElement('li');
    li.className = 'mp-item';
    li.innerHTML = `<div class="mp-av">${u.charAt(0).toUpperCase()}</div>${esc(u)}
                    <span class="sb-udot" style="margin-left:auto"></span>`;
    ml.appendChild(li);
  });
}


/* ══════════════════════════════════════
   ⑱ MOBILE BOTTOM NAV
══════════════════════════════════════ */
document.querySelectorAll('.bnav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;

    if (view === 'chat') {
      closeSidebar(); hide($('#members-panel'));
    } else if (view === 'channels') {
      $('#sidebar').classList.add('open');
      hide($('#members-panel'));
    } else if (view === 'members') {
      closeSidebar();
      $('#members-panel').classList.remove('hidden');
    } else if (view === 'profile') {
      closeSidebar(); openProfile();
    }
  });
});

$('#btn-menu')?.addEventListener('click', () => $('#sidebar').classList.add('open'));
document.addEventListener('click', e => {
  const sb = $('#sidebar');
  if (sb.classList.contains('open') &&
      !sb.contains(e.target) && e.target !== $('#btn-menu')) {
    closeSidebar();
  }
});
function closeSidebar() { $('#sidebar').classList.remove('open'); }


/* ══════════════════════════════════════
   ⑲ STATS
══════════════════════════════════════ */
async function fetchStats() {
  try {
    const res  = await authFetch(`${API}/stats`);
    const data = await res.json();
    const el   = $('#st-mongo');
    if (data.mongodb?.status === 'connected') {
      el.textContent = 'Active'; el.className = 'dbs-badge green';
    } else {
      el.textContent = 'Offline'; el.className = 'dbs-badge red';
    }
  } catch {}
}


/* ══════════════════════════════════════
   UTILITIES
══════════════════════════════════════ */
function normalizeMsg(raw) {
  return {
    id:           raw.message_id || raw.id || Date.now(),
    sender:       raw.sender || raw.username || 'Unknown',
    avatar_url:   raw.avatar_url || '',
    message_text: raw.message_text || raw.text || '',
    msg_type:     raw.msg_type || 'text',
    file_info:    raw.file_info || null,
    timestamp:    raw.timestamp || new Date().toISOString(),
    status:       raw.status || 'sent',
  };
}

function getDateLabel(ts) {
  if (!ts) return 'Today';
  const d = new Date(ts);
  if (isNaN(d)) return 'Today';
  const today = new Date();
  const diff  = Math.floor((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday:'long', month:'long', day:'numeric' });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return ts.slice(11, 16) || '';
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function setAvatarEl(imgId, initId, url, username) {
  const img  = $(`#${imgId}`);
  const init = $(`#${initId}`);
  if (!img || !init) return;
  if (url) {
    img.src = url;
    img.classList.remove('hidden');
    init.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    init.classList.remove('hidden');
    init.textContent = (username || '?').charAt(0).toUpperCase();
  }
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }
function toggle(el) { el?.classList.toggle('hidden'); }

function authFetch(url, opts={}) {
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type':'application/json',
      'Authorization':`Bearer ${S.token}`,
      ...(opts.headers||{}),
    },
    body: opts.body,
  });
}

let _toastTimer;
function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  clearTimeout(_toastTimer);
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  _toastTimer = setTimeout(() => t.remove(), 3000);
}

function showAuthErr(el, msg) {
  el.textContent = msg; show(el);
  setTimeout(() => hide(el), 5000);
}

function setLoading(sel, on) {
  const btn = $(sel); if (!btn) return;
  btn.disabled = on;
  const span = btn.querySelector('span');
  const arr  = btn.querySelector('.btn-arrow');
  if (span) span.textContent = on ? 'Please wait…' : (sel.includes('login') ? 'Sign In' : 'Create Account');
  if (arr)  arr.style.opacity = on ? '0' : '1';
}


/* ══════════════════════════════════════
   BOOT
══════════════════════════════════════ */
// Handle Google OAuth redirect response
(function handleGoogleRedirect() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return;

    const params = new URLSearchParams(hash.substring(1));
    const accessToken = params.get('access_token');
    if (!accessToken) return;

    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);

    // Get user info from Google
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
    })
    .then(r => r.json())
    .then(async ginfo => {
        const res = await fetch(`${API}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id_token: accessToken, userinfo: ginfo }),
        });
        const data = await res.json();
        if (!res.ok) { showToast('Google login failed: ' + data.error); return; }
        doLogin(data);
        showToast(`Welcome, ${data.username}! 🎉`);
    })
    .catch(() => showToast('Google login failed. Try email login.'));
})();
initSocket();
