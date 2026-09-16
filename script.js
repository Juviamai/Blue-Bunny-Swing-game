/* ============================================================
   Blue Bunny Swing — a cute dreamy swinging game
   ============================================================ */
'use strict';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
window.addEventListener('error', e => {
  const d = document.getElementById('dbg');
  if (d) d.textContent = 'ERR: ' + e.message + ' @' + e.lineno;
});

let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* ---------------- helpers ---------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TAU = Math.PI * 2;

/* ---------------- constants ---------------- */
const GRAVITY = 1900;          // px/s^2 when airborne
const CATCH_RADIUS = 70;       // forgiving grab distance from rope handle
const PLAYER_MOVE_FORCE = 900; // left/right influence while swinging
const AIR_CONTROL = 350;
const DEPTH = 0.55;            // world depth factor (smaller = closer)
const ROPE_GAP_BASE = 300;
const ROPE_GAP_GROWTH = 7;     // extra gap per rope index (capped)

const STATE = { START: 0, PLAYING: 1, FALLING: 2, GAMEOVER: 3 };

/* ---------------- game state ---------------- */
let gameState = STATE.START;
let score = 0;
let best = 0;
try { best = +(localStorage.getItem('bbs_best') || 0); } catch (e) {}
function saveBest() { try { localStorage.setItem('bbs_best', best); } catch (e) {} }
let ropes = [];
let particles = [];   // ambient sparkle particles
let petals = [];      // drifting petals
let clouds = [];
let mountains = [];
let pillars = [];
let flowers = [];
let ripples = [];     // catch feedback
let camX = 0, camTargetX = 0;
let time = 0;
let gameOverTimer = 0;
let worldSeedRng = Math.random;

const player = {
  x: 0, y: 0, vx: 0, vy: 0,
  ropeIndex: -1,
  hangOffset: 0,       // horizontal offset along the rope handle
  earSway: 0, hairSway: 0,
  bounce: 0,           // impact squash timer
  facing: 1,
  swinging: false,
  angle: 0,            // visual body angle while swinging
};

/* ---------------- input ---------------- */
const keys = {};
window.addEventListener('keydown', e => {
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' '].includes(e.key)) e.preventDefault();
  keys[e.key.toLowerCase()] = true;
  if (e.key === ' ' && !e.repeat) onJumpPressed();
  if (e.key === 'Enter' && gameState === STATE.GAMEOVER) restart();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

document.getElementById('overlay-btn').addEventListener('click', () => {
  if (gameState === STATE.START || gameState === STATE.GAMEOVER) restart();
});

/* ============================================================
   Rope generation
   ============================================================ */
function makeRope(i, x) {
  const diff = Math.min(i / 25, 1); // difficulty ramps then plateaus
  const gap = ROPE_GAP_BASE + ROPE_GAP_GROWTH * Math.min(i, 25) + rand(-25, 35);
  const length = rand(150, 210);
  return {
    index: i,
    ax: x,                       // anchor x (world)
    ay: rand(40, 100),           // anchor y (world, from top)
    length,
    baseAngle: rand(-0.12, 0.12),
    amplitude: rand(0.55, 0.85 + 0.25 * diff),
    speed: rand(0.9, 1.25 + 0.5 * diff),
    phase: rand(0, TAU),
    angle: 0, angVel: 0,
    bend: 0,                     // visual bend reaction when grabbed
    nextGap: gap,
    hue: rand(0, 1),
  };
}

function ropeEnd(r) {
  return {
    x: r.ax + Math.sin(r.angle) * r.length,
    y: r.ay + Math.cos(r.angle) * r.length,
  };
}

function ensureRopes() {
  // keep ropes generated ahead of camera
  while (!ropes.length || ropes[ropes.length - 1].ax < camX + W * 2) {
    const i = ropes.length;
    const last = ropes[ropes.length - 1];
    const x = last ? last.ax + last.nextGap : 260;
    ropes.push(makeRope(i, x));
  }
}

/* ============================================================
   Scenery generation (deterministic per column so restart feels fresh but consistent during a run)
   ============================================================ */
function sceneryRand(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s / 2147483647); };
}

function generateScenery() {
  clouds = []; mountains = []; pillars = []; flowers = []; petals = [];
  const rng = sceneryRand(Math.floor(Math.random() * 1e9) + 7);

  for (let i = 0; i < 40; i++) {
    clouds.push({ x: rng() * 12000, y: 40 + rng() * 220, s: 0.5 + rng() * 1.3, p: 0.15 + rng() * 0.2 });
  }
  // two mountain layers
  for (let layer = 0; layer < 2; layer++) {
    const pts = [];
    let x = -500;
    while (x < 13000) {
      pts.push({ x, h: (0.35 + rng() * 0.3) * (layer ? 0.7 : 1) });
      x += 250 + rng() * 250;
    }
    mountains.push(pts);
  }
  // pillars (decorative, below ropes)
  for (let i = 0; i < 100; i++) {
    pillars.push({
      x: 150 + i * 260 + rng() * 80,
      w: 60 + rng() * 50,
      h: 140 + rng() * 160,
      cap: rng() > 0.5,
    });
  }
  // flowers on ground + around pillars
  for (let i = 0; i < 420; i++) {
    flowers.push({
      x: rng() * 13000,
      y: 0, // filled at draw: ground area
      gy: 1 - rng() * 0.25, // depth factor in garden band
      s: 0.5 + rng() * 0.8,
      phase: rng() * TAU,
      onPillar: rng() > 0.55,
      pillarIdx: Math.floor(rng() * 100),
      color: rng(),
    });
  }
  // drifting petals
  for (let i = 0; i < 30; i++) {
    petals.push({ x: rng() * W, y: rng() * H, s: 0.4 + rng() * 0.8, vx: 15 + rng() * 25, vy: 8 + rng() * 15, phase: rng() * TAU, spin: rng() * TAU });
  }
  // ambient sparkles
  particles = [];
  for (let i = 0; i < 50; i++) {
    particles.push({ x: rng() * W, y: rng() * H * 0.8, s: 1 + rng() * 2.5, tw: rng() * TAU, sp: 0.5 + rng() * 1.5 });
  }
}

/* ============================================================
   Game flow
   ============================================================ */
function resetGame() {
  ropes = [];
  score = 0;
  camX = 0; camTargetX = 0;
  ripples = [];
  generateScenery();
  ensureRopes();
  lastRopeIndex = 0;
  attachToRope(0);
  updateHUD();
}

function restart() {
  resetGame();
  gameState = STATE.PLAYING;
  document.getElementById('overlay').classList.add('hidden');
}

function showOverlay(title, msg, btn) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-msg').textContent = msg;
  document.getElementById('overlay-btn').textContent = btn;
  document.getElementById('overlay').classList.remove('hidden');
}

function attachToRope(i) {
  const r = ropes[i];
  player.ropeIndex = i;
  player.vx = 0; player.vy = 0;
  player.swinging = true;
  player.hangOffset = 0;
  const end = ropeEnd(r);
  player.x = end.x;
  player.y = end.y + 26;
  r.bend = 1;
  player.bounce = 1;
  if (i > 0) {
    score++;
    const end = ropeEnd(r);
    ripples.push({ x: end.x, y: end.y, t: 0 });
    updateHUD();
  }
}

function onJumpPressed() {
  if (gameState !== STATE.PLAYING || player.ropeIndex < 0) return;
  const r = ropes[player.ropeIndex];
  const end = ropeEnd(r);
  // tangential velocity of pendulum end
  const tangential = r.angVel * r.length; // px/s along swing direction
  // convert to world velocity: derivative of (sin,cos)
  const dx = Math.cos(r.angle);
  const dy = -Math.sin(r.angle);
  player.vx = tangential * dx + player.hangOffset * 0;
  player.vy = tangential * dy;
  // small upward boost for cuteness
  player.vy -= 220;
  player.x = end.x;
  player.y = end.y;
  player.ropeIndex = -1;
  player.swinging = false;
  player.hairSway = -Math.sign(player.vx || 1) * 1;
}

function die() {
  gameState = STATE.FALLING;
  gameOverTimer = 0;
}

let hudCache = '', dbgTimer = 0;
function updateHUD(dt = 0) {
  dbgTimer += dt;
  const dist = Math.max(0, Math.floor((player.x - ropes[0].ax) / 30));
  const key = `${score}|${best}|${dist}`;
  if (key !== hudCache) {
    hudCache = key;
    document.getElementById('score').textContent = score;
    document.getElementById('best').textContent = best;
    document.getElementById('distance').textContent = dist;
  }
  if (dbgTimer > 0.25) {
    dbgTimer = 0;
    document.getElementById('dbg').textContent =
      `st=${gameState} sc=${score} ri=${player.ropeIndex} sw=${player.swinging?1:0} ` +
      `px=${Math.round(player.x)} py=${Math.round(player.y)} ` +
      `vx=${Math.round(player.vx)} vy=${Math.round(player.vy)} cam=${Math.round(camX)}`;
  }
}

/* ============================================================
   Update loop
   ============================================================ */
let lastT = performance.now();
function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.033);
  lastT = now;
  time += dt;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

function update(dt) {
  // ambient particles always animate
  for (const p of particles) {
    p.x -= p.sp * 12 * dt;
    p.tw += dt * 2;
    if (p.x < -10) { p.x = W + 10; p.y = Math.random() * H * 0.8; }
  }
  for (const pt of petals) {
    pt.x += (pt.vx + Math.sin(time + pt.phase) * 10) * dt;
    pt.y += pt.vy * dt;
    pt.spin += dt;
    if (pt.y > H + 20 || pt.x > W + 30) {
      pt.x = Math.random() * W - 50; pt.y = -20;
      if (pt.x < -60) pt.x = rand(0, W);
    }
  }
  for (const rp of ripples) rp.t += dt * 2.2;
  ripples = ripples.filter(r => r.t < 1);

  if (gameState === STATE.START) return;

  // rope physics (pendulum-ish: driven sinusoid + damped spring for grab reactions)
  for (const r of ropes) {
    const target = r.baseAngle + Math.sin(time * r.speed + r.phase) * r.amplitude;
    // smooth toward target with velocity for natural motion
    const k = 6, c = 2 * Math.sqrt(k) * 0.65;
    const accel = (target - r.angle) * k - r.angVel * c;
    r.angVel += accel * dt;
    r.angle += r.angVel * dt;
    r.bend = Math.max(0, r.bend - dt * 3);
  }

  ensureRopes();

  if (gameState === STATE.FALLING) {
    gameOverTimer += dt;
    // let her fall a bit, then show game over
    player.vy += GRAVITY * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    player.hairSway = lerp(player.hairSway, 1, dt * 4);
    if (player.y > camFallLimit() || gameOverTimer > 2.2) {
      gameState = STATE.GAMEOVER;
      best = Math.max(best, score);
      saveBest();
      updateHUD();
      showOverlay('Oops! You fell! 💦', `You caught ${score} rope${score === 1 ? '' : 's'}! Try again?`, 'Restart');
    }
  } else if (gameState === STATE.PLAYING) {
    if (player.swinging) {
      const r = ropes[player.ropeIndex];
      // left/right nudges the hang offset along the handle & pumps the swing
      const dir = (keys['arrowright'] || keys['d'] ? 1 : 0) - (keys['arrowleft'] || keys['a'] ? 1 : 0);
      player.hangOffset = clamp(player.hangOffset + dir * 60 * dt, -26, 26);
      // pumping: push angular velocity in direction of current motion when holding direction
      if (dir !== 0) r.angVel += dir * 0.35 * dt;
      const end = ropeEnd(r);
      player.x = end.x + Math.cos(r.angle) * -player.hangOffset * 0.3 + player.hangOffset * 0.9;
      player.y = end.y + 26; // hands above head, body below handle
      player.vx = r.angVel * r.length * Math.cos(r.angle);
      player.vy = -r.angVel * r.length * Math.sin(r.angle);
      player.facing = player.vx >= 0 ? 1 : -1;
      player.earSway = lerp(player.earSway, clamp(-r.angVel * 1.4, -0.7, 0.7), dt * 8);
      player.hairSway = lerp(player.hairSway, clamp(-r.angVel * 1.1, -0.6, 0.6), dt * 8);
    } else {
      // airborne
      const dir = (keys['arrowright'] || keys['d'] ? 1 : 0) - (keys['arrowleft'] || keys['a'] ? 1 : 0);
      player.vx += dir * AIR_CONTROL * dt;
      player.vx = clamp(player.vx, -900, 900);
      player.vy += GRAVITY * dt;
      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.facing = player.vx >= 0 ? 1 : -1;
      player.earSway = lerp(player.earSway, clamp(-player.vx * 0.001, -0.5, 0.5), dt * 6);
      player.hairSway = lerp(player.hairSway, clamp(-player.vx * 0.0009, -0.45, 0.45), dt * 6);

      // catch detection — must move past current rope
      for (const r of ropes) {
        if (r.index === Math.max(0, lastRopeIndex)) continue;
        const end = ropeEnd(r);
        const dx = player.x - end.x;
        const dy = player.y - (end.y + 10);
        if (dx * dx + dy * dy < CATCH_RADIUS * CATCH_RADIUS && player.y < end.y + 60) {
          lastRopeIndex = r.index;
          attachToRope(r.index);
          break;
        }
      }
      if (!player.swinging && player.y > H + camLimitOffset() + 200) {
        die();
      }
    }
    player.bounce = Math.max(0, player.bounce - dt * 3);
    updateHUD(dt);
  }

  // camera: follow, keep player around center-left
  camTargetX = player.x - W * 0.38;
  camX = lerp(camX, camTargetX, 1 - Math.pow(0.001, dt));
}

let lastRopeIndex = 0;
function camLimitOffset() { return 0; }
function camFallLimit() { return 1e9; } // fall handled by screen check above; falling state continues briefly

/* ============================================================
   Drawing
   ============================================================ */
function draw() {
  // sky gradient
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#bfe3ff');
  sky.addColorStop(0.55, '#dff1ff');
  sky.addColorStop(1, '#f3fbff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // soft sunlight glow
  const sunX = W * 0.78, sunY = H * 0.16;
  const glow = ctx.createRadialGradient(sunX, sunY, 10, sunX, sunY, 340);
  glow.addColorStop(0, 'rgba(255,252,230,0.75)');
  glow.addColorStop(1, 'rgba(255,252,230,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  drawMountains();
  drawClouds();
  drawPillarsAndGarden();

  // ---- world layer (ropes + player) ----
  ctx.save();
  ctx.translate(-camX, 0);

  for (const r of ropes) drawRope(r);
  for (const rp of ripples) drawRipple(rp);
  drawPlayer();

  ctx.restore();

  drawPetals();
  drawSparkles();

  if (gameState === STATE.START) {
    // gentle idle preview is visible behind the overlay
  }
}

function drawMountains() {
  const layers = [
    { pts: mountains[0], color: '#b9d4ee', par: 0.12, base: H * 0.72 },
    { pts: mountains[1], color: '#cfe2f5', par: 0.2, base: H * 0.78 },
  ];
  for (const L of layers) {
    ctx.fillStyle = L.color;
    ctx.beginPath();
    ctx.moveTo(-50, H);
    for (const p of L.pts) {
      const x = p.x - camX * L.par;
      if (x < -400 || x > W + 400) continue;
      ctx.lineTo(x, L.base - p.h * H * 0.35);
    }
    ctx.lineTo(W + 50, H);
    ctx.closePath();
    ctx.fill();
  }
}

function drawClouds() {
  for (const c of clouds) {
    const x = c.x - camX * c.p;
    const sx = ((x % (W + 900)) + W + 900) % (W + 900) - 300;
    drawCloud(sx, c.y, c.s);
  }
}
function drawCloud(x, y, s) {
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.beginPath();
  ctx.arc(x, y, 26 * s, 0, TAU);
  ctx.arc(x + 28 * s, y - 10 * s, 32 * s, 0, TAU);
  ctx.arc(x + 60 * s, y, 24 * s, 0, TAU);
  ctx.arc(x + 30 * s, y + 12 * s, 26 * s, 0, TAU);
  ctx.fill();
}

function drawPillarsAndGarden() {
  const groundY = H - 60;
  // garden gradient band
  const g = ctx.createLinearGradient(0, H - 150, 0, H);
  g.addColorStop(0, '#dff3e4');
  g.addColorStop(1, '#c2e6cf');
  ctx.fillStyle = g;
  ctx.fillRect(0, H - 150, W, 150);

  for (const p of pillars) {
    const x = p.x - camX * 0.7;
    if (x < -150 || x > W + 150) continue;
    // pillar body
    const pg = ctx.createLinearGradient(x, 0, x + p.w, 0);
    pg.addColorStop(0, '#dceafc');
    pg.addColorStop(1, '#bcd6f2');
    ctx.fillStyle = pg;
    ctx.fillRect(x, groundY - p.h, p.w, p.h);
    // cap
    if (p.cap) {
      ctx.fillStyle = '#cfdefa';
      ctx.fillRect(x - 8, groundY - p.h - 12, p.w + 16, 14);
    }
    // little glowing dots on pillar
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(x + 10 + (i % 2) * (p.w - 20), groundY - p.h + 25 + Math.floor(i / 2) * 40, 2.5, 0, TAU);
      ctx.fill();
    }
  }

  // flowers
  for (const f of flowers) {
    let x, y, par = 0.85;
    if (f.onPillar) {
      const p = pillars[f.pillarIdx % pillars.length];
      x = p.x + 8 + f.x % (p.w - 16) - camX * par;
      y = groundY - p.h + 12 + (f.gy) * (p.h - 30);
    } else {
      x = f.x - camX * par;
      y = groundY + 20 + (1 - f.gy) * 100;
    }
    if (x < -20 || x > W + 20) continue;
    const sway = Math.sin(time * 1.4 + f.phase) * 3;
    drawFlower(x, y, f.s, sway, f.color);
  }
}

function drawFlower(x, y, s, sway, c) {
  const colors = ['#aee0ff', '#c9ecff', '#d9c8ff', '#ffffff', '#c8f0d8'];
  const col = colors[Math.floor(c * colors.length) % colors.length];
  // stem
  ctx.strokeStyle = '#a8d8b8';
  ctx.lineWidth = 1.2 * s;
  ctx.beginPath();
  ctx.moveTo(x, y + 10 * s);
  ctx.quadraticCurveTo(x + sway * 0.5, y + 5 * s, x + sway, y);
  ctx.stroke();
  // petals
  ctx.fillStyle = col;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + time * 0.1;
    ctx.beginPath();
    ctx.ellipse(x + sway + Math.cos(a) * 3 * s, y + Math.sin(a) * 3 * s, 2.4 * s, 1.7 * s, a, 0, TAU);
    ctx.fill();
  }
  // center
  ctx.fillStyle = '#fdf6c8';
  ctx.beginPath();
  ctx.arc(x + sway, y, 1.6 * s, 0, TAU);
  ctx.fill();
}

function drawRope(r) {
  const end = ropeEnd(r);
  const sx = r.ax, sy = r.ay;
  if (sx < camX - 300 || sx > camX + W + 300) return;

  // anchor decoration (little cloud knot)
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(sx - 8, sy - 4, 8, 0, TAU);
  ctx.arc(sx + 8, sy - 4, 8, 0, TAU);
  ctx.arc(sx, sy - 10, 10, 0, TAU);
  ctx.fill();

  // vine-like rope with slight bend
  const bend = r.bend * 14 * (1 + Math.abs(r.angVel));
  const mx = (sx + end.x) / 2 + bend * 0.2;
  const my = (sy + end.y) / 2;
  ctx.strokeStyle = '#8fbf9a';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(mx, my, end.x, end.y);
  ctx.stroke();
  // highlight
  ctx.strokeStyle = 'rgba(220,245,225,0.6)';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(mx, my, end.x, end.y);
  ctx.stroke();

  // little leaves on the vine
  ctx.fillStyle = '#a8d8b8';
  for (let t = 0.25; t < 1; t += 0.25) {
    const lx = lerp(lerp(sx, mx, t), lerp(mx, end.x, t), t);
    const ly = lerp(lerp(sy, my, t), lerp(my, end.y, t), t);
    ctx.beginPath();
    ctx.ellipse(lx + 6, ly, 6, 2.6, -0.5 + Math.sin(time * 2 + t * 9) * 0.15, 0, TAU);
    ctx.fill();
  }

  // handle (small branch) at the end
  ctx.strokeStyle = '#7fae8b';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(end.x - 18, end.y);
  ctx.lineTo(end.x + 18, end.y);
  ctx.stroke();
  // glow ring at handle for the NEXT rope cue
  if (player.ropeIndex >= 0 && r.index === player.ropeIndex + 1) {
    ctx.strokeStyle = `rgba(140,200,255,${0.35 + Math.sin(time * 4) * 0.2})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(end.x, end.y, CATCH_RADIUS, 0, TAU);
    ctx.stroke();
  }
}

function drawRipple(rp) {
  ctx.strokeStyle = `rgba(160,215,255,${1 - rp.t})`;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(rp.x, rp.y, 15 + rp.t * 55, 0, TAU);
  ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${(1 - rp.t) * 0.8})`;
  ctx.beginPath();
  ctx.arc(rp.x, rp.y, 8 + rp.t * 35, 0, TAU);
  ctx.stroke();
}

/* ---------------- the bunny girl ---------------- */
function drawPlayer() {
  const p = player;
  const x = p.x, y = p.y;
  const sq = p.bounce; // squash on catch
  const breathe = Math.sin(time * 3) * 0.03;

  ctx.save();
  ctx.translate(x, y);

  // falling pose: tumble slightly
  if (gameState === STATE.FALLING) {
    ctx.rotate(Math.sin(time * 6) * 0.15);
  } else if (p.swinging) {
    ctx.rotate(clamp(-p.earSway * 0.25, -0.2, 0.2));
  }

  ctx.scale(p.facing, 1);
  ctx.scale(1 + sq * 0.15, 1 - sq * 0.18);

  // ---- shadow ----
  ctx.fillStyle = 'rgba(120,170,220,0.15)';
  ctx.beginPath();
  ctx.ellipse(0, 46, 20, 5, 0, 0, TAU);
  ctx.fill();

  // ---- hair back (flowing blue) ----
  const hairSwing = p.hairSway;
  ctx.fillStyle = '#7ab8e8';
  ctx.beginPath();
  ctx.moveTo(-10, -14);
  ctx.quadraticCurveTo(-26 - hairSwing * 10, 6, -16 - hairSwing * 14, 34 + breathe * 10);
  ctx.quadraticCurveTo(-6, 22, -9, -12);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(10, -14);
  ctx.quadraticCurveTo(24 - hairSwing * 8, 8, 15 - hairSwing * 12, 32 + breathe * 8);
  ctx.quadraticCurveTo(6, 20, 9, -12);
  ctx.closePath();
  ctx.fill();

  // ---- bunny ears ----
  const earTilt = p.earSway;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(side * 7, -22);
    ctx.rotate(side * 0.22 + earTilt * 0.5);
    // outer ear
    ctx.fillStyle = '#f6f9ff';
    ctx.beginPath();
    ctx.ellipse(0, -16, 5.5, 17, 0, 0, TAU);
    ctx.fill();
    // inner ear (pastel pink-blue)
    ctx.fillStyle = '#cfe0f8';
    ctx.beginPath();
    ctx.ellipse(0, -15, 2.6, 12, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ---- head ----
  ctx.fillStyle = '#ffeede';
  ctx.beginPath();
  ctx.arc(0, -12, 13, 0, TAU);
  ctx.fill();
  // side hair tufts
  ctx.fillStyle = '#8fc4ee';
  ctx.beginPath();
  ctx.ellipse(-11, -10, 5, 8, 0.4, 0, TAU);
  ctx.ellipse(11, -10, 5, 8, -0.4, 0, TAU);
  ctx.fill();
  // fringe
  ctx.fillStyle = '#8fc4ee';
  ctx.beginPath();
  ctx.arc(0, -14, 13.5, Math.PI * 1.05, Math.PI * 1.95);
  ctx.quadraticCurveTo(6, -20, 0, -16);
  ctx.quadraticCurveTo(-6, -20, -12.5, -12);
  ctx.closePath();
  ctx.fill();

  // ---- face ----
  // eyes (big, expressive)
  ctx.fillStyle = '#3b4b6b';
  ctx.beginPath();
  ctx.ellipse(-4.5, -10, 2.6, 3.4, 0, 0, TAU);
  ctx.ellipse(4.5, -10, 2.6, 3.4, 0, 0, TAU);
  ctx.fill();
  // eye shine
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-3.7, -11.2, 1, 0, TAU);
  ctx.arc(5.3, -11.2, 1, 0, TAU);
  ctx.fill();
  // blush
  ctx.fillStyle = 'rgba(255,180,190,0.55)';
  ctx.beginPath();
  ctx.ellipse(-8, -6.5, 2.8, 1.7, 0, 0, TAU);
  ctx.ellipse(8, -6.5, 2.8, 1.7, 0, 0, TAU);
  ctx.fill();
  // tiny mouth (happy when swinging, surprised when falling)
  ctx.strokeStyle = '#d98a96';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  if (gameState === STATE.FALLING) {
    ctx.arc(0, -4, 1.8, 0, TAU);
  } else {
    ctx.arc(0, -6, 2.4, 0.15 * Math.PI, 0.85 * Math.PI);
  }
  ctx.stroke();

  // ---- arms holding up (toward handle) ----
  ctx.strokeStyle = '#ffeede';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-5, -2);
  ctx.lineTo(-4, -20);
  ctx.moveTo(5, -2);
  ctx.lineTo(4, -20);
  ctx.stroke();

  // ---- dress (sky blue, Juvia-inspired palette) ----
  const dress = ctx.createLinearGradient(0, 0, 0, 26);
  dress.addColorStop(0, '#9fd4f7');
  dress.addColorStop(1, '#7cb8e8');
  ctx.fillStyle = dress;
  ctx.beginPath();
  ctx.moveTo(-6, -2);
  ctx.lineTo(6, -2);
  ctx.quadraticCurveTo(15, 14, 12, 24);
  ctx.quadraticCurveTo(0, 28, -12, 24);
  ctx.quadraticCurveTo(-15, 14, -6, -2);
  ctx.closePath();
  ctx.fill();
  // white frill
  ctx.fillStyle = '#f2f9ff';
  ctx.beginPath();
  ctx.moveTo(-12, 23);
  ctx.quadraticCurveTo(0, 28, 12, 23);
  ctx.quadraticCurveTo(0, 32, -12, 23);
  ctx.closePath();
  ctx.fill();
  // little bow at chest
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(-3, 1, 2.5, 1.7, 0.4, 0, TAU);
  ctx.ellipse(3, 1, 2.5, 1.7, -0.4, 0, TAU);
  ctx.fill();

  // ---- legs ----
  const legSwing = Math.sin(time * 5) * 2;
  ctx.strokeStyle = '#ffeede';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(-4, 26); ctx.lineTo(-4 + legSwing, 38);
  ctx.moveTo(4, 26); ctx.lineTo(4 - legSwing, 38);
  ctx.stroke();
  // shoes
  ctx.fillStyle = '#6aa8dc';
  ctx.beginPath();
  ctx.ellipse(-4 + legSwing, 39, 3, 2, 0, 0, TAU);
  ctx.ellipse(4 - legSwing, 39, 3, 2, 0, 0, TAU);
  ctx.fill();

  ctx.restore();
}

/* ---------------- ambient layers ---------------- */
function drawPetals() {
  for (const pt of petals) {
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(Math.sin(pt.spin) * 0.8);
    ctx.fillStyle = 'rgba(200,230,255,0.7)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 5 * pt.s, 2.4 * pt.s, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

function drawSparkles() {
  for (const p of particles) {
    const a = 0.3 + Math.abs(Math.sin(p.tw)) * 0.7;
    ctx.fillStyle = `rgba(255,255,255,${a * 0.8})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.s, 0, TAU);
    ctx.fill();
    // cross sparkle on bigger ones
    if (p.s > 2.4) {
      ctx.strokeStyle = `rgba(220,240,255,${a * 0.6})`;
      ctx.lineWidth = 1;
      const r = p.s * 2.2;
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y); ctx.lineTo(p.x + r, p.y);
      ctx.moveTo(p.x, p.y - r); ctx.lineTo(p.x, p.y + r);
      ctx.stroke();
    }
  }
}

/* ============================================================
   Boot
   ============================================================ */
resetGame();
// start screen preview: put her on the rope statically visible
requestAnimationFrame(frame);
