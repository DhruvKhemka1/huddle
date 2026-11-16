// Huddle — peer-to-peer group video calls.
//
// How rooms work: the first person in a room claims the PeerJS id
// "<PREFIX><room>-host". Everyone after that fails to claim it, joins with a
// random id instead, and connects to the host. The host sends each newcomer a
// list of who else is in the room, and the newcomer connects to each of them
// directly. The result is a full mesh where everyone is connected to everyone,
// which works well for up to about 4–6 people.

const PREFIX = 'huddle-v1-';
const $ = (id) => document.getElementById(id);

// Optional: your own STUN/TURN servers. Calls go directly between browsers
// whenever possible. A TURN relay is only the fallback for strict networks, so
// if you add one, pick a region close to the callers (e.g. Mumbai) or relayed
// calls will take a long detour. Leave null to use the PeerJS defaults.
// Example: [{ urls: 'stun:stun.l.google.com:19302' },
//           { urls: 'turn:your.turn.host:3478', username: '…', credential: '…' }]
const ICE_SERVERS = null;
const peerOptions = () => ({ debug: 1, ...(ICE_SERVERS ? { config: { iceServers: ICE_SERVERS } } : {}) });

// Upload budget per person you send video to, in kbps. Everyone sends to
// everyone, so the cap shrinks as the room grows to keep total upload sane.
function videoCapKbps() {
  const n = Math.max(1, [...S.peers.values()].filter((e) => e.call).length);
  if (S.screen) return n <= 2 ? 2500 : 1500;
  return n === 1 ? 2500 : n === 2 ? 1500 : n === 3 ? 1000 : 700;
}

// Rewrites our session description so the other side sends us better audio:
// Opus at up to 64 kbps (browsers default to about half that) with forward
// error correction, so lost packets can be rebuilt instead of turning into
// glitches.
function tuneSdp(sdp) {
  const lines = sdp.split('\r\n');
  const opus = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (opus) {
    const pt = opus[1];
    const i = lines.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (i >= 0) {
      if (!/maxaveragebitrate/.test(lines[i])) lines[i] += ';maxaveragebitrate=64000';
      if (!/useinbandfec/.test(lines[i])) lines[i] += ';useinbandfec=1';
    } else {
      const r = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      lines.splice(r + 1, 0, `a=fmtp:${pt} maxaveragebitrate=64000;useinbandfec=1`);
    }
  }
  return lines.join('\r\n');
}
const CALL_OPTIONS = { sdpTransform: tuneSdp };

// Applies bitrate caps and priorities to everything we send.
async function tuneSenders() {
  const cap = videoCapKbps() * 1000;
  for (const e of S.peers.values()) {
    const pc = e.call?.peerConnection;
    if (!pc) continue;
    for (const s of pc.getSenders()) {
      if (!s.track) continue;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) continue;
      if (s.track.kind === 'video') {
        p.encodings[0].maxBitrate = cap;
        p.encodings[0].maxFramerate = S.screen ? 15 : 30;
        // Screen share: keep text sharp. Camera: let the browser balance.
        p.degradationPreference = S.screen ? 'maintain-resolution' : 'balanced';
      } else {
        // If the network is tight, audio wins over video.
        p.encodings[0].priority = 'high';
        p.encodings[0].networkPriority = 'high';
      }
      try { await s.setParameters(p); } catch { /* not supported; defaults apply */ }
    }
  }
}

const S = {
  peer: null,
  local: null,        // camera + mic stream
  screen: null,       // screen-share stream while sharing
  room: null,
  host: false,
  name: '',
  mic: true,
  cam: true,
  hasMic: false,
  hasCam: false,
  peers: new Map(),   // peerId -> { conn, call, name, mic, cam, screen, tile, greeted }
  meters: new Map(),  // tileId -> analyser info for the speaking indicator
  audioCtx: null,
  unread: 0,
  hostRetries: 0,
};

/* ---------- helpers ---------- */

function makeCode() {
  const a = 'abcdefghjkmnpqrstuvwxyz';
  const part = (n) => Array.from({ length: n }, () => a[Math.floor(Math.random() * a.length)]).join('');
  return `${part(3)}-${part(4)}-${part(3)}`;
}

function cleanCode(raw) {
  let c = raw.trim();
  try { c = new URL(c).searchParams.get('room') || c; } catch { /* not a URL */ }
  return c.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

function store(key, val) {
  try { localStorage.setItem(key, val); } catch { /* storage blocked */ }
}
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2500);
}

function audio() {
  if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
  return S.audioCtx;
}

/* ---------- media ---------- */

function blankVideoTrack() {
  const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  return c.captureStream(1).getVideoTracks()[0];
}

function silentAudioTrack() {
  const ctx = audio();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const dst = ctx.createMediaStreamDestination();
  gain.gain.value = 0;
  osc.connect(gain).connect(dst);
  osc.start();
  return dst.stream.getAudioTracks()[0];
}

async function getMedia() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    stream.getVideoTracks().forEach((t) => (t.contentHint = 'motion'));
    stream.getAudioTracks().forEach((t) => (t.contentHint = 'speech'));
  } catch {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { stream = new MediaStream(); }
  }
  S.hasCam = stream.getVideoTracks().length > 0;
  S.hasMic = stream.getAudioTracks().length > 0;
  // Every call needs one audio and one video track, so fill gaps with placeholders.
  if (!S.hasCam) stream.addTrack(blankVideoTrack());
  if (!S.hasMic) stream.addTrack(silentAudioTrack());
  S.cam = S.hasCam;
  S.mic = S.hasMic;
  return stream;
}

// What we send to others: the camera, or the screen while sharing.
function outStream() {
  if (!S.screen) return S.local;
  return new MediaStream([S.screen.getVideoTracks()[0], ...S.local.getAudioTracks()]);
}

/* ---------- tiles ---------- */

function addTile(id, stream, name, self = false) {
  const t = document.createElement('div');
  t.className = 'tile' + (self ? ' self' : '');
  t.dataset.id = id;
  t.innerHTML = `
    <video autoplay playsinline></video>
    <div class="avatar"><span></span></div>
    <div class="label"><span class="muted-icon">🔇</span><span class="name"></span><span class="ping"></span></div>`;
  $('grid').append(t);
  setTileStream(id, t, stream, self);
  setTileName(t, name);
  layout();
  return t;
}

function setTileStream(id, tile, stream, self = false) {
  const v = tile.querySelector('video');
  v.muted = self; // never play your own audio back
  v.srcObject = stream;
  v.play().catch(() => {});
  watchAudio(id, stream, tile);
}

function setTileName(tile, name) {
  tile.querySelector('.name').textContent = name;
  tile.querySelector('.avatar span').textContent = (name.trim()[0] || '?').toUpperCase();
}

function selfTile() {
  return $('grid').querySelector('.tile.self');
}

function layout() {
  const grid = $('grid');
  const n = grid.children.length;
  const wide = grid.clientWidth > grid.clientHeight * 1.2;
  let cols = Math.ceil(Math.sqrt(n));
  if (n === 2) cols = wide ? 2 : 1;
  grid.style.setProperty('--cols', Math.max(cols, 1));
}

function paintSelf() {
  const t = selfTile();
  if (!t) return;
  t.classList.toggle('mic-off', !S.mic);
  t.classList.toggle('cam-off', !S.cam && !S.screen);
  t.classList.toggle('screen', !!S.screen);
}

function paintPeer(id) {
  const e = S.peers.get(id);
  if (!e || !e.tile) return;
  setTileName(e.tile, e.name);
  e.tile.classList.toggle('mic-off', e.mic === false);
  e.tile.classList.toggle('cam-off', e.cam === false && !e.screen);
  e.tile.classList.toggle('screen', !!e.screen);
}

/* ---------- speaking indicator ---------- */

function watchAudio(id, stream, tile) {
  S.meters.delete(id);
  if (!stream.getAudioTracks().length) return;
  try {
    const ctx = audio();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    S.meters.set(id, { an, tile, buf: new Uint8Array(an.fftSize), level: 0 });
  } catch { /* metering is optional */ }
}

function meterLoop() {
  for (const [id, m] of S.meters) {
    m.an.getByteTimeDomainData(m.buf);
    let sum = 0;
    for (const v of m.buf) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / m.buf.length);
    m.level = Math.max(rms, m.level * 0.85);
    const muted = id === 'self' ? !S.mic : S.peers.get(id)?.mic === false;
    m.tile.classList.toggle('speaking', !muted && m.level > 0.04);
  }
  requestAnimationFrame(meterLoop);
}
requestAnimationFrame(meterLoop);

/* ---------- networking ---------- */

const hostId = () => `${PREFIX}${S.room}-host`;

function entry(id) {
  if (!S.peers.has(id)) S.peers.set(id, { name: 'Guest' });
  return S.peers.get(id);
}

function send(conn, msg) {
  if (conn && conn.open) conn.send(msg);
}

function broadcast(msg) {
  for (const e of S.peers.values()) send(e.conn, msg);
}

function myState() {
  return { mic: S.mic, cam: S.cam, screen: !!S.screen };
}

function startAsHost() {
  const p = new Peer(hostId(), peerOptions());
  S.peer = p;
  p.on('open', () => {
    S.host = true;
    wire(p);
    updateStatus();
  });
  p.on('error', (err) => {
    if (err.type === 'unavailable-id' && !S.host) {
      // Someone already hosts this room, so join as a guest.
      p.destroy();
      startAsGuest();
    } else {
      onPeerError(err);
    }
  });
}

function startAsGuest() {
  const p = new Peer(peerOptions());
  S.peer = p;
  S.host = false;
  p.on('open', () => {
    wire(p);
    connectTo(hostId());
  });
  p.on('error', onPeerError);
}

function wire(p) {
  p.on('connection', (conn) => setupConn(conn));
  p.on('call', (call) => {
    call.answer(outStream(), CALL_OPTIONS);
    setupCall(call);
  });
  p.on('disconnected', () => {
    // Losing the signaling server doesn't drop live calls; reconnect quietly.
    if (!p.destroyed) p.reconnect();
  });
}

function onPeerError(err) {
  console.warn('PeerJS error:', err.type, err);
  if (err.type === 'peer-unavailable') {
    // The host left before we connected. Try to become the host ourselves.
    if (!S.host && S.peers.size <= 1 && S.hostRetries < 2) {
      S.hostRetries++;
      for (const id of [...S.peers.keys()]) removePeer(id, true);
      S.peer.destroy();
      startAsHost();
    }
    return;
  }
  if (err.type === 'browser-incompatible') {
    $('status').textContent = 'This browser does not support video calls.';
  } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
    $('status').textContent = 'Connection problem. Retrying…';
  }
}

function connectTo(id) {
  if (id === S.peer.id || S.peers.get(id)?.conn) return;
  const conn = S.peer.connect(id, { reliable: true });
  setupConn(conn);
  const call = S.peer.call(id, outStream(), CALL_OPTIONS);
  if (call) setupCall(call);
}

function setupConn(conn) {
  const e = entry(conn.peer);
  e.conn = conn;
  conn.on('open', () => {
    send(conn, { type: 'hello', name: S.name, ...myState() });
    if (S.host) {
      const others = [...S.peers.entries()]
        .filter(([id, p]) => id !== conn.peer && p.conn?.open)
        .map(([id]) => id);
      send(conn, { type: 'roster', peers: others });
    }
  });
  conn.on('data', (d) => onData(conn.peer, d));
  conn.on('close', () => removePeer(conn.peer));
  conn.on('error', () => removePeer(conn.peer));
}

function setupCall(call) {
  const e = entry(call.peer);
  e.call = call;
  call.on('stream', (stream) => {
    if (!S.peers.has(call.peer)) return;
    if (e.tile) setTileStream(call.peer, e.tile, stream);
    else e.tile = addTile(call.peer, stream, e.name);
    paintPeer(call.peer);
    updateStatus();
    tuneSenders();
  });
  call.on('close', () => removePeer(call.peer));
  call.on('error', () => removePeer(call.peer));
}

function onData(id, d) {
  const e = S.peers.get(id);
  if (!e || !d || typeof d !== 'object') return;
  switch (d.type) {
    case 'hello':
      e.name = String(d.name || 'Guest').slice(0, 30);
      Object.assign(e, { mic: d.mic, cam: d.cam, screen: d.screen });
      if (!e.greeted) { e.greeted = true; sysMessage(`${e.name} joined`); }
      paintPeer(id);
      break;
    case 'state':
      Object.assign(e, { mic: d.mic, cam: d.cam, screen: d.screen });
      paintPeer(id);
      break;
    case 'roster':
      if (Array.isArray(d.peers)) d.peers.forEach((pid) => connectTo(String(pid)));
      break;
    case 'chat':
      addMessage(e.name, String(d.text || '').slice(0, 2000));
      break;
    case 'react':
      floatEmoji(id, String(d.emoji || '').slice(0, 8));
      break;
  }
}

function removePeer(id, silent = false) {
  const e = S.peers.get(id);
  if (!e) return;
  S.peers.delete(id);
  S.meters.delete(id);
  try { e.conn?.close(); } catch {}
  try { e.call?.close(); } catch {}
  e.tile?.remove();
  if (e.greeted && !silent) sysMessage(`${e.name} left`);
  layout();
  updateStatus();
  tuneSenders();
}

/* ---------- live latency readout ---------- */

// Shows the round-trip time to each person on their tile, so you can see how
// good the connection really is. "relayed" means the call could not go direct.
async function pollStats() {
  for (const e of S.peers.values()) {
    const pc = e.call?.peerConnection;
    if (!pc || !e.tile) continue;
    try {
      const stats = await pc.getStats();
      let pair;
      stats.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r;
      });
      if (!pair || pair.currentRoundTripTime == null) continue;
      const ms = Math.round(pair.currentRoundTripTime * 1000);
      const relayed = [pair.localCandidateId, pair.remoteCandidateId]
        .some((cid) => stats.get(cid)?.candidateType === 'relay');
      const el = e.tile.querySelector('.ping');
      el.textContent = `${ms} ms${relayed ? ' · relayed' : ''}`;
      el.dataset.q = ms < 150 ? 'good' : ms < 300 ? 'ok' : 'bad';
    } catch { /* stats are optional */ }
  }
}
setInterval(pollStats, 2000);

function updateStatus() {
  const n = [...S.peers.values()].filter((e) => e.tile).length;
  $('status').textContent =
    n > 0 ? `${n + 1} in call` : S.host ? 'Waiting for others. Share the invite link.' : 'Connecting…';
}

/* ---------- controls ---------- */

function broadcastState() {
  broadcast({ type: 'state', ...myState() });
  paintSelf();
  paintControls();
}

function paintControls() {
  $('toggleMic').classList.toggle('off', !S.mic);
  $('toggleMic').textContent = S.mic ? '🎙️' : '🔇';
  $('toggleCam').classList.toggle('off', !S.cam);
  $('toggleScreen').classList.toggle('on', !!S.screen);
}

function toggleMic() {
  if (!S.hasMic) return toast('No microphone found');
  S.mic = !S.mic;
  S.local.getAudioTracks().forEach((t) => (t.enabled = S.mic));
  broadcastState();
}

function toggleCam() {
  if (!S.hasCam) return toast('No camera found');
  S.cam = !S.cam;
  S.local.getVideoTracks().forEach((t) => (t.enabled = S.cam));
  broadcastState();
}

function replaceOutgoingVideo(track) {
  for (const e of S.peers.values()) {
    const pc = e.call?.peerConnection;
    const sender = pc?.getSenders().find((s) => s.track && s.track.kind === 'video');
    sender?.replaceTrack(track).catch(() => {});
  }
}

async function toggleScreen() {
  if (S.screen) return stopScreen();
  if (!navigator.mediaDevices.getDisplayMedia) return toast('Screen sharing is not supported here');
  try {
    S.screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: false,
    });
  } catch {
    return; // user cancelled the picker
  }
  const track = S.screen.getVideoTracks()[0];
  track.contentHint = 'detail'; // favour sharp text over smooth motion
  track.onended = stopScreen;
  replaceOutgoingVideo(track);
  selfTile().querySelector('video').srcObject = S.screen;
  broadcastState();
  tuneSenders();
}

function stopScreen() {
  if (!S.screen) return;
  S.screen.getTracks().forEach((t) => t.stop());
  S.screen = null;
  replaceOutgoingVideo(S.local.getVideoTracks()[0]);
  selfTile().querySelector('video').srcObject = S.local;
  broadcastState();
  tuneSenders();
}

/* ---------- chat & reactions ---------- */

function addMessage(who, text, mine = false) {
  const li = document.createElement('li');
  const w = document.createElement('div');
  w.className = 'who';
  w.textContent = who;
  const body = document.createElement('div');
  body.textContent = text;
  li.append(w, body);
  $('messages').append(li);
  $('messages').scrollTop = $('messages').scrollHeight;
  if (!mine && $('chat').hidden) {
    S.unread++;
    $('unread').textContent = S.unread;
    $('unread').hidden = false;
  }
}

function sysMessage(text) {
  const li = document.createElement('li');
  li.className = 'sys';
  li.textContent = text;
  $('messages').append(li);
  $('messages').scrollTop = $('messages').scrollHeight;
  toast(text);
}

function toggleChat(force) {
  const chat = $('chat');
  chat.hidden = force === undefined ? !chat.hidden : !force;
  if (!chat.hidden) {
    S.unread = 0;
    $('unread').hidden = true;
    $('chatInput').focus();
  }
  layout();
}

function floatEmoji(id, emoji) {
  const tile = id === 'self' ? selfTile() : S.peers.get(id)?.tile;
  if (!tile || !emoji) return;
  const f = document.createElement('span');
  f.className = 'floater';
  f.textContent = emoji;
  f.style.left = `${10 + Math.random() * 70}%`;
  tile.append(f);
  setTimeout(() => f.remove(), 2300);
}

/* ---------- enter / leave ---------- */

async function enterRoom(code) {
  if (!code) {
    $('landingError').textContent = 'Enter a room code.';
    $('landingError').hidden = false;
    return;
  }
  if (!window.Peer) {
    $('landingError').textContent = 'Could not load the calling library. Check your connection.';
    $('landingError').hidden = false;
    return;
  }
  S.name = $('name').value.trim().slice(0, 30) || 'Guest';
  store('huddle-name', S.name);
  S.room = code;
  S.hostRetries = 0;
  $('landingError').hidden = true;

  S.local = await getMedia();
  if (!S.hasCam && !S.hasMic) toast('No camera or mic access. You can still watch and chat.');

  $('landing').hidden = true;
  $('room').hidden = false;
  $('roomLabel').textContent = code;
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);

  addTile('self', S.local, `${S.name} (you)`, true);
  paintSelf();
  paintControls();
  updateStatus();
  startAsHost();
}

function leave() {
  stopScreen();
  for (const id of [...S.peers.keys()]) removePeer(id, true);
  S.peer?.destroy();
  S.peer = null;
  S.local?.getTracks().forEach((t) => t.stop());
  S.local = null;
  S.meters.clear();
  S.host = false;
  $('grid').innerHTML = '';
  $('messages').innerHTML = '';
  S.unread = 0;
  $('unread').hidden = true;
  $('chat').hidden = true;
  $('room').hidden = true;
  $('landing').hidden = false;
  history.replaceState(null, '', location.pathname);
}

/* ---------- wiring ---------- */

$('name').value = load('huddle-name') || '';
const linkRoom = new URLSearchParams(location.search).get('room');
if (linkRoom) {
  $('roomCode').value = cleanCode(linkRoom);
  $('newRoom').hidden = true;
  document.querySelector('.divider span').textContent = 'you were invited to';
}
$('name').focus();

$('newRoom').onclick = () => enterRoom(makeCode());
$('joinRoom').onclick = () => enterRoom(cleanCode($('roomCode').value));
$('roomCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinRoom').click());
$('name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (linkRoom ? $('joinRoom') : $('newRoom')).click();
});

$('toggleMic').onclick = toggleMic;
$('toggleCam').onclick = toggleCam;
$('toggleScreen').onclick = toggleScreen;
$('toggleChat').onclick = () => toggleChat();
$('closeChat').onclick = () => toggleChat(false);
$('leave').onclick = leave;
$('toggleReact').onclick = () => ($('reactMenu').hidden = !$('reactMenu').hidden);
$('reactMenu').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    broadcast({ type: 'react', emoji: b.textContent });
    floatEmoji('self', b.textContent);
    $('reactMenu').hidden = true;
  };
});

$('copyLink').onclick = () => {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(S.room)}`;
  navigator.clipboard.writeText(link)
    .then(() => toast('Invite link copied'))
    .catch(() => prompt('Copy this invite link:', link));
};

$('chatForm').onsubmit = (ev) => {
  ev.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  broadcast({ type: 'chat', text });
  addMessage('You', text, true);
  $('chatInput').value = '';
};

document.addEventListener('keydown', (e) => {
  if ($('room').hidden || e.target.matches('input') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'm' || e.key === 'M') toggleMic();
  if (e.key === 'v' || e.key === 'V') toggleCam();
});

window.addEventListener('resize', layout);
window.addEventListener('beforeunload', () => S.peer?.destroy());
