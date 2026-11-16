// Landing-page artwork: a slowly turning ring of people drawn in dots, with a
// line between every pair, which is how a Huddle call is actually wired.
//
// It only runs while the landing page is visible. app.js calls HuddleFx.stop()
// the moment a call starts, so none of this competes with audio or video.

(() => {
  const canvas = document.getElementById('fx');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a, b) => a + Math.random() * (b - a);

  /* ----- build the point cloud once ----- */
  const pts = []; // { x, y, z, a, sx, sy, sz }
  function add(x, y, z, a) {
    // Each dot starts scattered and flies into place on load.
    pts.push({ x, y, z, a, sx: rand(-3, 3), sy: rand(-3, 3), sz: rand(-3, 3) });
  }
  function sphere(c, r, n) {
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      add(c[0] + r * s * Math.cos(t), c[1] + r * u, c[2] + r * s * Math.sin(t), rand(0.35, 1));
    }
  }
  function line(a, b, n) {
    const j = 0.016;
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      add(
        a[0] + (b[0] - a[0]) * t + rand(-j, j),
        a[1] + (b[1] - a[1]) * t + rand(-j, j),
        a[2] + (b[2] - a[2]) * t + rand(-j, j),
        rand(0.25, 0.8),
      );
    }
  }
  function halo(c, r, n) {
    for (let i = 0; i < n; i++) {
      const t = Math.random() * Math.PI * 2;
      const rr = r + rand(-0.012, 0.012);
      add(c[0] + rr * Math.cos(t), c[1] + rand(-0.01, 0.01), c[2] + rr * Math.sin(t), rand(0.4, 0.95));
    }
  }

  const PEOPLE = 6;
  const nodes = [];
  for (let i = 0; i < PEOPLE; i++) {
    const ang = (i / PEOPLE) * Math.PI * 2;
    nodes.push([Math.cos(ang), rand(-0.3, 0.3), Math.sin(ang)]);
  }
  nodes.forEach((c, i) => sphere(c, i % 3 === 0 ? 0.2 : 0.15, i % 3 === 0 ? 420 : 300));
  for (let i = 0; i < PEOPLE; i++) for (let j = i + 1; j < PEOPLE; j++) line(nodes[i], nodes[j], 120);
  halo(nodes[0], 0.3, 220);
  halo(nodes[3], 0.3, 220);
  for (let i = 0; i < 240; i++) add(rand(-2.2, 2.2), rand(-1.4, 1.4), rand(-2.2, 2.2), rand(0.08, 0.3)); // dust

  /* ----- draw ----- */
  let w = 0, h = 0, dpr = 1;
  let raf = 0, running = false, t0 = 0;
  let px = 0, py = 0, tx = 0, ty = 0; // pointer, eased

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }

  function frame(now) {
    if (!t0) t0 = now;
    const intro = reduceMotion ? 1 : Math.min(1, (now - t0) / 1700);
    const k = 1 - Math.pow(1 - intro, 3); // ease out
    px += (tx - px) * 0.05;
    py += (ty - py) * 0.05;

    const rotY = (reduceMotion ? 0.6 : now * 0.00017) + px * 0.7;
    const rotX = 0.42 + py * 0.3;
    const cy = Math.cos(rotY), sy = Math.sin(rotY);
    const cx = Math.cos(rotX), sx = Math.sin(rotX);
    const scale = Math.min(w, h * 1.25) * 0.4 * dpr;
    const ox = canvas.width / 2, oy = canvas.height / 2;
    const cam = 3.4;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    for (const p of pts) {
      const x0 = p.sx + (p.x - p.sx) * k;
      const y0 = p.sy + (p.y - p.sy) * k;
      const z0 = p.sz + (p.z - p.sz) * k;
      const x1 = x0 * cy - z0 * sy;
      const z1 = x0 * sy + z0 * cy;
      const y2 = y0 * cx - z1 * sx;
      const z2 = y0 * sx + z1 * cx;
      if (z2 > 1.9) continue; // too close to the viewer; would draw as a big square
      const f = cam / (cam - z2);
      const depth = Math.min(1, Math.max(0, (z2 + 1.4) / 2.8));
      const shimmer = reduceMotion ? 0.85 : 0.6 + Math.random() * 0.4; // grainy flicker
      ctx.globalAlpha = p.a * (0.35 + 0.65 * depth) * shimmer * k;
      const s = 1.15 * dpr * f;
      ctx.fillRect(ox + x1 * scale * f, oy + y2 * scale * f, s, s);
    }
    ctx.globalAlpha = 1;
    if (running && !reduceMotion) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  window.addEventListener('resize', () => {
    if (!running) return;
    resize();
    if (reduceMotion) requestAnimationFrame(frame);
  });
  window.addEventListener('pointermove', (e) => {
    tx = e.clientX / window.innerWidth - 0.5;
    ty = e.clientY / window.innerHeight - 0.5;
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else if (running) raf = requestAnimationFrame(frame);
  });

  /* ----- dotted sphere texture for camera-off avatars (drawn once) ----- */
  (function stipple() {
    const size = 264;
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    const r = size / 2 - 4;
    const light = [-0.45, -0.55, 0.7];
    for (let i = 0; i < 5200; i++) {
      const u = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const n = [s * Math.cos(t), u, Math.abs(s * Math.sin(t))];
      const lit = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
      if (Math.random() > 0.12 + lit * 0.88) continue;
      g.globalAlpha = 0.25 + lit * 0.6;
      g.fillRect(size / 2 + n[0] * r, size / 2 + n[1] * r, 1.5, 1.5);
    }
    try { document.documentElement.style.setProperty('--stipple', `url(${c.toDataURL()})`); } catch { /* plain avatar */ }
  })();

  window.HuddleFx = { start, stop };
  start();
})();
