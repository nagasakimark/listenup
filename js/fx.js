// 背景のふわふわ音符と、正解したときのキラキラ。 canvas 1枚で描く。
const cv = document.getElementById('fx');
const ctx = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
const notes = [];
const sparks = [];
const GLYPHS = ['♪', '♫', '♩', '♬'];
const COLORS = ['#ff6b6b', '#ffb020', '#2ee6a6', '#38bdf8', '#a78bfa', '#ffffff'];
let running = false, last = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize);
resize();

function spawnNote(initial) {
  notes.push({ x: Math.random() * W, y: initial ? Math.random() * H : H + 30, s: 16 + Math.random() * 28, v: 10 + Math.random() * 22, w: Math.random() * 6, g: GLYPHS[(Math.random() * 4) | 0], c: COLORS[(Math.random() * COLORS.length) | 0], a: 0.05 + Math.random() * 0.1 });
}
for (let i = 0; i < 16; i++) spawnNote(true);

export function burst(x, y, color = '#ffb020', n = 18) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 120 + Math.random() * 260;
    sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 80, life: 0.7 + Math.random() * 0.5, t: 0, s: 3 + Math.random() * 5, c: Math.random() < 0.5 ? color : COLORS[(Math.random() * COLORS.length) | 0], star: Math.random() < 0.4 });
  }
}
export function confetti() {
  for (let i = 0; i < 90; i++) sparks.push({ x: Math.random() * W, y: -20 - Math.random() * 100, vx: (Math.random() - 0.5) * 120, vy: 120 + Math.random() * 260, life: 2.2 + Math.random(), t: 0, s: 5 + Math.random() * 7, c: COLORS[(Math.random() * COLORS.length) | 0], star: false, rect: true, g: 40 });
}

function frame(ts) {
  const dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts;
  ctx.clearRect(0, 0, W, H);
  for (const n of notes) {
    n.y -= n.v * dt; n.x += Math.sin((n.y + n.w * 50) / 60) * 12 * dt;
    if (n.y < -40) { n.y = H + 30; n.x = Math.random() * W; }
    ctx.globalAlpha = n.a; ctx.fillStyle = n.c; ctx.font = `${n.s}px sans-serif`; ctx.fillText(n.g, n.x, n.y);
  }
  for (let i = sparks.length - 1; i >= 0; i--) {
    const p = sparks[i]; p.t += dt;
    if (p.t > p.life) { sparks.splice(i, 1); continue; }
    p.vy += (p.g ?? 420) * dt; p.x += p.vx * dt; p.y += p.vy * dt;
    ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.c;
    if (p.star) { ctx.font = `${p.s * 3}px sans-serif`; ctx.fillText('★', p.x, p.y); }
    else if (p.rect) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.t * 6); ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, 7); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  if (running) requestAnimationFrame(frame);
}
function start() { if (!running && !document.hidden) { running = true; last = performance.now(); requestAnimationFrame(frame); } }
document.addEventListener('visibilitychange', () => { if (document.hidden) running = false; else start(); });
start();
