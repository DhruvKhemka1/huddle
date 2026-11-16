// Huddle — peer-to-peer group video calls.
//
// How rooms work
// --------------
// Everyone joins with a random PeerJS id and connects directly to everyone
// else (a full mesh, good for up to about 4–6 people).
//
// To find each other, a room has a "door": the PeerJS id "<PREFIX><room>-door".
// The host holds the door. A newcomer first tries to claim the door; if it is
// free they become the host, otherwise they knock on it and the host replies
// with the list of people in the room, which the newcomer then calls one by one.
//
// The host also hands each newcomer a join number. If the host leaves, the
// person with the lowest join number takes over: they become the host and
// re-open the door so new people can still get in.

// If the browser paired this script with an older cached copy of the page,
// reload once to fetch the matching page rather than break.
if (!document.getElementById('aloneInvite')) {
  let tried = false;
  try { tried = sessionStorage.getItem('huddle-reloaded') === '1'; sessionStorage.setItem('huddle-reloaded', '1'); } catch { tried = true; }
  if (!tried) location.reload();
}

const PREFIX = 'huddle-v2-';
const MAX_FILE = 25 * 1024 * 1024; // largest file you can share in chat
const $ = (id) => document.getElementById(id);

// How browsers find a path to each other.
//
// STUN servers only help two browsers discover a direct route. They carry no
// audio or video.
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

// A TURN relay is the fallback when no direct route exists (strict Wi-Fi,
// many mobile networks). Without one, those calls cannot connect at all.
//
// Calls that can go direct never use the relay.
//
// RELAY_URL is optional: an address that returns extra relay servers and a
// short-lived login, for providers that work that way. Two kinds work:
//   Metered:    https://<appname>.metered.live/api/v1/turn/credentials?apiKey=<key>
//   Cloudflare: the address of the helper in relay/worker.js
const RELAY_URL = '';

// The relay Huddle uses: a Metered TURN credential. This login is public by
// design (it ships in the page), and only grants use of the relay allowance.
// It can be deleted and replaced in the Metered dashboard at any time.
const RELAY_LOGIN = { username: 'c406f75e7f380865a27301cc', credential: 'BGVCdbsm8SQCescO' };
const RELAY_SERVERS = [
  'turn:global.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80?transport=tcp',
  'turn:global.relay.metered.ca:443',
  'turns:global.relay.metered.ca:443?transport=tcp',
].map((urls) => ({ urls, ...RELAY_LOGIN }));

let iceServers = [...STUN, ...RELAY_SERVERS];
async function loadRelay() {
  if (!RELAY_URL) return;
  try {
    const res = await fetch(RELAY_URL, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`relay helper answered ${res.status}`);
    const data = await res.json();
    // Metered answers with a plain list; the Cloudflare helper wraps it.
    const list = Array.isArray(data) ? data : data.iceServers;
    if (Array.isArray(list) && list.length) iceServers = [...STUN, ...RELAY_SERVERS, ...list];
  } catch (err) {
    // Not fatal: direct calls still work.
    console.warn('Relay unavailable, direct calls only:', err);
  }
}
const peerOptions = () => ({ debug: 1, config: { iceServers } });

/* ---------- quality levels ---------- */

// Each person picks a level. It applies in both directions: it limits what
// they send, and everyone else limits what they send to that person.
const VIDEO_LEVELS = {
  high:   { scale: 1, fps: 30, kbps: null, screenKbps: null, screenFps: 15 }, // null = room-size cap
  medium: { scale: 2, fps: 24, kbps: 600,  screenKbps: 900,  screenFps: 10 },
  low:    { scale: 4, fps: 15, kbps: 150,  screenKbps: 350,  screenFps: 5 },
};
const AUDIO_LEVELS = { high: 64000, standard: 32000, low: 16000 }; // bits per second
const RANK = { low: 0, medium: 1, standard: 1, high: 2 };
const lower = (a, b) => (RANK[a] <= RANK[b] ? a : b);
const cleanQ = (q) => ({
  video: VIDEO_LEVELS[q?.video] ? q.video : 'high',
  audio: AUDIO_LEVELS[q?.audio] ? q.audio : 'high',
});

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, val) {
  try { localStorage.setItem(key, val); } catch { /* storage blocked */ }
}

const S = {
  peer: null,         // my connection to everyone in the call
  door: null,         // the room's door, held only while I am the host
  local: null,        // what I send: one video and one audio track, real or placeholder
  blankVideo: null,   // placeholder sent while the camera is off
  silentAudio: null,  // placeholder sent until the mic is first turned on
  camTrack: null,     // the camera, only while it is on
  rawMic: null,       // the microphone track before any filtering
  rawMicNS: null,     // whether rawMic was opened with the browser's noise suppression
  micBusy: false,
  camBusy: false,
  screen: null,       // screen-share stream while sharing
  room: null,
  host: false,
  hostPeerId: null,   // who the host is, as far as I know
  seq: Infinity,      // my join number (the host is 0)
  nextSeq: 1,         // next join number to hand out, while I am the host
  leaving: false,
  stage: 'finding',   // finding -> knocking -> calling, or failed
  failedKnocks: new Set(),
  name: '',
  mic: false,         // everyone joins with mic and camera off
  cam: false,
  q: cleanQ({ video: load('huddle-q-video'), audio: load('huddle-q-audio') }),
  ns: ['off', 'standard', 'strong'].includes(load('huddle-ns')) ? load('huddle-ns') : 'standard',
  peers: new Map(),   // peerId -> { conn, call, name, seq, q, mic, cam, screen, tile, greeted, localMuted, localHidden }
  meters: new Map(),  // tileId -> analyser info for the speaking indicator
  files: new Map(),   // incoming file transfers
  audioCtx: null,
  unread: 0,
  knockRetries: 0,
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

function prettySize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

// The camera-off placeholder. It repaints once a second so that a (black)
// picture keeps flowing: some browsers will not start playing a person at all
// until at least one video frame has arrived from them.
let blankTimer;
function blankVideoTrack() {
  const c = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
  const g = c.getContext('2d');
  let flip = false;
  const paint = () => {
    g.fillStyle = (flip = !flip) ? '#000000' : '#010101';
    g.fillRect(0, 0, c.width, c.height);
  };
  paint();
  clearInterval(blankTimer);
  blankTimer = setInterval(paint, 1000);
  return c.captureStream(2).getVideoTracks()[0];
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

// The "standard" noise filter is the browser's own. "Strong" switches that off
// and runs our own filter instead (see the noise filter section).
const micConstraints = () => ({
  echoCancellation: true,
  autoGainControl: true,
  channelCount: 1,
  noiseSuppression: S.ns === 'standard',
});

// You join with mic and camera off, and nothing is captured: the call starts
// with a blank video track and a silent audio track. The real camera and mic
// are opened only when you switch them on, and swapped in without redialling.
function makeLocalStream() {
  S.blankVideo = blankVideoTrack();
  S.silentAudio = silentAudioTrack();
  S.mic = false;
  S.cam = false;
  return new MediaStream([S.blankVideo, S.silentAudio]);
}

// Opens the microphone (or re-opens it with different settings).
async function openMic() {
  const fresh = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
  const old = S.rawMic;
  S.rawMic = fresh.getAudioTracks()[0];
  S.rawMic.contentHint = 'speech';
  S.rawMicNS = S.ns === 'standard';
  old?.stop();
}

// Builds what we actually send from the raw mic, depending on the noise filter.
async function applyMicPipeline() {
  teardownStrongFilter();
  let out = S.rawMic;
  if (S.ns === 'strong') {
    try {
      out = await buildStrongFilter(S.rawMic);
    } catch (err) {
      console.warn('Strong noise filter failed:', err);
      toast('Strong filter is not available here. Using standard.');
      S.ns = 'standard';
      store('huddle-ns', S.ns);
      paintSettings();
      try { await openMic(); } catch { /* keep the mic we have */ }
      out = S.rawMic;
    }
  }
  setOutgoingAudio(out);
}

// Puts a video track (camera or the blank placeholder) into what we send.
function swapLocalVideo(track) {
  S.local.getVideoTracks().forEach((t) => S.local.removeTrack(t));
  S.local.addTrack(track);
  if (S.screen) return; // the screen share stays on top until it stops
  replaceOutgoingVideo(track);
  const v = selfTile()?.querySelector('video');
  if (v) {
    v.srcObject = null; // some browsers only notice a new track on reassignment
    v.srcObject = S.local;
    v.play().catch(() => {});
  }
}

// What we send to others: the camera, or the screen while sharing.
function outStream() {
  if (!S.screen) return S.local;
  return new MediaStream([S.screen.getVideoTracks()[0], ...S.local.getAudioTracks()]);
}

/* ---------- noise filter ---------- */

// "Strong" runs the microphone through RNNoise, a small neural network that
// removes fans, traffic and keyboard noise. It runs entirely in this browser
// (files in vendor/rnnoise) and adds roughly 10–20 ms to your outgoing audio.
const RNNOISE = 'vendor/rnnoise';
const NS = { ctx: null, wasm: null, moduleLoaded: false, nodes: null };

async function buildStrongFilter(track) {
  if (!NS.ctx) NS.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (NS.ctx.state === 'suspended') await NS.ctx.resume();
  if (!NS.moduleLoaded) {
    await NS.ctx.audioWorklet.addModule(`${RNNOISE}/workletProcessor.js`);
    NS.moduleLoaded = true;
  }
  if (!NS.wasm) {
    const res = await fetch(`${RNNOISE}/rnnoise.wasm`);
    if (!res.ok) throw new Error('noise filter download failed');
    NS.wasm = await res.arrayBuffer();
  }
  const src = NS.ctx.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(NS.ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
    processorOptions: { maxChannels: 1, wasmBinary: NS.wasm },
  });
  const dst = NS.ctx.createMediaStreamDestination();
  src.connect(node).connect(dst);
  NS.nodes = { src, node, dst };
  const out = dst.stream.getAudioTracks()[0];
  out.contentHint = 'speech';
  return out;
}

function teardownStrongFilter() {
  if (!NS.nodes) return;
  try { NS.nodes.node.port.postMessage('destroy'); } catch {}
  try { NS.nodes.src.disconnect(); NS.nodes.node.disconnect(); } catch {}
  NS.nodes.dst.stream.getTracks().forEach((t) => t.stop());
  NS.nodes = null;
}

// Swaps the audio track we send, live, without dropping the call.
function setOutgoingAudio(track) {
  track.enabled = S.mic;
  S.local.getAudioTracks().forEach((t) => S.local.removeTrack(t));
  S.local.addTrack(track);
  for (const e of S.peers.values()) {
    const sender = e.call?.peerConnection?.getSenders().find((s) => s.track && s.track.kind === 'audio');
    sender?.replaceTrack(track).catch(() => {});
  }
  const tile = selfTile();
  if (tile) watchAudio('self', S.local, tile);
}

async function setNoiseFilter(level, quiet = false) {
  S.ns = level;
  store('huddle-ns', level);
  paintSettings();

  // If the mic has never been turned on, the choice simply waits until it is.
  if (S.rawMic) {
    // Re-open the mic if the browser's own filter needs switching on or off.
    if (S.rawMicNS !== (level === 'standard')) {
      try { await openMic(); }
      catch { toast('Could not change the microphone setting'); return; }
    }
    await applyMicPipeline();
  }
  if (!quiet) toast({ off: 'Noise filter off', standard: 'Standard noise filter', strong: 'Strong noise filter on' }[S.ns]);
}

/* ---------- quality ---------- */

// Upload budget per person you send video to, in kbps. Everyone sends to
// everyone, so the cap shrinks as the room grows to keep total upload sane.
function videoCapKbps() {
  const n = Math.max(1, [...S.peers.values()].filter((e) => e.call).length);
  if (S.screen) return n <= 2 ? 2500 : 1500;
  return n === 1 ? 2500 : n === 2 ? 1500 : n === 3 ? 1000 : 700;
}

// Rewrites our session description so the other side may send us better audio:
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

// Applies bitrate caps and priorities to everything we send. For each person
// it uses the lower of my quality level and theirs.
// Only one pass runs at a time. A request that arrives mid-pass triggers one
// more pass afterwards, so the newest settings always win.
let tuning = false, tuneAgain = false;
async function tuneSenders() {
  if (tuning) { tuneAgain = true; return; }
  tuning = true;
  try {
    do { tuneAgain = false; await tuneSendersOnce(); } while (tuneAgain);
  } finally {
    tuning = false;
  }
}

async function tuneSendersOnce() {
  const cap = videoCapKbps();
  for (const e of S.peers.values()) {
    const pc = e.call?.peerConnection;
    if (!pc) continue;
    const theirs = e.q || { video: 'high', audio: 'high' };
    const v = VIDEO_LEVELS[lower(S.q.video, theirs.video)];
    const audioBps = AUDIO_LEVELS[lower(S.q.audio, theirs.audio)];
    for (const s of pc.getSenders()) {
      if (!s.track) continue;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) continue;
      const enc = p.encodings[0];
      if (s.track.kind === 'video') {
        if (S.screen) {
          // Screen share: keep full resolution so text stays sharp.
          enc.maxBitrate = Math.min(v.screenKbps ?? cap, cap) * 1000;
          enc.maxFramerate = v.screenFps;
          enc.scaleResolutionDownBy = 1;
          p.degradationPreference = 'maintain-resolution';
        } else {
          enc.maxBitrate = Math.min(v.kbps ?? cap, cap) * 1000;
          enc.maxFramerate = v.fps;
          enc.scaleResolutionDownBy = v.scale;
          p.degradationPreference = 'balanced';
        }
      } else {
        enc.maxBitrate = audioBps;
        // If the network is tight, audio wins over video.
        enc.priority = 'high';
        enc.networkPriority = 'high';
      }
      try { await s.setParameters(p); } catch { /* not supported; defaults apply */ }
    }
  }
}

function setQuality(kind, level) {
  S.q[kind] = level;
  S.q = cleanQ(S.q);
  store(`huddle-q-${kind}`, S.q[kind]);
  broadcastState();
  tuneSenders();
  paintSettings();
}

function paintSettings() {
  const current = { video: S.q.video, audio: S.q.audio, ns: S.ns };
  document.querySelectorAll('#settings [data-set]').forEach((b) => {
    b.classList.toggle('active', current[b.dataset.set] === b.dataset.val);
  });
}

/* ---------- tiles ---------- */

function addTile(id, stream, name, self = false) {
  const t = document.createElement('div');
  t.className = 'tile' + (self ? ' self' : '');
  t.dataset.id = id;
  t.innerHTML = `
    <video autoplay playsinline></video>
    <div class="avatar"><span></span></div>
    <div class="label"><span class="muted-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/></svg></span><span class="name"></span><span class="host-chip">Host</span><span class="ping"></span><span class="flags"></span></div>`;
  if (!self) {
    const more = document.createElement('button');
    more.className = 'tile-more';
    more.textContent = '⋯';
    more.title = 'Options';
    more.setAttribute('aria-label', 'Options for this person');
    more.onclick = (ev) => { ev.stopPropagation(); toggleTileMenu(id); };
    t.append(more);
  }
  $('grid').append(t);
  setTileStream(id, t, stream, self);
  setTileName(t, name);
  layout();
  return t;
}

function setTileStream(id, tile, stream, self = false) {
  // The <video> only shows the picture and is always silent. A person's sound
  // plays through its own <audio> element, so it never has to wait for video.
  const v = tile.querySelector('video');
  v.muted = true;
  v.srcObject = stream;
  v.play().catch(() => {});
  if (!self) {
    let a = tile.querySelector('audio');
    if (!a) {
      a = document.createElement('audio');
      a.autoplay = true;
      a.setAttribute('playsinline', '');
      tile.append(a);
    }
    a.srcObject = new MediaStream(stream.getAudioTracks());
    playSound(a);
  }
  watchAudio(id, stream, tile);
}

/* ---------- making sure sound actually plays ---------- */

// Browsers, iPhones especially, can refuse to start sound that was not set off
// by a tap. When that happens we ask for one tap, and any tap or key press
// anywhere on the page also starts whatever is waiting.
let soundBlocked = false;
function playSound(a) {
  const p = a.play();
  if (p) p.catch((err) => { if (err?.name === 'NotAllowedError') soundIsBlocked(); });
}
function soundIsBlocked() {
  if (soundBlocked) return;
  soundBlocked = true;
  ask('Your browser is holding the sound until you tap.', 'Turn on sound', unlockSound, true, 'sound');
}
function unlockSound() {
  if (!S.local) return;
  if (S.audioCtx?.state === 'suspended') S.audioCtx.resume().catch(() => {});
  for (const e of S.peers.values()) {
    const a = e.tile?.querySelector('audio');
    if (a && a.paused && a.srcObject) a.play().catch(() => {});
    const v = e.tile?.querySelector('video');
    if (v && v.paused && v.srcObject) v.play().catch(() => {});
  }
  if (soundBlocked) {
    soundBlocked = false;
    if (askKind === 'sound') closeAsk();
  }
}
document.addEventListener('pointerdown', unlockSound, true);
document.addEventListener('keydown', unlockSound, true);

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
  // On a phone, a two-person call shows the other person full size with your
  // own picture small in the corner.
  grid.classList.toggle('duo', n === 2 && window.matchMedia('(max-width: 760px)').matches);
}

function paintSelf() {
  const t = selfTile();
  if (!t) return;
  t.classList.toggle('mic-off', !S.mic);
  t.classList.toggle('cam-off', !S.cam && !S.screen);
  t.classList.toggle('screen', !!S.screen);
  t.classList.toggle('is-host', S.host);
}

function paintPeer(id) {
  const e = S.peers.get(id);
  if (!e || !e.tile) return;
  setTileName(e.tile, e.name);
  e.tile.classList.toggle('mic-off', e.mic === false);
  e.tile.classList.toggle('cam-off', e.cam === false && !e.screen);
  e.tile.classList.toggle('screen', !!e.screen);
  e.tile.classList.toggle('is-host', id === S.hostPeerId);

  // "Just for me" choices. These never leave this browser.
  const v = e.tile.querySelector('video');
  const a = e.tile.querySelector('audio');
  if (a) a.muted = !!e.localMuted;
  v.srcObject?.getVideoTracks().forEach((t) => (t.enabled = !e.localHidden));
  e.tile.classList.toggle('hidden-local', !!e.localHidden);
  e.tile.querySelector('.flags').textContent =
    [e.localMuted && 'muted for you', e.localHidden && 'hidden for you'].filter(Boolean).join(' · ');
}

function paintAll() {
  paintSelf();
  for (const id of S.peers.keys()) paintPeer(id);
}

/* ---------- per-person menu ---------- */

let openMenuFor = null;
function closeTileMenus() {
  document.querySelectorAll('.tile-menu').forEach((m) => m.remove());
  openMenuFor = null;
}

function toggleTileMenu(id) {
  const e = S.peers.get(id);
  if (!e?.tile) return;
  const wasOpen = openMenuFor === id;
  closeTileMenus();
  if (wasOpen) return;
  openMenuFor = id;

  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.onclick = (ev) => ev.stopPropagation();
  const heading = (text) => {
    const h = document.createElement('div');
    h.className = 'tile-menu-head';
    h.textContent = text;
    menu.append(h);
  };
  const item = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = (ev) => { ev.stopPropagation(); closeTileMenus(); fn(); };
    menu.append(b);
  };

  heading('Just for me');
  item(e.localMuted ? 'Unmute for me' : 'Mute for me', () => { e.localMuted = !e.localMuted; paintPeer(id); });
  item(e.localHidden ? 'Show video for me' : 'Hide video for me', () => { e.localHidden = !e.localHidden; paintPeer(id); });

  if (S.host) {
    heading('For everyone (host)');
    if (e.mic === false) item('Ask to unmute', () => hostCommand(id, 'ask-mic'));
    else item('Mute for everyone', () => hostCommand(id, 'mute'));
    if (e.cam === false && !e.screen) item('Ask to start video', () => hostCommand(id, 'ask-cam'));
    else item('Stop video for everyone', () => hostCommand(id, 'stop-cam'));
  }

  // The menu floats above the page so a short tile can't cut it off.
  document.body.append(menu);
  const r = e.tile.querySelector('.tile-more').getBoundingClientRect();
  menu.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
}

/* ---------- host controls ---------- */

// The host can switch someone's mic or camera off, but can only ask for them
// to be switched back on. Nobody's mic or camera is ever turned on remotely.
function hostCommand(id, action) {
  const e = S.peers.get(id);
  if (!S.host || !e) return;
  send(e.conn, { type: 'host', action });
  toast({
    'mute': `Muted ${e.name}`,
    'stop-cam': `Stopped ${e.name}'s video`,
    'ask-mic': `Asked ${e.name} to unmute`,
    'ask-cam': `Asked ${e.name} to start video`,
  }[action]);
}

function onHostCommand(action) {
  switch (action) {
    case 'mute':
      if (S.mic) { setMic(false); toast('The host muted you'); }
      break;
    case 'stop-cam':
      if (S.screen) stopScreen();
      if (S.cam) setCam(false);
      toast('The host stopped your video');
      break;
    case 'ask-mic':
      if (!S.mic) ask('The host is asking you to unmute.', 'Unmute', () => setMic(true));
      break;
    case 'ask-cam':
      if (!S.cam) ask('The host is asking you to start your video.', 'Start video', () => setCam(true));
      break;
  }
}

let askTimer, askKind = '';
function ask(text, yesLabel, onYes, sticky = false, kind = '') {
  askKind = kind;
  $('askText').textContent = text;
  $('askYes').textContent = yesLabel;
  $('askYes').onclick = () => { closeAsk(); onYes(); };
  $('ask').hidden = false;
  clearTimeout(askTimer);
  if (!sticky) askTimer = setTimeout(closeAsk, 20000);
}
function closeAsk() {
  clearTimeout(askTimer);
  askKind = '';
  $('ask').hidden = true;
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

/* ---------- networking: joining ---------- */

const doorId = () => `${PREFIX}${S.room}-door`;

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
  return { mic: S.mic, cam: S.cam, screen: !!S.screen, q: S.q };
}

function connectedIds() {
  return [...S.peers.entries()].filter(([, e]) => e.conn?.open).map(([id]) => id);
}

function startNetwork() {
  const p = new Peer(peerOptions());
  S.peer = p;
  p.on('open', () => {
    p.on('connection', (conn) => setupConn(conn));
    p.on('call', (call) => {
      call.answer(outStream(), CALL_OPTIONS);
      setupCall(call);
    });
    openDoor(false);
  });
  p.on('disconnected', () => {
    // Losing the signaling server doesn't drop live calls; reconnect quietly.
    if (!p.destroyed) p.reconnect();
  });
  p.on('error', (err) => {
    console.warn('PeerJS error:', err.type, err);
    if (err.type === 'peer-unavailable') {
      // Nobody answered the door: the host left a moment ago. Try to take it.
      if (!S.hostPeerId) retryDoor();
    } else if (err.type === 'browser-incompatible') {
      $('status').textContent = 'This browser does not support video calls.';
    } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
      $('status').textContent = 'Connection problem. Retrying…';
    }
  });
}

// Tries to claim the room's door. `takeover` is true when the old host has
// left and I was elected to replace them.
function openDoor(takeover, attempt = 0) {
  if (!S.peer || S.peer.destroyed) return;
  const d = new Peer(doorId(), peerOptions());
  d.on('open', () => {
    if (takeover && !S.host) { d.destroy(); return; } // someone else took over meanwhile
    S.door = d;
    if (!takeover) {
      S.host = true;
      S.hostPeerId = S.peer.id;
      S.seq = 0;
      S.nextSeq = 1;
      paintAll();
      updateStatus();
    }
  });
  d.on('connection', (conn) => {
    // Someone is knocking. Tell them who is here, then they call everyone.
    // If their knock never gets through, say so: it means no direct route
    // exists between us, and it helps to know that on both ends.
    const stuck = setTimeout(() => {
      if (conn.open || S.failedKnocks.has(conn.peer) || S.peers.has(conn.peer)) return;
      S.failedKnocks.add(conn.peer);
      sysMessage('Someone tried to join but could not connect. A network between you is blocking direct calls.');
    }, 12000);
    conn.on('open', () => {
      clearTimeout(stuck);
      conn.send({ type: 'welcome', host: S.peer.id, peers: [S.peer.id, ...connectedIds()], seq: S.nextSeq++ });
    });
  });
  d.on('disconnected', () => { if (!d.destroyed) d.reconnect(); });
  d.on('error', (err) => {
    if (err.type !== 'unavailable-id') { console.warn('Door error:', err.type); return; }
    d.destroy();
    if (takeover) {
      // The old host's door has not been released yet. Try again shortly.
      if (S.host && attempt < 6) setTimeout(() => openDoor(true, attempt + 1), 1500);
    } else {
      knock(); // the room already has a host
    }
  });
}

let knockTimer;
function knock() {
  S.stage = 'knocking';
  updateStatus();
  const c = S.peer.connect(doorId(), { reliable: true });
  clearTimeout(knockTimer);
  knockTimer = setTimeout(() => { if (!S.hostPeerId) { try { c.close(); } catch {} retryDoor(); } }, 7000);
  c.on('data', (d) => {
    if (!d || d.type !== 'welcome' || S.hostPeerId) return;
    clearTimeout(knockTimer);
    S.stage = 'calling';
    S.hostPeerId = String(d.host);
    S.seq = Number(d.seq) || 1;
    (Array.isArray(d.peers) ? d.peers : []).forEach((pid) => connectTo(String(pid)));
    setTimeout(() => { try { c.close(); } catch {} }, 500);
    paintAll();
    updateStatus();
  });
}

function retryDoor() {
  clearTimeout(knockTimer);
  if (S.hostPeerId || S.leaving || !S.peer) return;
  if (S.knockRetries >= 2) return connectionFailed(); // the host is there but unreachable
  S.knockRetries++;
  setTimeout(() => { if (!S.hostPeerId && S.peer && !S.leaving) openDoor(false); }, 1200);
}

// Joining did not work. Say why, instead of showing "Connecting" forever.
function connectionFailed() {
  if (S.leaving || S.stage === 'failed') return;
  S.stage = 'failed';
  updateStatus();
  ask(
    'Could not connect to this room. A network between you and the others is blocking direct calls. Trying from a different Wi-Fi or mobile data often works.',
    'Try again',
    () => { const code = S.room; leave(); enterRoom(code); },
    true,
  );
}

/* ---------- networking: host handover ---------- */

function hostLeft() {
  S.hostPeerId = null;
  // The person with the lowest join number takes over.
  let best = { id: S.peer.id, seq: S.seq };
  for (const [id, e] of S.peers) {
    if (typeof e.seq === 'number' && e.seq < best.seq) best = { id, seq: e.seq };
  }
  if (best.id === S.peer.id) becomeHost();
  else setHost(best.id);
}

function becomeHost() {
  S.host = true;
  S.hostPeerId = S.peer.id;
  const seqs = [S.seq, ...[...S.peers.values()].map((e) => e.seq)].filter(Number.isFinite);
  S.nextSeq = Math.max(0, ...seqs) + 1;
  openDoor(true);
  broadcast({ type: 'host-now' });
  sysMessage('You are now the host');
  paintAll();
  updateStatus();
}

function setHost(id) {
  S.host = false;
  S.hostPeerId = id;
  if (S.door) { S.door.destroy(); S.door = null; }
  const e = S.peers.get(id);
  if (e?.greeted) sysMessage(`${e.name} is now the host`);
  closeTileMenus();
  paintAll();
  updateStatus();
}

// Someone says they are the host now. Believe them if my host is gone, or if
// we both think we are the host and they joined before me.
function onHostClaim(id) {
  if (id === S.hostPeerId) return;
  const e = S.peers.get(id);
  const myHostGone = !S.hostPeerId || (S.hostPeerId !== S.peer.id && !S.peers.has(S.hostPeerId));
  const theyOutrankMe = S.host && typeof e?.seq === 'number' && e.seq < S.seq;
  if (myHostGone || theyOutrankMe) setHost(id);
}

/* ---------- networking: the mesh ---------- */

function connectTo(id) {
  if (!S.peer || id === S.peer.id || S.peers.get(id)?.conn) return;
  const conn = S.peer.connect(id, { reliable: true });
  setupConn(conn);
  const call = S.peer.call(id, outStream(), CALL_OPTIONS);
  if (call) setupCall(call);

  // If nothing has come of it after a while, there is no route to this person.
  setTimeout(() => {
    const e = S.peers.get(id);
    if (!e || e.tile || e.conn?.open || S.leaving) return;
    removePeer(id, true);
    if (!S.host && S.peers.size === 0) connectionFailed();
    else toast('Could not connect to one person in the room');
  }, 15000);
}

function setupConn(conn) {
  const e = entry(conn.peer);
  e.conn = conn;
  conn.on('open', () => {
    send(conn, { type: 'hello', name: S.name, seq: S.seq, ...myState() });
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
    case 'hello': {
      e.name = String(d.name || 'Guest').slice(0, 30);
      if (Number.isFinite(d.seq)) e.seq = d.seq;
      Object.assign(e, { mic: d.mic, cam: d.cam, screen: d.screen, q: cleanQ(d.q) });
      const first = !e.greeted;
      if (first) { e.greeted = true; sysMessage(`${e.name} joined`); }
      paintPeer(id);
      tuneSenders();
      // The host tells everyone who is here, so two people who joined at the
      // same moment still find each other.
      if (first && S.host) broadcast({ type: 'roster', peers: [S.peer.id, ...connectedIds()] });
      break;
    }
    case 'state':
      Object.assign(e, { mic: d.mic, cam: d.cam, screen: d.screen, q: cleanQ(d.q) });
      paintPeer(id);
      tuneSenders();
      break;
    case 'roster':
      if (id !== S.hostPeerId || !Array.isArray(d.peers)) break;
      // Wait a moment, since most of these people are already calling us. For
      // anyone still missing, the one with the smaller id makes the call.
      setTimeout(() => {
        if (!S.peer) return;
        d.peers.map(String).forEach((pid) => {
          if (pid !== S.peer.id && !S.peers.has(pid) && S.peer.id < pid) connectTo(pid);
        });
      }, 4000);
      break;
    case 'host':
      // Only obey the real host.
      if (id === S.hostPeerId) onHostCommand(String(d.action));
      break;
    case 'host-now':
      onHostClaim(id);
      break;
    case 'chat':
      addMessage(e.name, String(d.text || '').slice(0, 2000));
      break;
    case 'react':
      floatEmoji(id, String(d.emoji || '').slice(0, 8));
      break;
    case 'file-start':
    case 'file-chunk':
    case 'file-end':
      onFileMessage(id, e, d);
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
  if (openMenuFor === id) closeTileMenus();
  failFilesFrom(id);
  if (e.greeted && !silent) sysMessage(`${e.name} left`);
  layout();
  updateStatus();
  tuneSenders();
  // Only hand the host role on if we were really connected to the old host.
  if (!S.leaving && id === S.hostPeerId && e.greeted) hostLeft();
}

function updateStatus() {
  const n = [...S.peers.values()].filter((e) => e.tile).length;
  let text;
  if (n > 0) text = `${n + 1} in call`;
  else if (S.host) text = 'Waiting for others';
  else text = {
    knocking: 'Reaching the host…',
    calling: 'Connecting to the others…',
    failed: 'Could not connect.',
  }[S.stage] || 'Finding the room…';
  $('status').textContent = text;
  $('status').classList.toggle('bad', n === 0 && !S.host && S.stage === 'failed');
  // Alone in a room you host: show the invite card.
  $('alone').hidden = !(n === 0 && S.host);
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

/* ---------- controls ---------- */

function broadcastState() {
  broadcast({ type: 'state', ...myState() });
  paintSelf();
  paintControls();
}

function paintControls() {
  // Each label says what pressing the button will do.
  const set = (btn, label, text) => {
    $(label).textContent = text;
    $(btn).title = text;
    $(btn).setAttribute('aria-label', text);
  };
  $('toggleMic').classList.toggle('off', !S.mic);
  set('toggleMic', 'micLabel', S.mic ? 'Mute' : 'Unmute');
  $('toggleCam').classList.toggle('off', !S.cam);
  set('toggleCam', 'camLabel', S.cam ? 'Stop video' : 'Start video');
  $('toggleScreen').classList.toggle('on', !!S.screen);
  set('toggleScreen', 'screenLabel', S.screen ? 'Stop sharing' : 'Share');
}

// Mic: opened the first time you unmute, then kept open and simply silenced
// while muted, so unmuting is instant and doesn't clip your first word.
async function setMic(on) {
  if (S.micBusy || !S.local) return;
  S.micBusy = true;
  try {
    if (on && !S.rawMic) {
      try { await openMic(); }
      catch { toast('Microphone is blocked or missing. Check the browser permission.'); return; }
      if (!S.local) { S.rawMic.stop(); S.rawMic = null; return; } // left while the prompt was open
      S.mic = true;
      await applyMicPipeline();
    } else {
      S.mic = on;
      S.local.getAudioTracks().forEach((t) => (t.enabled = S.mic));
    }
    broadcastState();
  } finally {
    S.micBusy = false;
  }
}
const toggleMic = () => setMic(!S.mic);

// Camera: fully released when off, so the camera light goes out.
async function setCam(on) {
  if (S.camBusy || !S.local) return;
  S.camBusy = true;
  try {
    if (on) {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
        });
      } catch {
        toast('Camera is blocked or missing. Check the browser permission.');
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!S.local) { track.stop(); return; } // left while the prompt was open
      track.contentHint = 'motion';
      track.onended = () => { if (S.camTrack === track) setCam(false); }; // unplugged or revoked
      S.camTrack = track;
      S.cam = true;
      swapLocalVideo(track);
    } else {
      S.cam = false;
      swapLocalVideo(S.blankVideo);
      S.camTrack?.stop();
      S.camTrack = null;
    }
    broadcastState();
    tuneSenders();
  } finally {
    S.camBusy = false;
  }
}
const toggleCam = () => setCam(!S.cam);

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

function chatRow(who) {
  const li = document.createElement('li');
  const w = document.createElement('div');
  w.className = 'who';
  w.textContent = who;
  li.append(w);
  $('messages').append(li);
  return li;
}

function chatArrived(mine) {
  $('messages').scrollTop = $('messages').scrollHeight;
  if (!mine && $('chat').hidden) {
    S.unread++;
    $('unread').textContent = S.unread;
    $('unread').hidden = false;
  }
}

function addMessage(who, text, mine = false) {
  const body = document.createElement('div');
  body.textContent = text;
  chatRow(who).append(body);
  chatArrived(mine);
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
    $('messages').scrollTop = $('messages').scrollHeight;
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

/* ---------- file sharing ---------- */

// Files travel directly between browsers over the same private channel as
// chat. Nothing is uploaded to a server.

const SHOWABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

// A chat row for one file, with a progress line that turns into a download
// link (and a preview, for images) when the transfer finishes.
function addFileRow(who, meta, mine) {
  const li = chatRow(who);
  const box = document.createElement('div');
  box.className = 'file';
  const title = document.createElement('div');
  title.className = 'file-name';
  title.textContent = meta.name;
  const info = document.createElement('div');
  info.className = 'file-info';
  info.textContent = `${prettySize(meta.size)} · ${mine ? 'sending' : 'receiving'} 0%`;
  box.append(title, info);
  li.append(box);
  chatArrived(mine);

  return {
    progress(f) {
      info.textContent = `${prettySize(meta.size)} · ${mine ? 'sending' : 'receiving'} ${Math.round(f * 100)}%`;
    },
    done(blob) {
      const isImage = SHOWABLE_IMAGE.test(meta.mime);
      // Anything that is not a plain image is saved as a download and never
      // opened inside this page.
      const safe = isImage ? blob : new Blob([blob], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(safe);
      if (isImage) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = meta.name;
        img.className = 'file-preview';
        img.onload = () => ($('messages').scrollTop = $('messages').scrollHeight);
        box.prepend(img);
      }
      info.textContent = `${prettySize(meta.size)} · `;
      const a = document.createElement('a');
      a.href = url;
      a.download = meta.name;
      a.textContent = mine ? 'sent' : 'Download';
      if (mine) { a.removeAttribute('href'); a.className = 'plain'; }
      info.append(a);
    },
    fail(reason = 'failed') {
      info.textContent = `${prettySize(meta.size)} · ${reason}`;
      box.classList.add('failed');
    },
  };
}

// Waits until a connection's send queue has room, so a big file doesn't pile
// up in memory or crowd out everything else.
function drained(conn) {
  return new Promise((resolve) => {
    const check = () => {
      const dc = conn.dataChannel;
      if (!conn.open || !dc || dc.readyState !== 'open' || dc.bufferedAmount < 512 * 1024) resolve();
      else setTimeout(check, 30);
    };
    check();
  });
}

async function sendFile(file) {
  if (!file || !file.size) return;
  if (file.size > MAX_FILE) return toast(`Files can be up to ${prettySize(MAX_FILE)}`);
  const meta = {
    id: Math.random().toString(36).slice(2) + Date.now().toString(36),
    name: (file.name || 'file').slice(0, 120),
    size: file.size,
    mime: file.type || 'application/octet-stream',
  };
  toggleChat(true);
  const row = addFileRow('You', meta, true);
  const targets = [...S.peers.values()].filter((e) => e.conn?.open);
  try {
    const buf = await file.arrayBuffer();
    targets.forEach((e) => send(e.conn, { type: 'file-start', ...meta }));
    const CHUNK = 60 * 1024;
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      const data = buf.slice(off, off + CHUNK);
      for (const e of targets) {
        if (!e.conn.open) continue;
        await drained(e.conn);
        send(e.conn, { type: 'file-chunk', id: meta.id, data });
      }
      row.progress(Math.min(1, (off + CHUNK) / buf.byteLength));
    }
    targets.forEach((e) => send(e.conn, { type: 'file-end', id: meta.id }));
    row.done(new Blob([buf], { type: meta.mime }));
  } catch (err) {
    console.warn('File send failed:', err);
    row.fail();
  }
}

function onFileMessage(peerId, e, d) {
  const key = `${peerId}:${String(d.id)}`;
  if (d.type === 'file-start') {
    const size = Number(d.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE || S.files.has(key)) return;
    const meta = {
      name: String(d.name || 'file').replace(/[\\/]/g, '_').slice(0, 120),
      size,
      mime: String(d.mime || '').slice(0, 100),
    };
    S.files.set(key, { peerId, meta, parts: [], got: 0, row: addFileRow(e.name, meta, false) });
    return;
  }
  const f = S.files.get(key);
  if (!f) return;
  if (d.type === 'file-chunk') {
    const part = d.data instanceof ArrayBuffer || ArrayBuffer.isView(d.data) ? d.data : null;
    if (!part) return;
    f.got += part.byteLength;
    if (f.got > f.meta.size) { S.files.delete(key); f.row.fail(); return; } // more than promised
    f.parts.push(part);
    f.row.progress(f.got / f.meta.size);
  } else if (d.type === 'file-end') {
    S.files.delete(key);
    if (f.got !== f.meta.size) return f.row.fail('incomplete');
    f.row.done(new Blob(f.parts, { type: f.meta.mime }));
  }
}

function failFilesFrom(peerId) {
  for (const [key, f] of S.files) {
    if (f.peerId === peerId) { f.row.fail('sender left'); S.files.delete(key); }
  }
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
  S.knockRetries = 0;
  S.leaving = false;
  S.stage = 'finding';
  S.failedKnocks.clear();
  $('landingError').hidden = true;

  // You join with mic and camera off. Nothing is captured until you turn one on.
  S.local = makeLocalStream();
  await loadRelay();

  window.HuddleFx?.stop(); // no landing animation during a call
  $('landing').hidden = true;
  $('room').hidden = false;
  $('roomLabel').textContent = code;
  history.replaceState(null, '', `?room=${encodeURIComponent(code)}`);

  addTile('self', S.local, `${S.name} (you)`, true);
  paintSelf();
  paintControls();
  paintSettings();
  updateStatus();
  startNetwork();
  toast('Your mic and camera are off');
}

function leave() {
  S.leaving = true;
  clearTimeout(knockTimer);
  closeAsk();
  closeTileMenus();
  $('settings').hidden = true;
  stopScreen();
  for (const id of [...S.peers.keys()]) removePeer(id, true);
  S.door?.destroy();
  S.door = null;
  S.peer?.destroy();
  S.peer = null;
  teardownStrongFilter();
  S.rawMic?.stop();
  S.rawMic = null;
  S.rawMicNS = null;
  S.camTrack?.stop();
  S.camTrack = null;
  clearInterval(blankTimer);
  soundBlocked = false;
  S.blankVideo?.stop();
  S.silentAudio?.stop();
  S.local?.getTracks().forEach((t) => t.stop());
  S.local = null;
  S.mic = false;
  S.cam = false;
  S.meters.clear();
  S.files.clear();
  S.host = false;
  S.hostPeerId = null;
  S.seq = Infinity;
  $('grid').innerHTML = '';
  $('messages').innerHTML = '';
  S.unread = 0;
  $('unread').hidden = true;
  $('chat').hidden = true;
  $('room').hidden = true;
  // Back on the homepage you can start a new room again, not only rejoin.
  $('newRoom').hidden = false;
  $('inviteNote').hidden = true;
  $('landing').hidden = false;
  window.HuddleFx?.start();
  history.replaceState(null, '', location.pathname);
}

/* ---------- wiring ---------- */

$('name').value = load('huddle-name') || '';
const linkRoom = new URLSearchParams(location.search).get('room');
if (linkRoom) {
  $('roomCode').value = cleanCode(linkRoom);
  $('newRoom').hidden = true;
  $('inviteNote').hidden = false;
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
$('toggleReact').onclick = (ev) => {
  ev.stopPropagation();
  $('settings').hidden = true;
  $('reactMenu').hidden = !$('reactMenu').hidden;
};
$('reactMenu').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    broadcast({ type: 'react', emoji: b.textContent });
    floatEmoji('self', b.textContent);
    $('reactMenu').hidden = true;
  };
});

// Settings: quality and noise filter
$('toggleSettings').onclick = (ev) => {
  ev.stopPropagation();
  $('reactMenu').hidden = true;
  $('settings').hidden = !$('settings').hidden;
};
$('settings').onclick = (ev) => ev.stopPropagation();
document.querySelectorAll('#settings [data-set]').forEach((b) => {
  b.onclick = () => {
    const { set, val } = b.dataset;
    if (set === 'ns') setNoiseFilter(val);
    else setQuality(set, val);
  };
});

// On a phone this opens the share sheet (WhatsApp, Messages, …); elsewhere it
// copies the link.
async function invite() {
  const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(S.room)}`;
  if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Huddle', text: 'Join my Huddle room', url: link }); return; }
    catch (err) { if (err?.name === 'AbortError') return; /* otherwise fall back to copying */ }
  }
  navigator.clipboard.writeText(link)
    .then(() => toast('Invite link copied'))
    .catch(() => prompt('Copy this invite link:', link));
}
$('copyLink').onclick = invite;
$('aloneInvite').onclick = invite;

$('chatForm').onsubmit = (ev) => {
  ev.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  broadcast({ type: 'chat', text });
  addMessage('You', text, true);
  $('chatInput').value = '';
};

// Files: the attach button, pasting an image, or dropping onto the chat
$('attach').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => {
  [...$('fileInput').files].forEach(sendFile);
  $('fileInput').value = '';
};
$('chatInput').addEventListener('paste', (ev) => {
  const files = [...(ev.clipboardData?.files || [])];
  if (!files.length) return;
  ev.preventDefault();
  files.forEach(sendFile);
});
$('chat').addEventListener('dragover', (ev) => { ev.preventDefault(); $('chat').classList.add('dropping'); });
$('chat').addEventListener('dragleave', () => $('chat').classList.remove('dropping'));
$('chat').addEventListener('drop', (ev) => {
  ev.preventDefault();
  $('chat').classList.remove('dropping');
  [...(ev.dataTransfer?.files || [])].forEach(sendFile);
});

document.addEventListener('keydown', (e) => {
  if ($('room').hidden || e.target.matches('input') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'm' || e.key === 'M') toggleMic();
  if (e.key === 'v' || e.key === 'V') toggleCam();
  if (e.key === 'Escape') { closeTileMenus(); $('settings').hidden = true; $('reactMenu').hidden = true; }
});

document.addEventListener('click', () => {
  closeTileMenus();
  $('settings').hidden = true;
  $('reactMenu').hidden = true;
});
$('askNo').onclick = closeAsk;
window.addEventListener('resize', closeTileMenus);
window.addEventListener('resize', layout);
window.addEventListener('beforeunload', () => { S.door?.destroy(); S.peer?.destroy(); });
