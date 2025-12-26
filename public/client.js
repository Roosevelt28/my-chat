const socket = io();

// DOM ელემენტები (null‑ჩეკები)
const messagesEl = document.getElementById('messages');
const form = document.getElementById('msgForm');
const input = document.getElementById('msgInput');
const recipientSelect = document.getElementById('recipientSelect');
const photoInput = document.getElementById('photoInput');

const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const sendAudioBtn = document.getElementById('sendAudioBtn');

const usernameInput = document.getElementById('usernameInput'); // may be null
const setNameBtn = document.getElementById('setNameBtn'); // may be null

const openProfileBtn = document.getElementById('openProfileBtn');
const profileModal = document.getElementById('profileModal');
const profileName = document.getElementById('profileName');
const profileAvatar = document.getElementById('profileAvatar');
const profileInfo = document.getElementById('profileInfo');
const sendPmBtn = document.getElementById('sendPmBtn');
const viewPhotosBtn = document.getElementById('viewPhotosBtn');
const closeProfile = document.getElementById('closeProfile');

const registerModal = document.getElementById('registerModal');
const registerForm = document.getElementById('registerForm');

const loginModal = document.getElementById('loginModal');
const loginForm = document.getElementById('loginForm');
const openLoginBtn = document.getElementById('openLoginBtn');
const openRegisterBtn = document.getElementById('openRegisterBtn');

const openAdminBtn = document.getElementById('openAdminBtn');
const adminModal = document.getElementById('adminModal');
const adminContent = document.getElementById('adminContent');
const closeAdmin = document.getElementById('closeAdmin');

const logoutBtn = document.getElementById('logoutBtn');

const usersListEl = document.getElementById('usersList');
const onlineCountEl = document.getElementById('onlineCount');

let username = localStorage.getItem('chat_username') || 'User' + Math.floor(Math.random()*9000);
let userId = null;
let mediaRecorder = null;
let recordedChunks = [];
let pc = null; // RTCPeerConnection
let localStream = null;
let currentCallTarget = null;

// -----------------------------
// Helpers
// -----------------------------
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// -----------------------------
// Auth check
// -----------------------------
async function checkAuth() {
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const data = await res.json();
    if (!data.user) {
      if (loginModal) loginModal.classList.remove('hidden');
      if (registerModal) registerModal.classList.add('hidden');
    } else {
      if (loginModal) loginModal.classList.add('hidden');
      if (registerModal) registerModal.classList.add('hidden');
      userId = data.user.id;
      username = data.user.username || username;
      if (usernameInput) usernameInput.value = username;
      if (typeof socket !== 'undefined' && socket) socket.emit('identify', { userId, username });
    }
  } catch (err) {
    console.error('checkAuth error', err);
    if (loginModal) loginModal.classList.remove('hidden');
  }
}
checkAuth();

// -----------------------------
// Load public messages
// -----------------------------
async function loadPublic() {
  try {
    const res = await fetch('/api/messages/public', { credentials: 'include' });
    const data = await res.json();
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    (data.messages || []).forEach(m => appendMessage(m));
  } catch (e) {
    console.warn('Failed to load public messages', e);
  }
}
loadPublic();

// -----------------------------
// Socket handlers
// -----------------------------
socket.on('message', msg => appendMessage(msg));
socket.on('privateMessage', msg => appendMessage(msg, true));
socket.on('users', users => {
  if (recipientSelect) recipientSelect.innerHTML = '<option value="">საერთო</option>';
  if (usersListEl) usersListEl.innerHTML = '';
  (users || []).forEach(u => {
    if (recipientSelect) {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = u.username;
      recipientSelect.appendChild(opt);
    }
    if (usersListEl) {
      const div = document.createElement('div');
      div.className = 'user-item';
      div.innerHTML = `<div style="display:flex;align-items:center">
                         <img src="${escapeHtml(u.avatar||'/placeholder.png')}" alt="">
                         <div>${escapeHtml(u.username)}</div>
                       </div>
                       <div><button data-name="${escapeHtml(u.username)}" class="view-profile">პროფილი</button></div>`;
      usersListEl.appendChild(div);
    }
  });
  document.querySelectorAll('.view-profile').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const name = e.currentTarget.getAttribute('data-name');
      openProfile(name);
    });
  });
});
socket.on('typing', data => {
  if (!data || !data.from) return;
  const t = document.getElementById('typing');
  if (!t) return;
  t.textContent = data.private ? `${data.from} წერს (პირადი)...` : `${data.from} წერს...`;
  setTimeout(()=> t.textContent = '', 3000);
});
socket.on('onlineCount', ({ count }) => {
  if (onlineCountEl) onlineCountEl.textContent = count;
});

// WebRTC signaling
socket.on('incoming-call', async ({ from, fromUserId, offer, callType }) => {
  const accept = confirm(`${from} გირეკავს (${callType}). მიიღებთ ზარს?`);
  if (!accept) {
    socket.emit('call-end', { toUsername: from });
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia(callType === 'video' ? { audio: true, video: true } : { audio: true });
  } catch (err) {
    alert('Cannot access microphone/camera');
    socket.emit('call-end', { toUsername: from });
    return;
  }
  pc = createPeerConnection(from);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('call-answer', { toUsername: from, answer: pc.localDescription });
});

socket.on('call-answered', async ({ from, answer }) => {
  if (!pc) return;
  await pc.setRemoteDescription(answer);
});

socket.on('call-candidate', async ({ from, candidate }) => {
  if (!pc) return;
  try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('Failed to add ICE candidate', e); }
});

socket.on('call-ended', ({ from }) => {
  endCall();
  alert(`${from} შეწყვიტა ზარი`);
});

// -----------------------------
// Append message
// -----------------------------
function appendMessage(msg, isPrivate=false) {
  if (!messagesEl) return;
  const el = document.createElement('div');
  const mine = (msg.from_user && userId && msg.from_user === userId) || msg.username === username;
  el.className = 'message ' + (mine ? 'me' : 'other');
  const privateTag = msg.to_user ? `<span style="font-size:11px;color:#ffd700;margin-left:8px">[პირადი]</span>` : '';
  let mediaHtml = '';
  if (msg.media_type === 'image' && msg.media_url) {
    mediaHtml = `<img class="uploaded" src="${escapeHtml(msg.media_url)}" />`;
  } else if (msg.media_type === 'audio' && msg.media_url) {
    mediaHtml = `<audio class="uploaded" controls src="${escapeHtml(msg.media_url)}"></audio>`;
  }
  el.innerHTML = `<div><strong class="username-link" data-name="${escapeHtml(msg.username)}">${escapeHtml(msg.username)}</strong>${privateTag}</div>
                  <div>${escapeHtml(msg.text || '')}</div>
                  ${mediaHtml}
                  <div class="meta">${new Date(msg.ts).toLocaleTimeString()}</div>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const link = el.querySelector('.username-link');
  if (link) {
    link.style.cursor = 'pointer';
    link.addEventListener('click', () => openProfile(link.getAttribute('data-name')));
  }
}

// -----------------------------
// Registration
// -----------------------------
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const first_name = document.getElementById('reg_first')?.value.trim() || '';
    const last_name = document.getElementById('reg_last')?.value.trim() || '';
    const nickname = document.getElementById('reg_nick')?.value.trim() || '';
    const email = document.getElementById('reg_email')?.value.trim() || '';
    const age = document.getElementById('reg_age')?.value.trim() || '';
    const password = document.getElementById('reg_password')?.value || '';
    if (!nickname || !password) return alert('ნიკნეიმი და პაროლი სავალდებულოა');
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        credentials: 'include',
        body: JSON.stringify({ username: nickname, password, first_name, last_name, nickname, email: email || null, age: age || null })
      });
      const data = await res.json();
      if (!data.ok) return alert(data.error || 'Registration failed');
      // avatar upload
      const avatarInput = document.getElementById('reg_avatar');
      if (avatarInput && avatarInput.files && avatarInput.files[0]) {
        const fd = new FormData();
        fd.append('avatar', avatarInput.files[0]);
        const up = await fetch('/api/upload/avatar', { method: 'POST', body: fd, credentials: 'include' });
        const upData = await up.json();
        if (!upData.ok) console.warn('Avatar upload failed', upData);
      }
      if (registerModal) registerModal.classList.add('hidden');
      userId = data.userId || data.user?.id || null;
      username = nickname;
      try { localStorage.setItem('chat_username', username); } catch (e) {}
      if (typeof socket !== 'undefined' && socket) socket.emit('identify', { userId, username });
      alert('რეგისტრაცია წარმატებით დასრულდა');
      if (loginModal) loginModal.classList.add('hidden');
      loadPublic();
    } catch (err) {
      console.error('Register error', err);
      alert('რეგისტრაცია ვერ შესრულდა');
    }
  });
}

// -----------------------------
// Login handlers and toggles
// -----------------------------
if (openLoginBtn && registerModal && loginModal) {
  openLoginBtn.addEventListener('click', () => {
    registerModal.classList.add('hidden');
    loginModal.classList.remove('hidden');
  });
}
if (openRegisterBtn && registerModal && loginModal) {
  openRegisterBtn.addEventListener('click', () => {
    loginModal.classList.add('hidden');
    registerModal.classList.remove('hidden');
  });
}
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const usernameVal = (document.getElementById('login_username')?.value || '').trim();
    const passwordVal = document.getElementById('login_password')?.value || '';
    if (!usernameVal || !passwordVal) return alert('შეავსეთ ყველა ველი');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        credentials: 'include',
        body: JSON.stringify({ username: usernameVal, password: passwordVal })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) return alert(data.error || 'შესვლა ვერ შესრულდა');
      if (loginModal) loginModal.classList.add('hidden');
      if (registerModal) registerModal.classList.add('hidden');
      userId = data.user?.id || data.userId || null;
      username = data.user?.username || usernameVal;
      try { localStorage.setItem('chat_username', username); } catch (e) {}
      if (typeof socket !== 'undefined' && socket) socket.emit('identify', { userId, username });
      loadPublic();
      alert('წარმატებით შეხვდით ✅');
    } catch (err) {
      console.error('Login error', err);
      alert('შეცდომა შესვლისას');
    }
  });
}

// -----------------------------
// Composer submit
// -----------------------------
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = (input?.value || '').trim();
    const to = recipientSelect?.value || '';
    if (photoInput && photoInput.files && photoInput.files[0]) {
      try {
        const url = await uploadPhotoFile(photoInput.files[0], false);
        const media = { type: 'image', url };
        if (to) socket.emit('privateMessage', { toUsername: to, text: text || '', media });
        else socket.emit('chatMessage', { text: text || '', media });
        photoInput.value = '';
        if (input) input.value = '';
        return;
      } catch (err) {
        console.error('Photo upload failed', err);
        return alert(err.message || 'Upload failed');
      }
    }
    if (to) socket.emit('privateMessage', { toUsername: to, text });
    else socket.emit('chatMessage', { text });
    if (input) input.value = '';
    socket.emit('typing', { toUsername: to || null, isTyping: false });
  });
}

// -----------------------------
// Upload helpers
// -----------------------------
async function uploadPhotoFile(file, personal=false) {
  const fd = new FormData();
  fd.append('photo', file);
  const url = '/api/upload/photo' + (personal ? '?personal=1' : '');
  const res = await fetch(url, { method: 'POST', body: fd, credentials: 'include' });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Upload failed');
  return data.url;
}

// -----------------------------
// Audio recording (robust)
// -----------------------------
if (recordBtn && stopBtn && sendAudioBtn) {
  // initial states
  sendAudioBtn.disabled = true;
  stopBtn.disabled = true;
  recordBtn.disabled = false;

  recordBtn.addEventListener('click', async () => {
    recordedChunks = [];
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return alert('ჩაწერა არ არის მხარდაჭერილი თქვენს ბრაუზერში');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream = stream;

      // choose supported mime
      let options = {};
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        options.mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        options.mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        options.mimeType = 'audio/ogg';
      }

      mediaRecorder = new MediaRecorder(stream, options);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        sendAudioBtn.disabled = !(recordedChunks && recordedChunks.length > 0);
        recordBtn.disabled = false;
        stopBtn.disabled = true;
      };

      mediaRecorder.onerror = (ev) => {
        console.error('MediaRecorder error', ev);
        alert('ჩაწერის შეცდომა: ' + (ev.error?.message || ev.type));
      };

      mediaRecorder.start();
      recordBtn.disabled = true;
      stopBtn.disabled = false;
      sendAudioBtn.disabled = true;
    } catch (err) {
      console.error('getUserMedia error', err);
      alert('Cannot access microphone: ' + (err.message || err));
    }
  });

  stopBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
  });

  sendAudioBtn.addEventListener('click', async () => {
    if (!recordedChunks || recordedChunks.length === 0) return alert('ჩაწერა არ არის');

    try {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      if (blob.size < 100) return alert('ჩაწერა ძალიან მცირეა');

      const fd = new FormData();
      fd.append('audio', blob, 'voice.webm');

      sendAudioBtn.disabled = true;
      const prevText = sendAudioBtn.textContent;
      sendAudioBtn.textContent = 'გიგზავნით...';

      const res = await fetch('/api/upload/audio', {
        method: 'POST',
        body: fd,
        credentials: 'include'
      });

      if (!res.ok) {
        console.error('Upload HTTP error', res.status, await res.text());
        sendAudioBtn.disabled = false;
        sendAudioBtn.textContent = prevText;
        return alert('ფაილის ატვირთვა ვერ მოხერხდა (HTTP ' + res.status + ')');
      }

      const data = await res.json();
      if (!data.ok) {
        console.error('Upload response error', data);
        sendAudioBtn.disabled = false;
        sendAudioBtn.textContent = prevText;
        return alert(data.error || 'Upload failed');
      }

      const media = { type: 'audio', url: data.url };
      const to = recipientSelect?.value || '';
      if (to) socket.emit('privateMessage', { toUsername: to, text: '', media });
      else socket.emit('chatMessage', { text: '', media });

      appendMessage({
        username,
        text: '',
        media_type: 'audio',
        media_url: data.url,
        ts: Date.now(),
        from_user: userId || null
      });

      recordedChunks = [];
      sendAudioBtn.disabled = true;
      sendAudioBtn.textContent = prevText;
    } catch (err) {
      console.error('Audio upload error', err);
      sendAudioBtn.disabled = false;
      sendAudioBtn.textContent = 'გაგზავნა (ხმა)';
      alert('ხმის გაგზავნა ვერ მოხერხდა');
    }
  });
}

// -----------------------------
// Typing indicator
// -----------------------------
if (input) {
  input.addEventListener('input', () => {
    const to = recipientSelect?.value || null;
    socket.emit('typing', { toUsername: to, isTyping: (input.value || '').length > 0 });
  });
}

// -----------------------------
// Profile open
// -----------------------------
if (openProfileBtn) {
  openProfileBtn.addEventListener('click', async () => {
    try {
      const meRes = await fetch('/api/me', { credentials: 'include' });
      const me = await meRes.json();
      if (!me.user) {
        if (loginModal) loginModal.classList.remove('hidden');
        else alert('გთხოვთ შეხვიდეთ ან დაარეგისტრირდეთ');
        return;
      }
      openProfile(me.user.username);
    } catch (e) {
      console.error('Open profile error', e);
      alert('პროფილის გახსნა ვერ მოხერხდა');
    }
  });
}

async function openProfile(usernameToOpen) {
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(usernameToOpen)}`, { credentials: 'include' });
    const data = await res.json();
    if (data.error) return alert(data.error);
    if (profileName) profileName.textContent = data.username;
    if (profileAvatar) profileAvatar.src = data.avatar || '/placeholder.png';
    if (profileInfo) profileInfo.innerHTML = `
      <div>სახელი: ${escapeHtml(data.first_name || '')} ${escapeHtml(data.last_name || '')}</div>
      <div>ნიკნეიმი: ${escapeHtml(data.nickname || '')}</div>
      <div>ასაკი: ${escapeHtml(data.age || '')}</div>
    `;
    if (profileModal) profileModal.classList.remove('hidden');

    if (sendPmBtn) sendPmBtn.onclick = () => {
      if (recipientSelect) recipientSelect.value = usernameToOpen;
      if (profileModal) profileModal.classList.add('hidden');
      if (input) input.focus();
    };

    if (viewPhotosBtn) viewPhotosBtn.onclick = async () => {
      try {
        const photosRes = await fetch(`/api/users/${encodeURIComponent(usernameToOpen)}/photos`, { credentials: 'include' });
        const photosData = await photosRes.json();
        if (!photosData.photos || photosData.photos.length === 0) return alert('ფოტოები არ არის');
        const w = window.open('', '_blank');
        if (!w) return;
        w.document.write('<title>Photos</title>');
        photosData.photos.forEach(p => w.document.write(`<img src="${p.url}" style="max-width:100%;display:block;margin:8px 0">`));
      } catch (err) {
        console.error('View photos error', err);
        alert('ფოტოების ნახვა ვერ მოხერხდა');
      }
    };

    const voiceBtn = document.getElementById('voiceCallBtn');
    const videoBtn = document.getElementById('videoCallBtn');
    if (voiceBtn) voiceBtn.onclick = () => startCall(usernameToOpen, 'audio');
    if (videoBtn) videoBtn.onclick = () => startCall(usernameToOpen, 'video');
  } catch (err) {
    console.error('openProfile fetch error', err);
    alert('პროფილის მონაცემები ვერ მოიძებნა');
  }
}

if (closeProfile) closeProfile.addEventListener('click', () => profileModal?.classList.add('hidden'));

// -----------------------------
// Admin
// -----------------------------
if (openAdminBtn) {
  openAdminBtn.addEventListener('click', async () => {
    try {
      const check = await (await fetch('/admin/check', { credentials: 'include' })).json();
      if (!check.isAdmin) {
        const pass = prompt('ადმინის პაროლი');
        if (!pass) return;
        const res = await fetch('/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, credentials: 'include', body: JSON.stringify({ password: pass }) });
        if (!res.ok) return alert('პაროლი არასწორია');
      }
      const usersRes = await fetch('/admin/users', { credentials: 'include' });
      const data = await usersRes.json();
      if (adminContent) {
        adminContent.innerHTML = '<h4>მომხმარებლები</h4>';
        (data.users || []).forEach(u => {
          const d = document.createElement('div');
          d.textContent = `${u.id} — ${u.username} — ${u.email || ''}`;
          adminContent.appendChild(d);
        });
      }
      if (adminModal) adminModal.classList.remove('hidden');
    } catch (err) {
      console.error('Admin error', err);
      alert('ადმინ პანელი ვერ ჩაიტვირთა');
    }
  });
}
if (closeAdmin) closeAdmin.addEventListener('click', () => adminModal?.classList.add('hidden'));

// -----------------------------
// Logout handler
// -----------------------------
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      let data = {};
      try { data = await res.json(); } catch (e) {}

      // client-side cleanup
      userId = null;
      username = 'User' + Math.floor(Math.random()*9000);
      try { localStorage.removeItem('chat_username'); } catch (e) {}

      // disconnect socket without creating a new one
      try {
        if (typeof socket !== 'undefined' && socket && socket.connected) {
          socket.emit('logout');
          socket.disconnect();
        }
      } catch (e) { console.warn('Socket disconnect failed', e); }

      // show login modal or redirect
      if (loginModal) loginModal.classList.remove('hidden');
      else window.location.href = '/auth.html';

      console.log('Logout response', res.status, data);
      alert((data && data.ok) ? 'თქვენ წარმატებით გამოვედით' : 'გასვლა შესრულდა');
    } catch (err) {
      console.error('Logout error', err);
      alert('გასვლა ვერ შესრულდა, შეამოწმეთ კონსოლი');
    }
  });
}

// -----------------------------
// WebRTC helpers
// -----------------------------
function createPeerConnection(targetUsername) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('call-candidate', { toUsername: targetUsername, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    const remoteStream = e.streams[0];
    const w = window.open('', '_blank');
    if (!w) return;
    if (remoteStream.getVideoTracks().length > 0) {
      w.document.write('<video autoplay playsinline controls style="width:100%"></video>');
      const v = w.document.querySelector('video');
      v.srcObject = remoteStream;
    } else {
      w.document.write('<audio autoplay controls style="width:100%"></audio>');
      const a = w.document.querySelector('audio');
      a.srcObject = remoteStream;
    }
  };
  return pc;
}

async function startCall(targetUsername, callType='audio') {
  currentCallTarget = targetUsername;
  try {
    localStream = await navigator.mediaDevices.getUserMedia(callType === 'video' ? { audio: true, video: true } : { audio: true });
  } catch (err) {
    return alert('Cannot access microphone/camera');
  }
  pc = createPeerConnection(targetUsername);
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('call-offer', { toUsername: targetUsername, offer: pc.localDescription, callType });
}

function endCall() {
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  currentCallTarget = null;
}

// Optional: expand input while typing on mobile
(function() {
  const input = document.querySelector('.composer input[type="text"]');
  if (!input) return;

  function isMobile() {
    return window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
  }

  input.addEventListener('focus', () => {
    if (isMobile()) input.classList.add('typing-expanded');
  });
  input.addEventListener('blur', () => {
    input.classList.remove('typing-expanded');
  });

  // Optional: expand when user starts typing (keydown)
  input.addEventListener('input', () => {
    if (isMobile()) input.classList.add('typing-expanded');
  });
})();
