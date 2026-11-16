// Homepage artwork: one swarm of particles that lives behind the whole page.
//
//   - At the top it forms a turning ring of people with a line between every
//     pair (how a Huddle call is wired), with bright packets running the lines.
//   - As you scroll into the About section the same particles burst apart and
//     re-form into a new shape for each part: two linked browsers, a padlock,
//     a wall of call tiles, and finally the Huddle mark.
//   - Particles part around the pointer, clicks send out a shockwave, links
//     throw sparks, and dust drifts over everything.
//
// All text on the page stays ordinary text. The animation only runs while the
// homepage is visible: app.js calls HuddleFx.stop() the moment a call starts,
// so none of this competes with audio or video.

(() => {
  const rand = (a, b) => a + Math.random() * (b - a);
  const TAU = Math.PI * 2;

  // Dotted sphere behind the initial on camera-off tiles (drawn once).
  (function stippleAvatar() {
    const size = 264;
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    const r = size / 2 - 4;
    const light = [-0.45, -0.55, 0.7];
    for (let i = 0; i < 5200; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * TAU;
      const s = Math.sqrt(1 - u * u);
      const n = [s * Math.cos(t), u, Math.abs(s * Math.sin(t))];
      const lit = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      if (Math.random() > 0.12 + lit * 0.88) continue;
      g.globalAlpha = 0.25 + lit * 0.6;
      g.fillRect(size / 2 + n[0] * r, size / 2 + n[1] * r, 1.5, 1.5);
    }
    try { document.documentElement.style.setProperty('--stipple', `url(${c.toDataURL()})`); } catch { /* plain avatar */ }
  })();

  const landing = document.getElementById('landing');
  const canvas = document.getElementById('fx');
  const space = document.getElementById('fxSpace');
  if (!landing || !canvas || !space) return;
  const ctx = canvas.getContext('2d');

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Phones and low-power machines get about half the particles.
  const lite = window.innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4;
  const N = lite ? 3800 : 7600;

  /* ----- drawing: particles are grouped by colour and brightness, so each
           group is painted in one go instead of one call per particle ----- */

  const COLORS = ['#ffffff', '#7ee2a8'];
  const LEVELS = 8;
  const buckets = COLORS.map((_, c) => Array.from({ length: LEVELS }, () => new Float32Array((c ? 2500 : N + 3000) * 3)));
  const fill = COLORS.map(() => new Int32Array(LEVELS));
  let vw = 0, vh = 0, dpr = 1;

  function put(c, x, y, s, a) {
    if (a <= 0.04 || x < -8 || y < -8 || x > vw + 8 || y > vh + 8) return;
    const lv = a >= 1 ? LEVELS - 1 : (a * LEVELS) | 0;
    const arr = buckets[c][lv];
    const i = fill[c][lv];
    if (i + 3 > arr.length) return;
    arr[i] = x; arr[i + 1] = y; arr[i + 2] = s;
    fill[c][lv] = i + 3;
  }

  function flush() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let c = 0; c < COLORS.length; c++) {
      ctx.fillStyle = COLORS[c];
      for (let lv = 0; lv < LEVELS; lv++) {
        const n = fill[c][lv];
        if (!n) continue;
        const arr = buckets[c][lv];
        ctx.globalAlpha = (lv + 1) / LEVELS;
        ctx.beginPath();
        for (let i = 0; i < n; i += 3) {
          const s = arr[i + 2] * dpr;
          ctx.rect(arr[i] * dpr, arr[i + 1] * dpr, s, s);
        }
        ctx.fill();
        fill[c][lv] = 0;
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ----- shapes: each is the same N particles arranged a different way ----- */

  // Samplers. Each returns one random point [x, y, z, brightness] on a primitive.
  // Screen "up" is negative y.
  const onSphere = (c, r) => () => {
    const u = Math.random() * 2 - 1, t = Math.random() * TAU, s = Math.sqrt(1 - u * u);
    return [c[0] + r * s * Math.cos(t), c[1] + r * u, c[2] + r * s * Math.sin(t), rand(0.35, 1)];
  };
  const onLine = (a, b, j = 0.016) => () => {
    const t = Math.random();
    return [a[0] + (b[0] - a[0]) * t + rand(-j, j), a[1] + (b[1] - a[1]) * t + rand(-j, j), a[2] + (b[2] - a[2]) * t + rand(-j, j), rand(0.3, 0.85)];
  };
  const onHalo = (c, r) => () => {
    const t = Math.random() * TAU, rr = r + rand(-0.012, 0.012);
    return [c[0] + rr * Math.cos(t), c[1] + rand(-0.01, 0.01), c[2] + rr * Math.sin(t), rand(0.4, 0.95)];
  };
  const inCloud = (rx, ry) => () => [rand(-1, 1) * rand(0, rx), rand(-1, 1) * rand(0, ry), rand(-1, 1) * rand(0, rx), rand(0.15, 0.5)];
  const speck = () => [rand(-2.3, 2.3), rand(-1.5, 1.5), rand(-2.3, 2.3), rand(0.08, 0.3)];
  // The surface of a box.
  const onBox = (c, w, h, d) => () => {
    const areas = [w * h, w * h, w * d, w * d, h * d, h * d];
    let pick = Math.random() * (2 * (w * h + w * d + h * d)), f = 0;
    while (f < 5 && pick > areas[f]) pick -= areas[f++];
    const u = rand(-0.5, 0.5), v = rand(-0.5, 0.5);
    const p = f < 2 ? [u * w, v * h, (f ? 0.5 : -0.5) * d] : f < 4 ? [u * w, (f === 3 ? 0.5 : -0.5) * h, v * d] : [(f === 5 ? 0.5 : -0.5) * w, u * h, v * d];
    return [c[0] + p[0], c[1] + p[1], c[2] + p[2], f === 1 ? rand(0.5, 1) : rand(0.3, 0.8)];
  };
  // An upward arch made of a tube (the padlock's shackle).
  const onArch = (cy, R, r) => () => {
    const th = rand(Math.PI, TAU), ph = Math.random() * TAU, k = R + r * Math.cos(ph);
    return [k * Math.cos(th), cy + k * Math.sin(th), r * Math.sin(ph), rand(0.45, 1)];
  };
  // Part of an ellipse outline, facing the viewer.
  const onArc = (cx, cy, rx, ry, a0, a1, z = 0) => () => {
    const t = rand(a0, a1);
    return [cx + rx * Math.cos(t) + rand(-0.006, 0.006), cy + ry * Math.sin(t) + rand(-0.006, 0.006), z + rand(-0.01, 0.01), rand(0.5, 1)];
  };
  const inDisc = (cx, cy, r, z) => () => {
    const t = Math.random() * TAU, rr = r * Math.sqrt(Math.random());
    return [cx + rr * Math.cos(t), cy + rr * Math.sin(t), z + rand(-0.01, 0.01), rand(0.6, 1)];
  };
  const onRect = (cx, cy, w, h) => () => {
    const t = Math.random() * (2 * w + 2 * h), j = () => rand(-0.006, 0.006);
    const p = t < w ? [t - w / 2, -h / 2] : t < 2 * w ? [t - w - w / 2, h / 2] : t < 2 * w + h ? [-w / 2, t - 2 * w - h / 2] : [w / 2, t - 2 * w - h - h / 2];
    return [cx + p[0] + j(), cy + p[1] + j(), rand(-0.015, 0.015), rand(0.45, 0.95)];
  };

  // Fills N slots from weighted parts, then shuffles, so that when one shape
  // turns into the next the particles cross paths like a swarm.
  function build(parts) {
    const pos = new Float32Array(N * 3), al = new Float32Array(N);
    const total = parts.reduce((s, p) => s + p[0], 0);
    let i = 0;
    parts.forEach(([share, fn], pi) => {
      const n = pi === parts.length - 1 ? N - i : Math.round((N * share) / total);
      for (let k = 0; k < n && i < N; k++, i++) {
        const q = fn();
        pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2]; al[i] = q[3];
      }
    });
    for (let a = N - 1; a > 0; a--) {
      const b = (Math.random() * (a + 1)) | 0;
      for (let k = 0; k < 3; k++) { const t = pos[a * 3 + k]; pos[a * 3 + k] = pos[b * 3 + k]; pos[b * 3 + k] = t; }
      const t = al[a]; al[a] = al[b]; al[b] = t;
    }
    return { pos, al };
  }

  // 1. The call: six people in a ring, a line between every pair.
  const PEOPLE = 6;
  const nodes = [];
  for (let i = 0; i < PEOPLE; i++) {
    const ang = (i / PEOPLE) * TAU;
    nodes.push([Math.cos(ang), rand(-0.3, 0.3), Math.sin(ang)]);
  }
  const edges = [];
  for (let i = 0; i < PEOPLE; i++) for (let j = i + 1; j < PEOPLE; j++) edges.push([nodes[i], nodes[j]]);
  const network = build([
    ...nodes.map((c, i) => [i % 3 === 0 ? 9 : 6.5, onSphere(c, i % 3 === 0 ? 0.2 : 0.15)]),
    ...edges.map(([a, b]) => [2.4, onLine(a, b)]),
    [3.5, onHalo(nodes[0], 0.3)], [3.5, onHalo(nodes[3], 0.3)], [2, onHalo(nodes[1], 0.23)],
    [5, inCloud(0.32, 0.2)], [5, speck],
  ]);

  // 2. How it works: two browsers and the direct line between them.
  const L = [-0.9, 0, 0], Rr = [0.9, 0, 0];
  const duo = build([
    [30, onSphere(L, 0.4)], [30, onSphere(Rr, 0.4)],
    [16, onLine(L, Rr, 0.035)],
    [6, onHalo(L, 0.56)], [6, onHalo(Rr, 0.56)],
    [12, speck],
  ]);

  // 3. What stays private: a padlock.
  const lock = build([
    [50, onBox([0, 0.32, 0], 1.2, 0.95, 0.45)],
    [22, onArch(-0.3, 0.38, 0.075)],
    [4, onLine([-0.38, -0.3, 0], [-0.38, -0.16, 0], 0.06)], [4, onLine([0.38, -0.3, 0], [0.38, -0.16, 0], 0.06)],
    [5, inDisc(0, 0.2, 0.11, 0.235)], [3, onLine([0, 0.24, 0.235], [0, 0.5, 0.235], 0.03)],
    [10, speck],
  ]);

  // 4. In a call: a wall of six tiles, a person in each.
  const tileParts = [];
  for (const cy of [-0.3, 0.3]) for (const cx of [-0.72, 0, 0.72]) {
    tileParts.push([8, onRect(cx, cy, 0.6, 0.46)]);
    tileParts.push([2, onArc(cx, cy - 0.06, 0.08, 0.08, 0, TAU)]);
    tileParts.push([2.4, onArc(cx, cy + 0.19, 0.17, 0.13, Math.PI, TAU)]);
  }
  const tiles = build([...tileParts, [9, speck]]);

  // 5. The end: the Huddle mark, three people and their links.
  const V = [[0, -0.62, 0], [-0.66, 0.48, 0], [0.66, 0.48, 0]];
  const mark = build([
    ...V.map((c) => [20, onSphere(c, 0.24)]),
    [9, onLine(V[0], V[1], 0.03)], [9, onLine(V[1], V[2], 0.03)], [9, onLine(V[2], V[0], 0.03)],
    [13, speck],
  ]);

  const shapes = [network, duo, lock, tiles, mark];

  // Per-particle character: where it starts on load, when it leaves in a morph,
  // and how it wanders mid-flight.
  const scatter = new Float32Array(N * 3), stagger = new Float32Array(N), phase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    scatter[i * 3] = rand(-3, 3); scatter[i * 3 + 1] = rand(-3, 3); scatter[i * 3 + 2] = rand(-3, 3);
    stagger[i] = Math.random();
    phase[i] = rand(0, TAU);
  }

  // Packets: bright dots that run along the call's lines, like its data.
  const packets = [];
  edges.forEach((e) => {
    for (let k = 0; k < (lite ? 2 : 3); k++) packets.push({ e, t: Math.random(), v: rand(0.1, 0.26) * (Math.random() < 0.5 ? -1 : 1) });
  });

  // Dust drifting across the whole view, sliding as you scroll.
  const dust = [];
  for (let i = 0; i < (lite ? 260 : 620); i++) {
    dust.push({ x: Math.random(), y: Math.random(), depth: rand(0.15, 1), vx: rand(-0.00004, 0.00004), vy: rand(-0.00006, 0.00002), a: rand(0.08, 0.4), s: rand(0.8, 1.6), ph: rand(0, TAU) });
  }

  // Short-lived sparks thrown by links and clicks.
  const sparks = [];
  function burst(x, y, n, speed, color = 0) {
    if (reduceMotion) return;
    for (let i = 0; i < n && sparks.length < 700; i++) {
      const ang = rand(0, TAU), v = rand(0.3, 1) * speed;
      sparks.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v - speed * 0.25, life: 0, max: rand(350, 900), c: color, s: rand(1, 2) });
    }
  }
  const shocks = []; // expanding rings from clicks

  /* ----- which shape should be showing, from how far the page is scrolled ----- */

  // 0 at the top of the page, rising to the last shape at the very bottom.
  // Each shape holds for a stretch of scrolling, then changes over quickly, so
  // every shape gets its moment however long or short the page is.
  function progress() {
    const max = document.documentElement.scrollHeight - vh;
    const startAt = vh * 0.12;
    if (max <= startAt + 50) return 0;
    const u = Math.min(1, Math.max(0, (window.scrollY - startAt) / (max - startAt - 4)));
    const raw = u * (shapes.length - 1);
    const i = Math.min(shapes.length - 2, Math.floor(raw));
    return i + Math.min(1, Math.max(0, (raw - i - 0.3) / 0.4));
  }

  /* ----- frame loop ----- */

  let raf = 0, running = false, started = 0, last = 0;
  let rx = 0, ry = 0, rtx = 0, rty = 0;  // tilt follows the pointer, eased
  let mx = -9999, my = -9999;            // pointer position in the window
  let pS = 0;                            // smoothed scroll progress
  let slowFrames = 0, thin = 1;          // draw fewer particles if the device struggles

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth;
    vh = window.innerHeight;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
  }

  function frame(now) {
    if (!started) started = now;
    const dt = Math.min(50, last ? now - last : 16.7);
    last = now;
    const f = dt / 16.7; // 1 at 60 frames per second

    if (dt > 30) { if (++slowFrames > 40 && thin < 3) { thin++; slowFrames = 0; } } else if (slowFrames > 0) slowFrames--;

    const intro = reduceMotion ? 1 : Math.min(1, (now - started) / 1900);
    const k = 1 - Math.pow(1 - intro, 3);
    rx += (rtx - rx) * 0.05;
    ry += (rty - ry) * 0.05;

    // Which two shapes we are between, and how far along.
    const target = progress();
    pS = reduceMotion ? target : pS + (target - pS) * Math.min(1, 0.085 * f);
    const i0 = Math.min(shapes.length - 2, Math.floor(pS));
    const t = Math.min(1, pS - i0);
    const A = shapes[i0], B = shapes[i0 + 1];

    // Where the swarm sits: in the gap of the first screen at the top, then
    // pinned to the side of the window (dimmed, behind the text) in About.
    const sr = space.getBoundingClientRect();
    const g0 = Math.min(1, pS), g = g0 * g0 * (3 - 2 * g0);
    const wide = vw > 900;
    const hx = sr.left + sr.width / 2, hy = sr.top + sr.height / 2;
    const hs = Math.min(sr.width, sr.height * 1.25) * 0.42;
    const ax = wide ? vw * 0.76 : vw * 0.5, ay = vh * 0.5;
    const as = Math.min(vw, vh) * (wide ? 0.3 : 0.36);
    const ox = hx + (ax - hx) * g, oy = hy + (ay - hy) * g, scale = hs + (as - hs) * g;
    const dim = 1 - (1 - (wide ? 0.44 : 0.28)) * g;

    // It spins freely at the top and sways gently once it shows the About shapes.
    const spin = (now * 0.00017) % TAU, sway = Math.sin(now * 0.00045) * 0.6;
    const rotY = (reduceMotion ? 0.6 * (1 - g) : spin * (1 - g) + sway * g) + rx * 0.7;
    const rotX = 0.42 * (1 - g * 0.65) + ry * 0.3;
    const cy = Math.cos(rotY), sy = Math.sin(rotY), cx = Math.cos(rotX), sx = Math.sin(rotX);
    const cam = 3.4, R = 95, R2 = R * R;

    const project = (x0, y0, z0) => {
      const x1 = x0 * cy - z0 * sy, z1 = x0 * sy + z0 * cy;
      const y2 = y0 * cx - z1 * sx, z2 = y0 * sx + z1 * cx;
      if (z2 > 1.9) return null; // too close to the viewer
      const p = cam / (cam - z2);
      return [ox + x1 * scale * p, oy + y2 * scale * p, p, Math.min(1, Math.max(0, (z2 + 1.4) / 2.8))];
    };

    for (let s = shocks.length - 1; s >= 0; s--) if (now - shocks[s].t0 > 950) shocks.splice(s, 1);

    const pa = A.pos, pb = B.pos;
    for (let i = 0; i < N; i += thin) {
      const j = i * 3;
      // Each particle sets off at its own moment, so shapes dissolve and re-form.
      let e = t * 1.5 - stagger[i] * 0.5;
      e = e <= 0 ? 0 : e >= 1 ? 1 : e * e * (3 - 2 * e);
      let x = pa[j] + (pb[j] - pa[j]) * e, y = pa[j + 1] + (pb[j + 1] - pa[j + 1]) * e, z = pa[j + 2] + (pb[j + 2] - pa[j + 2]) * e;
      if (e > 0 && e < 1 && !reduceMotion) {
        // Mid-flight, it swings wide.
        const amp = Math.sin(Math.PI * e) * 0.55, ph = phase[i];
        x += Math.sin(ph + now * 0.0013) * amp;
        y += Math.cos(ph * 1.7 + now * 0.0011) * amp;
        z += Math.sin(ph * 2.3 + now * 0.0009) * amp;
      }
      if (k < 1) {
        x = scatter[j] + (x - scatter[j]) * k; y = scatter[j + 1] + (y - scatter[j + 1]) * k; z = scatter[j + 2] + (z - scatter[j + 2]) * k;
      }
      const q = project(x, y, z);
      if (!q) continue;
      let px = q[0], py = q[1];

      // Particles near the pointer are nudged aside.
      let dx = px - mx, dy = py - my, d2 = dx * dx + dy * dy;
      if (d2 < R2 && d2 > 0.01) {
        const d = Math.sqrt(d2), push = (1 - d / R) * (1 - d / R) * 24;
        px += (dx / d) * push; py += (dy / d) * push;
      }
      // Click shockwaves shove whatever the ring is passing through.
      for (let s = 0; s < shocks.length; s++) {
        const sh = shocks[s], age = now - sh.t0;
        dx = px - sh.x; dy = py - sh.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1, off = Math.abs(d - age * 0.75);
        if (off < 48) {
          const push = (1 - off / 48) * 30 * (1 - age / 950);
          px += (dx / d) * push; py += (dy / d) * push;
        }
      }
      const a = (A.al[i] + (B.al[i] - A.al[i]) * e) * (0.35 + 0.65 * q[3]) * (reduceMotion ? 0.85 : 0.6 + Math.random() * 0.4);
      put(0, px, py, 1.15 * q[2], a * k * dim);
    }

    // Packets only belong to the first shape, so they fade as it breaks up.
    const packetFade = 1 - Math.min(1, pS * 2.2);
    if (k > 0.9 && packetFade > 0 && !reduceMotion) {
      for (const p of packets) {
        p.t += (p.v * dt) / 1000;
        if (p.t > 1) p.t -= 1; else if (p.t < 0) p.t += 1;
        for (let tail = 0; tail < 6; tail++) {
          const tt = p.t - Math.sign(p.v) * tail * 0.012;
          if (tt < 0 || tt > 1) continue;
          const [a, b] = p.e;
          const q = project(a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt, a[2] + (b[2] - a[2]) * tt);
          if (q) put(0, q[0] - 0.6, q[1] - 0.6, (2.4 - tail * 0.25) * q[2], (1 - tail / 6) * (0.5 + 0.5 * q[3]) * packetFade);
        }
      }
    }

    // Dust, sliding at different speeds as the page scrolls.
    const scroll = window.scrollY, band = vh * 1.3;
    for (const p of dust) {
      if (!reduceMotion) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.x < 0) p.x += 1; else if (p.x > 1) p.x -= 1;
        if (p.y < 0) p.y += 1; else if (p.y > 1) p.y -= 1;
      }
      const y = ((((p.y * band - scroll * p.depth * 0.35) % band) + band) % band) - vh * 0.15;
      put(0, p.x * vw, y, p.s, p.a * (0.55 + 0.45 * Math.sin(now * 0.0012 + p.ph)) * k);
    }

    // Sparks.
    for (let s = sparks.length - 1; s >= 0; s--) {
      const p = sparks[s];
      p.life += dt;
      if (p.life >= p.max) { sparks.splice(s, 1); continue; }
      p.vy += 0.012 * f; // a little gravity
      p.vx *= 0.985; p.vy *= 0.985;
      p.x += p.vx * f; p.y += p.vy * f;
      put(p.c, p.x, p.y, p.s, 1 - p.life / p.max);
    }

    flush();
    if (running && !reduceMotion) raf = requestAnimationFrame(frame);
  }

  /* ----- start, stop, input ----- */

  function start() {
    if (running) return;
    running = true;
    resize();
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }
  // With reduced motion there is no loop, so redraw when something changes.
  const redraw = () => { if (running && reduceMotion) requestAnimationFrame(frame); };

  window.addEventListener('resize', () => { if (running) { resize(); redraw(); } });
  window.addEventListener('scroll', redraw, { passive: true });

  window.addEventListener('pointermove', (e) => {
    rtx = e.clientX / window.innerWidth - 0.5;
    rty = e.clientY / window.innerHeight - 0.5;
    mx = e.clientX; my = e.clientY;
  }, { passive: true });
  const pointerGone = () => { mx = -9999; my = -9999; };
  window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') pointerGone(); }, { passive: true });
  document.addEventListener('pointerleave', pointerGone);

  // A click or tap anywhere sends out a shockwave and a puff of sparks.
  window.addEventListener('pointerdown', (e) => {
    if (!running || reduceMotion) return;
    if (shocks.length < 3) shocks.push({ x: e.clientX, y: e.clientY, t0: performance.now() });
    burst(e.clientX, e.clientY, 26, 3.2);
  }, { passive: true });

  // Links throw green sparks when the pointer reaches them.
  landing.querySelectorAll('.link').forEach((el) => {
    el.addEventListener('pointerenter', () => {
      if (!running) return;
      const r = el.getBoundingClientRect();
      for (let i = 0; i < 4; i++) burst(rand(r.left, r.right), r.bottom, 5, 1.6, 1);
    });
  });

  // About blocks rise into place as they scroll into view.
  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }, { threshold: 0.2 });
    landing.querySelectorAll('.about-title, .about-lede, .about-grid > div').forEach((el) => { el.classList.add('reveal'); io.observe(el); });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (running) { last = 0; raf = requestAnimationFrame(frame); }
  });

  window.HuddleFx = { start, stop };
  start();
})();
