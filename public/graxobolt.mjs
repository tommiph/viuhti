/* Graxobolt — 3D WebGL2 Neural Content Galaxy & Procedural Soundscape */
import * as THREE from '/vendor/three/three.module.min.js';

const SCRATCH_V1 = new THREE.Vector3();
const SCRATCH_V2 = new THREE.Vector3();
const SCRATCH_V3 = new THREE.Vector3();
const SCRATCH_Q = new THREE.Quaternion();
const SCRATCH_M = new THREE.Matrix4();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function readThemePalette() {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name, fallback) => {
    const val = (cs.getPropertyValue(name) || '').trim();
    try {
      return new THREE.Color(val || fallback);
    } catch {
      return new THREE.Color(fallback);
    }
  };
  const bgRaw = pick('--bg', '#07080f');
  // Deepen very bright light-theme backgrounds gently so 3D stars & neon arcs still glow crisply
  const lum = bgRaw.r * 0.299 + bgRaw.g * 0.587 + bgRaw.b * 0.114;
  const spaceBg = lum > 0.45 ? bgRaw.clone().lerp(new THREE.Color('#090d1b'), 0.88) : bgRaw.clone().lerp(new THREE.Color('#04050c'), 0.35);
  return {
    bg: spaceBg,
    accent: pick('--accent', '#8b5cf6'),
    accent2: pick('--accent-2', '#ec4899'),
    accent3: pick('--accent-3', '#f59e0b'),
    ok: pick('--ok', '#34d399'),
    person: new THREE.Color('#22d3ee'),
    source: new THREE.Color('#f472b6'),
    text: pick('--text', '#eef0fa'),
  };
}

function makeRadialTexture(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function makeNebulaTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  const half = size / 2;
  for (let i = 0; i < 7; i++) {
    const ox = half + Math.cos(i * 1.9) * (size * 0.12);
    const oy = half + Math.sin(i * 2.3) * (size * 0.12);
    const rad = size * (0.28 + (i % 3) * 0.08);
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.09)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Zero-dependency procedural Web Audio sci-fi synthesizer & dynamic engine pad. */
class SoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('viuhti.gbSound') !== '0';
    this.master = null;
    this.ambGain = null;
    this.ambFilter = null;
    this.ambStarted = false;
    this.lastHoverAt = 0;
  }

  ensureCtx() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (!this.ambStarted && this.ctx) {
      this.startAmbience();
    }
    return this.ctx;
  }

  startAmbience() {
    if (this.ambStarted || !this.ctx) return;
    try {
      const ctx = this.ctx;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 180;
      filter.Q.value = 1.4;

      const gain = ctx.createGain();
      gain.gain.value = 0.065;

      const o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 55;
      const o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = 82.41; // fifth harmonic

      o1.connect(filter);
      o2.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      o1.start();
      o2.start();

      this.ambFilter = filter;
      this.ambGain = gain;
      this.ambStarted = true;
    } catch {
      /* ignore autoplay blocks cleanly */
    }
  }

  setFlightIntensity(speedRatio) {
    if (!this.enabled || !this.ctx || !this.ambFilter || !this.ambGain) return;
    const now = this.ctx.currentTime;
    const freq = 170 + Math.min(1, speedRatio) * 640;
    const g = 0.055 + Math.min(1, speedRatio) * 0.085;
    this.ambFilter.frequency.setTargetAtTime(freq, now, 0.08);
    this.ambGain.gain.setTargetAtTime(g, now, 0.08);
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    try {
      localStorage.setItem('viuhti.gbSound', this.enabled ? '1' : '0');
    } catch {}
    if (!this.enabled && this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    } else if (this.enabled) {
      this.ensureCtx();
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  playTone(freq, dur = 0.08, type = 'sine', vol = 0.14, slideTo = null, delay = 0) {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  playHover(normImportance = 0.5) {
    const now = performance.now();
    if (now - this.lastHoverAt < 65) return;
    this.lastHoverAt = now;
    this.playTone(480 + normImportance * 460, 0.055, 'sine', 0.07, 620 + normImportance * 520);
  }

  playSelect() {
    this.playTone(587.3, 0.07, 'triangle', 0.14);
    this.playTone(880, 0.12, 'sine', 0.13, null, 0.055);
  }

  playWarp() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    this.playTone(110, 0.42, 'sine', 0.18, 260);
    // Crisp filtered noise whoosh
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.Q.value = 2.4;
    const t0 = ctx.currentTime;
    bf.frequency.setValueAtTime(220, t0);
    bf.frequency.exponentialRampToValueAtTime(2200, t0 + 0.36);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t0);
    g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.38);
    src.connect(bf);
    bf.connect(g);
    g.connect(this.master);
    src.start(t0);
  }

  playBoltExpand() {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    // Electric crackle transient + harmonic sci-fi bloom chord
    this.playTone(190, 0.14, 'sawtooth', 0.16, 980);
    const chord = [523.25, 659.25, 783.99, 987.77, 1174.66];
    chord.forEach((f, idx) => this.playTone(f, 0.24, 'sine', 0.1, null, idx * 0.04));
  }

  playConfirm() {
    this.playTone(784, 0.08, 'sine', 0.15);
    this.playTone(1174.6, 0.18, 'triangle', 0.16, null, 0.06);
  }
}

/** Build and mount Graxobolt inside containerEl. Returns lifecycle controller cleanly. */
export function mountGraxobolt(container, callbacks) {
  const { api, toast, onFeedback, onOpenModal } = callbacks;
  const sound = new SoundEngine();

  container.innerHTML = `
    <div class="gb-stage" id="gbStage">
      <canvas class="gb-canvas" id="gbCanvas"></canvas>
      <div class="gb-labels" id="gbLabels" aria-hidden="true"></div>

      <div class="gb-hud-top">
        <div class="gb-hud-left">
          <div class="gb-brand-pill">⚡ <b>GRAXOBOLT</b> <span id="gbSeedTitle" class="muted">Taste Nebula</span></div>
          <div class="gb-search-wrap">
            <input id="gbSearchInput" type="search" autocomplete="off" spellcheck="false" placeholder="Warp to show, movie, actor or creator…" aria-label="Search Graxobolt galaxy" />
            <div id="gbSearchDrop" class="gb-search-drop" hidden></div>
          </div>
          <button id="gbTasteBtn" class="btn btn-small btn-ghost" type="button" title="Return to your personalized Taste Universe">My Universe</button>
        </div>

        <div class="gb-hud-right">
          <span class="gb-stats-pill" id="gbStatsPill">60 FPS · 0 Stars</span>
          <button id="gbAutoDiveBtn" class="btn btn-small btn-ghost on" type="button" aria-pressed="true" title="Click any star to dive & re-seed into its POV">⚡ Auto-Dive</button>
          <button id="gbPovBtn" class="btn btn-small btn-ghost on" type="button" aria-pressed="true" title="Toggle Seed POV / Constellation Overview (V)">POV (V)</button>
          <button id="gbOrbitBtn" class="btn btn-small btn-ghost" type="button" aria-pressed="false" title="Toggle Auto-Orbit (Space)">Orbit</button>
          <button id="gbDarkMatterBtn" class="btn btn-small btn-ghost" type="button" aria-pressed="false" title="Show Hidden items on the outer rim">Dark Matter</button>
          <button id="gbSoundBtn" class="btn btn-small btn-ghost" type="button" aria-pressed="${sound.enabled}" title="Toggle Procedural Sci-Fi Soundscape">${sound.enabled ? '🔊 Audio' : '🔇 Muted'}</button>
          <button id="gbResetCamBtn" class="btn btn-small btn-ghost" type="button" title="Reset Camera (R)">Reset</button>
        </div>
      </div>

      <div class="gb-breadcrumbs" id="gbBreadcrumbs" hidden></div>

      <div class="gb-hud-controls" id="gbControlsHint">
        <b>WASD</b> Fly · <b>Q/E</b> Up/Down · <b>Shift</b> Warp · <b>Drag</b> Look · <b>Click</b> Dive POV · <b>V</b> POV/Overview
      </div>

      <div class="gb-inspector" id="gbInspector" hidden></div>
      <div class="gb-loading" id="gbLoading" hidden>
        <span class="spinner" aria-hidden="true"></span>
        <span id="gbLoadingText">Generating constellation…</span>
      </div>
    </div>`;

  const stage = container.querySelector('#gbStage');
  const canvas = container.querySelector('#gbCanvas');
  const labelsLayer = container.querySelector('#gbLabels');
  const inspector = container.querySelector('#gbInspector');
  const loadingBox = container.querySelector('#gbLoading');

  // Initialize Three.js WebGL2 renderer safely
  let renderer;
  let webglFailed = false;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
  } catch (err) {
    webglFailed = true;
    loadingBox.hidden = false;
    loadingBox.innerHTML = `<span>WebGL context unavailable on this browser (${esc(err.message)}).</span>`;
    return {
      isReady: () => false,
      pause: () => {},
      resume: () => {},
      loadSeed: () => {},
      loadTaste: () => {},
      refreshTheme: () => {},
      destroy: () => {},
    };
  }

  let palette = readThemePalette();
  const scene = new THREE.Scene();
  scene.background = palette.bg;
  scene.fog = new THREE.FogExp2(palette.bg.getHex(), 0.0022);

  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.5, 1600);
  camera.position.set(0, 58, 225);

  const worldGroup = new THREE.Group();
  const nebulaGroup = new THREE.Group();
  const nodeGroup = new THREE.Group();
  const edgeGroup = new THREE.Group();
  const boltGroup = new THREE.Group();
  const pulseGroup = new THREE.Group();
  worldGroup.add(nebulaGroup, edgeGroup, boltGroup, pulseGroup, nodeGroup);
  scene.add(worldGroup);

  // Subtle ambient + dynamic point lights for crystalline 3D shading
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
  const coreLight = new THREE.PointLight(palette.accent, 2.8, 520, 1.2);
  coreLight.position.set(0, 20, 0);
  const rimLight = new THREE.PointLight(palette.accent2, 2.2, 520, 1.2);
  rimLight.position.set(120, -60, 140);
  scene.add(ambientLight, coreLight, rimLight);

  const glowTex = makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.2, 'rgba(255,255,255,0.72)'],
    [0.5, 'rgba(255,255,255,0.18)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const ringTex = makeRadialTexture([
    [0, 'rgba(255,255,255,0)'],
    [0.62, 'rgba(255,255,255,0)'],
    [0.74, 'rgba(255,255,255,0.95)'],
    [0.86, 'rgba(255,255,255,0.4)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const nebulaTex = makeNebulaTexture();

  // Deep starfield + dynamic warp dust streaks
  const BG_COUNT = 2600;
  const bgPos = new Float32Array(BG_COUNT * 3);
  const bgCols = new Float32Array(BG_COUNT * 3);
  for (let i = 0; i < BG_COUNT; i++) {
    const r = 340 + Math.random() * 680;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    bgPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    bgPos[i * 3 + 1] = r * Math.cos(phi);
    bgPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    const tint = i % 5 === 0 ? palette.accent : i % 7 === 0 ? palette.accent2 : new THREE.Color(0xffffff);
    const dim = 0.45 + Math.random() * 0.55;
    bgCols[i * 3] = tint.r * dim;
    bgCols[i * 3 + 1] = tint.g * dim;
    bgCols[i * 3 + 2] = tint.b * dim;
  }
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute('position', new THREE.BufferAttribute(bgPos, 3));
  bgGeo.setAttribute('color', new THREE.BufferAttribute(bgCols, 3));
  const bgMat = new THREE.PointsMaterial({ size: 2.2, map: glowTex, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const bgStars = new THREE.Points(bgGeo, bgMat);
  scene.add(bgStars);

  // Foreground cosmic warp dust particles (move cleanly relative to camera motion!)
  const DUST_COUNT = 520;
  const dustPos = new Float32Array(DUST_COUNT * 3);
  for (let i = 0; i < DUST_COUNT; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 380;
    dustPos[i * 3 + 1] = (Math.random() - 0.5) * 280;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 380;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ size: 1.5, map: glowTex, color: 0xffffff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const dustPoints = new THREE.Points(dustGeo, dustMat);
  scene.add(dustPoints);

  // Shared 3D Geometries for fast instanced-like 60FPS rendering
  const GEO_STAR = new THREE.SphereGeometry(1.75, 18, 14);
  const GEO_PERSON = new THREE.OctahedronGeometry(1.6, 0);
  const GEO_THEME = new THREE.IcosahedronGeometry(1.9, 0);
  const GEO_SOURCE = new THREE.DodecahedronGeometry(1.75, 0);
  const GEO_RING = new THREE.RingGeometry(2.35, 2.85, 32);

  // Selection shockwave + target reticle ring
  const reticleMat = new THREE.SpriteMaterial({ map: ringTex, color: palette.accent2, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  const reticle = new THREE.Sprite(reticleMat);
  reticle.scale.set(12, 12, 1);
  reticle.visible = false;
  nodeGroup.add(reticle);

  const shockMat = new THREE.SpriteMaterial({ map: ringTex, color: palette.person, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const shockRing = new THREE.Sprite(shockMat);
  shockRing.visible = false;
  nodeGroup.add(shockRing);
  let shockAge = 99;

  // Dynamic Graph State
  const graph = {
    nodes: [],
    edges: [],
    clusters: [],
    byKey: new Map(),
    adj: new Map(), // key -> Set of neighbor keys
    edgeLines: null,
    edgeColorsAttr: null,
    pulsePoints: null,
    pulsePositions: null,
    pulseSeeds: [],
    activeBolts: [], // ephemeral lightning expansion arcs
  };

  let breadcrumbs = [];
  let selectedKey = null;
  let hoveredKey = null;
  let darkMatter = false;
  let autoOrbit = false;
  let autoDive = true;
  let povMode = true;
  let diveToken = 0;
  let wikiToken = 0;
  let wikiAbort = null;
  const wikiMem = new Map();
  let currentMode = 'taste';
  let paused = false;
  let rafId = 0;

  // Camera Kinematics (Smooth Yaw / Pitch / Roll + Velocity + Autopilot Target)
  const camState = {
    yaw: 0,
    pitch: -0.22,
    roll: 0,
    targetYaw: 0,
    targetPitch: -0.22,
    targetRoll: 0,
    vel: new THREE.Vector3(),
    warpTargetPos: null,
    warpLookAt: null,
    orbitCenter: new THREE.Vector3(0, 0, 0),
  };

  const keysDown = new Set();
  let pinchUsedInGesture = false;
  const labelPool = [];
  for (let i = 0; i < 28; i++) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'gb-label';
    el.style.display = 'none';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pinchUsedInGesture) return;
      const k = el.dataset.key;
      if (k) handleNodeClick(k);
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const k = el.dataset.key;
      if (!k || autoDive) return;
      const nd = graph.byKey.get(k);
      if (nd && !nd.seed) diveToNode(nd);
    });
    labelsLayer.appendChild(el);
    labelPool.push(el);
  }

  function resizeRenderer() {
    const rect = stage.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(320, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resizeRenderer);
  ro.observe(stage);
  resizeRenderer();

  function nodeColor(nd) {
    if (nd.seed) return palette.accent3.clone();
    if (nd.hidden) return new THREE.Color('#64748b');
    if (nd.kind === 'source') return palette.source.clone();
    if (nd.kind === 'person') return palette.person.clone();
    if (nd.kind === 'theme') return palette.accent.clone();
    if (nd.favorite || nd.loved) return palette.accent3.clone();
    if (nd.tracked) return palette.ok.clone();
    return palette.accent2.clone().lerp(palette.accent, 0.35);
  }

  function clearSceneGraph() {
    for (const child of [...nodeGroup.children]) {
      if (child !== reticle && child !== shockRing) {
        if (child.material && child.material.dispose) child.material.dispose();
        nodeGroup.remove(child);
      }
    }
    for (const child of [...edgeGroup.children]) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      edgeGroup.remove(child);
    }
    for (const child of [...nebulaGroup.children]) {
      if (child.material) child.material.dispose();
      nebulaGroup.remove(child);
    }
    for (const child of [...pulseGroup.children]) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      pulseGroup.remove(child);
    }
    for (const b of graph.activeBolts) {
      b.line.geometry.dispose();
      b.line.material.dispose();
      boltGroup.remove(b.line);
    }
    graph.nodes = [];
    graph.edges = [];
    graph.clusters = [];
    graph.byKey.clear();
    graph.adj.clear();
    graph.activeBolts = [];
    graph.edgeLines = null;
    graph.pulsePoints = null;
    reticle.visible = false;
  }

  function addNodeMesh(nd, startTiny = false) {
    const col = nodeColor(nd);
    const geo = nd.kind === 'person' ? GEO_PERSON : nd.kind === 'theme' ? GEO_THEME : nd.kind === 'source' ? GEO_SOURCE : GEO_STAR;
    const mat = new THREE.MeshStandardMaterial({
      color: col,
      emissive: col,
      emissiveIntensity: nd.hidden ? 0.25 : nd.seed ? 1.15 : 0.72,
      roughness: 0.25,
      metalness: 0.15,
      transparent: Boolean(nd.hidden || nd.seed),
      opacity: nd.hidden ? 0.38 : nd.seed ? 0.28 : 1,
      depthWrite: !nd.seed,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const baseScale = (nd.size || 1) * (nd.kind === 'theme' ? 1.1 : 1.0);
    mesh.position.set(nd.x, nd.y, nd.z);
    mesh.scale.setScalar(startTiny ? 0.01 : baseScale);
    mesh.userData = { nodeKey: nd.key, baseScale, targetScale: baseScale, phase: Math.random() * 6.28 };

    // Additive glow aura sprite attached cleanly inside mesh!
    const auraMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: col,
      transparent: true,
      opacity: nd.hidden ? 0.15 : 0.56,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const aura = new THREE.Sprite(auraMat);
    const auraScale = nd.kind === 'theme' ? 11 : nd.kind === 'source' ? 10.5 : nd.seed ? 13 : 8.5;
    aura.scale.set(auraScale, auraScale, 1);
    mesh.add(aura);
    mesh.userData.aura = aura;

    // Emerald ring indicator for Watched / Seen items, Golden tilted orbit ring for Favorites
    if (nd.seen || nd.favorite || nd.seed) {
      const rMat = new THREE.MeshBasicMaterial({
        color: nd.seen && !nd.favorite ? palette.ok : palette.accent3,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: nd.seed ? 0.55 : 0.75,
        depthWrite: !nd.seed,
      });
      const ring = new THREE.Mesh(GEO_RING, rMat);
      ring.rotation.x = Math.PI * 0.42;
      mesh.add(ring);
      mesh.userData.ring = ring;
    }

    nodeGroup.add(mesh);
    nd._mesh = mesh;
    return mesh;
  }

  function addNebulaCloud(cl, idx) {
    const tint = idx % 3 === 0 ? palette.accent : idx % 3 === 1 ? palette.accent2 : palette.person;
    for (let layer = 0; layer < 2; layer++) {
      const mat = new THREE.SpriteMaterial({
        map: nebulaTex,
        color: tint,
        transparent: true,
        opacity: layer === 0 ? 0.14 : 0.09,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sp = new THREE.Sprite(mat);
      const rad = (cl.radius || 46) * (layer === 0 ? 2.1 : 3.2);
      sp.scale.set(rad, rad * 0.72, 1);
      sp.position.set(cl.x + (layer ? 4 : -4), cl.y + (layer ? -2 : 2), cl.z);
      nebulaGroup.add(sp);
    }
  }

  function rebuildEdgesAndPulses() {
    for (const child of [...edgeGroup.children]) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      edgeGroup.remove(child);
    }
    for (const child of [...pulseGroup.children]) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
      pulseGroup.remove(child);
    }

    graph.adj.clear();
    const validEdges = [];
    for (const e of graph.edges) {
      const a = graph.byKey.get(e.source);
      const b = graph.byKey.get(e.target);
      if (!a || !b) continue;
      validEdges.push({ ...e, a, b });
      if (!graph.adj.has(a.key)) graph.adj.set(a.key, new Set());
      if (!graph.adj.has(b.key)) graph.adj.set(b.key, new Set());
      graph.adj.get(a.key).add(b.key);
      graph.adj.get(b.key).add(a.key);
    }
    if (!validEdges.length) return;

    const pos = new Float32Array(validEdges.length * 6);
    const cols = new Float32Array(validEdges.length * 6);
    for (let i = 0; i < validEdges.length; i++) {
      const { a, b } = validEdges[i];
      pos[i * 6] = a.x;
      pos[i * 6 + 1] = a.y;
      pos[i * 6 + 2] = a.z;
      pos[i * 6 + 3] = b.x;
      pos[i * 6 + 4] = b.y;
      pos[i * 6 + 5] = b.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const colAttr = new THREE.BufferAttribute(cols, 3);
    geo.setAttribute('color', colAttr);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, blending: THREE.AdditiveBlending, depthWrite: false });
    const lines = new THREE.LineSegments(geo, mat);
    edgeGroup.add(lines);
    graph.edgeLines = lines;
    graph.edgeColorsAttr = colAttr;
    graph._validEdges = validEdges;

    // Traveling glowing pulse particles gliding cleanly along filaments!
    const pCount = Math.min(180, Math.max(24, validEdges.length));
    const pPos = new Float32Array(pCount * 3);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ size: 2.3, map: glowTex, color: palette.person, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(pGeo, pMat);
    pulseGroup.add(pts);
    graph.pulsePoints = pts;
    graph.pulsePositions = pPos;
    graph.pulseSeeds = Array.from({ length: pCount }, (_, i) => ({
      edgeIdx: i % validEdges.length,
      t: Math.random(),
      speed: 0.18 + Math.random() * 0.34,
    }));

    updateEdgeColors();
  }

  function updateEdgeColors() {
    if (!graph.edgeColorsAttr || !graph._validEdges) return;
    const cols = graph.edgeColorsAttr.array;
    const focus = hoveredKey || selectedKey;
    const baseC = palette.accent;
    const hiPerson = palette.person;
    const hiGold = palette.accent3;
    const hiSource = palette.source;

    for (let i = 0; i < graph._validEdges.length; i++) {
      const e = graph._validEdges[i];
      const active = focus && (e.source === focus || e.target === focus);
      const dimmed = Boolean(focus && !active);
      const relColor =
        e.rel === 'creator'
          ? hiGold
          : e.rel === 'adapted' || e.rel === 'author'
          ? hiSource
          : e.rel === 'composer' || e.rel === 'cast' || e.rel === 'cowatch'
          ? hiPerson
          : baseC;
      const c = active ? relColor : e.rel === 'adapted' || e.rel === 'author' ? hiSource : baseC;
      const mul = active ? 1.25 : dimmed ? 0.14 : 0.34;
      cols[i * 6] = c.r * mul;
      cols[i * 6 + 1] = c.g * mul;
      cols[i * 6 + 2] = c.b * mul;
      cols[i * 6 + 3] = c.r * mul;
      cols[i * 6 + 4] = c.g * mul;
      cols[i * 6 + 5] = c.b * mul;
    }
    graph.edgeColorsAttr.needsUpdate = true;
  }

  /** Trigger electric Graxobolt arc flashes from parent star out to newly spawned nodes! */
  function fireLightningBolts(fromPos, targets) {
    for (const tgt of targets.slice(0, 14)) {
      const segs = 7;
      const pts = new Float32Array((segs + 1) * 3);
      for (let s = 0; s <= segs; s++) {
        const f = s / segs;
        const j = s === 0 || s === segs ? 0 : Math.sin(f * Math.PI) * 5.2;
        pts[s * 3] = fromPos.x + (tgt.x - fromPos.x) * f + (Math.random() - 0.5) * j;
        pts[s * 3 + 1] = fromPos.y + (tgt.y - fromPos.y) * f + (Math.random() - 0.5) * j;
        pts[s * 3 + 2] = fromPos.z + (tgt.z - fromPos.z) * f + (Math.random() - 0.5) * j;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      const mat = new THREE.LineBasicMaterial({ color: palette.person, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending });
      const line = new THREE.Line(geo, mat);
      boltGroup.add(line);
      graph.activeBolts.push({ line, age: 0, life: 0.72 });
    }
  }

  function triggerShockwave(pos, color) {
    shockRing.position.set(pos.x, pos.y, pos.z);
    shockMat.color.copy(color || palette.person);
    shockRing.visible = true;
    shockRing.scale.set(2, 2, 1);
    shockAge = 0;
  }

  function setGraphData(data, pushBreadcrumb = null) {
    clearSceneGraph();
    currentMode = data.mode || 'taste';
    graph.nodes = data.nodes || [];
    graph.edges = data.edges || [];
    graph.clusters = data.clusters || [];
    for (const nd of graph.nodes) {
      graph.byKey.set(nd.key, nd);
      addNodeMesh(nd, true);
    }
    graph.clusters.forEach((cl, idx) => addNebulaCloud(cl, idx));
    rebuildEdgesAndPulses();

    container.querySelector('#gbSeedTitle').textContent = data.title || 'Taste Nebula';
    if (pushBreadcrumb) {
      breadcrumbs = breadcrumbs.filter((b) => b.label !== pushBreadcrumb.label).concat([pushBreadcrumb]).slice(-6);
    } else if (currentMode === 'taste') {
      breadcrumbs = [{ label: 'Taste Nebula', mode: 'taste' }];
    }
    renderBreadcrumbs();
    updateStatsPill();

    // Auto-focus seed star cleanly (POV cockpit facing outward, or Constellation Overview)
    const seedNode = graph.nodes.find((n) => n.seed);
    if (seedNode) {
      selectNode(seedNode.key, false);
      resetCamera(false, true);
    } else {
      wikiAbort?.abort();
      selectedKey = null;
      inspector.hidden = true;
      resetCamera(false, false);
    }
  }

  function setCameraPov(snapApproach = false, playAudio = true) {
    if (snapApproach) {
      camera.position.set(0, 1.0, 2);
      camState.vel.set(0, 0, 0);
      camState.yaw = 0;
      camState.pitch = 0.01;
      camState.roll = 0;
    }
    camState.orbitCenter.set(0, 0, -72);
    camState.warpTargetPos = new THREE.Vector3(0, 0.8, -5);
    camState.warpLookAt = new THREE.Vector3(0, 0, -90);
    camState.targetYaw = 0;
    camState.targetPitch = 0.01;
    camState.targetRoll = 0;
    if (playAudio) sound.playWarp();
  }

  function warpCameraTo(targetVec, distance = 58, playAudio = true) {
    camState.orbitCenter.copy(targetVec);
    SCRATCH_V1.set(0, 0.24, 1).normalize();
    camState.warpTargetPos = targetVec.clone().addScaledVector(SCRATCH_V1, distance);
    camState.warpLookAt = targetVec.clone();
    // Smoothly orient look angles toward target
    SCRATCH_V2.subVectors(targetVec, camState.warpTargetPos).normalize();
    camState.targetYaw = Math.atan2(-SCRATCH_V2.x, -SCRATCH_V2.z);
    camState.targetPitch = Math.asin(Math.max(-0.92, Math.min(0.92, SCRATCH_V2.y)));
    camState.targetRoll = 0;
    if (playAudio) sound.playWarp();
  }

  function seedParamsForNode(nd) {
    return {
      seedKind: nd.kind || 'show',
      seedId: nd.tvmazeId || nd.tmdbId || nd.tvmazePersonId || null,
      seedTmdbId: nd.tmdbId || nd.tmdbPersonId || null,
      seedKeywordId: nd.tmdbKeywordId || null,
      seedQid: nd.qid || null,
      seedWikiTitle: nd.wikiTitle || null,
      seedName: nd.name,
      imdbId: nd.imdbId || null,
    };
  }

  async function diveToNode(nd) {
    if (!nd) return;
    if (nd.seed) {
      resetCamera();
      return;
    }
    sound.ensureCtx();
    const token = ++diveToken;
    sound.playWarp();
    triggerShockwave(nd, nodeColor(nd));
    const targetVec = new THREE.Vector3(nd.x, nd.y, nd.z);
    SCRATCH_V1.subVectors(targetVec, camera.position);
    const dist = SCRATCH_V1.length();
    if (dist > 1) {
      SCRATCH_V2.copy(SCRATCH_V1).normalize();
      camState.targetYaw = Math.atan2(-SCRATCH_V2.x, -SCRATCH_V2.z);
      camState.targetPitch = Math.asin(Math.max(-0.92, Math.min(0.92, SCRATCH_V2.y)));
      camState.targetRoll = 0;
      const plungeDist = Math.max(4, Math.min(12, dist * 0.16));
      camState.warpTargetPos = targetVec.clone().addScaledVector(SCRATCH_V2, -plungeDist);
      camState.warpLookAt = targetVec;
    }
    await loadSeed(seedParamsForNode(nd), { minPlungeMs: 260, token });
  }

  function handleNodeClick(key) {
    sound.ensureCtx();
    const nd = graph.byKey.get(key);
    if (!nd) return;
    if (nd.seed) {
      selectNode(key, false);
      return;
    }
    if (autoDive) diveToNode(nd);
    else selectNode(key, true);
  }

  function selectNode(key, shouldWarp = true) {
    const nd = graph.byKey.get(key);
    if (!nd) return;
    selectedKey = key;
    reticle.visible = true;
    reticle.position.set(nd.x, nd.y, nd.z);
    updateEdgeColors();
    renderInspector(nd);
    triggerShockwave(nd, nodeColor(nd));
    if (shouldWarp) {
      sound.playWarp();
      const targetPos = new THREE.Vector3(nd.x, nd.y, nd.z);
      camState.orbitCenter.copy(targetPos);
      // Approach cleanly along current sightline so flight feels natural & non-dizzy!
      SCRATCH_V1.subVectors(camera.position, targetPos);
      const curD = SCRATCH_V1.length();
      if (curD < 1) SCRATCH_V1.set(0, 0.3, 1);
      SCRATCH_V1.normalize();
      const approachD = Math.min(Math.max(26, curD * 0.48), 54);
      camState.warpTargetPos = targetPos.clone().addScaledVector(SCRATCH_V1, approachD);
      camState.warpLookAt = targetPos.clone();
    } else {
      sound.playSelect();
    }
  }

  async function expandSelectedNode(key, { includeWiki = false } = {}) {
    const nd = graph.byKey.get(key);
    if (!nd) return;
    const expandBtn = inspector.querySelector('#gbExpandBtn');
    if (expandBtn && !includeWiki) {
      expandBtn.disabled = true;
      expandBtn.textContent = 'Expanding…';
    }
    try {
      const res = await api('/api/galaxy/expand', {
        method: 'POST',
        body: JSON.stringify({
          includeWiki,
          node: {
            key: nd.key,
            kind: nd.kind,
            name: nd.name,
            tvmazeId: nd.tvmazeId,
            tmdbId: nd.tmdbId,
            imdbId: nd.imdbId,
            qid: nd.qid,
            wikiTitle: nd.wikiTitle,
            tvmazePersonId: nd.tvmazePersonId,
            tmdbPersonId: nd.tmdbPersonId,
            tmdbKeywordId: nd.tmdbKeywordId,
            premiered: nd.premiered,
            role: nd.role,
            x: nd.x,
            y: nd.y,
            z: nd.z,
          },
          existingKeys: [...graph.byKey.keys()],
        }),
      });
      const added = res.newNodes || [];
      if (!added.length && !(res.newEdges || []).length) {
        toast('No additional unmapped links returned for this star', 'ok');
        return;
      }
      for (const n of added) {
        if (!graph.byKey.has(n.key)) {
          graph.nodes.push(n);
          graph.byKey.set(n.key, n);
          addNodeMesh(n, true);
        }
      }
      for (const e of res.newEdges || []) graph.edges.push(e);
      for (const cl of res.clusters || []) addNebulaCloud(cl, graph.clusters.length + 1);
      rebuildEdgesAndPulses();
      fireLightningBolts(nd, added);
      triggerShockwave(nd, includeWiki ? palette.source : palette.person);
      warpCameraTo(new THREE.Vector3(nd.x, nd.y, nd.z), 96, false);
      sound.playBoltExpand();
      updateStatsPill();
      breadcrumbs = breadcrumbs.filter((b) => b.key !== nd.key).concat([{ label: nd.name, key: nd.key, kind: nd.kind, seed: seedParamsForNode(nd) }]).slice(-6);
      renderBreadcrumbs();
      toast(`⚡ Bloomed +${added.length} new stars from ${nd.name}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      if (graph.byKey.has(key)) renderInspector(graph.byKey.get(key));
    }
  }

  function renderWikiLore(nd, box, dossier) {
    if (!box) return;
    if (!dossier || !dossier.found) {
      box.innerHTML = `<div class="gb-wiki-empty">W No matching Wikipedia lore cached</div>`;
      return;
    }
    if (dossier.qid && !nd.qid) nd.qid = dossier.qid;
    if (dossier.wikiTitle && !nd.wikiTitle) nd.wikiTitle = dossier.wikiTitle;
    if (dossier.thumbnail && !nd.poster && !nd.image) {
      nd.image = dossier.thumbnail;
      const ph = inspector.querySelector('#gbInsPh');
      if (ph) {
        const img = document.createElement('img');
        img.className = 'gb-ins-img';
        img.src = dossier.thumbnail;
        img.alt = '';
        ph.replaceWith(img);
      }
    }

    const lifeStr = dossier.birthYear ? `${dossier.birthYear}${dossier.deathYear ? `–${dossier.deathYear}` : '–present'}` : '';
    const facts = [];
    if (nd.kind === 'person' && (lifeStr || dossier.birthPlace || (dossier.occupations && dossier.occupations.length))) {
      facts.push([lifeStr, dossier.birthPlace, (dossier.occupations || []).slice(0, 2).join(', ')].filter(Boolean).join(' · '));
    }
    if (nd.kind === 'source' && (dossier.pubYear || (dossier.sourceGenres && dossier.sourceGenres.length))) {
      facts.push([dossier.pubYear ? `Published ${dossier.pubYear}` : '', (dossier.sourceGenres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · '));
    }

    const chipBtn = (cls, icon, label, seedPayload) =>
      `<button type="button" class="gb-wiki-chip ${cls}" data-wiki-seed='${esc(JSON.stringify(seedPayload))}'>${icon} ${esc(label)}</button>`;

    const linkChips = [];
    for (const b of (dossier.basedOn || []).slice(0, 3)) {
      linkChips.push(chipBtn('source', '📖', b.name, { seedKind: 'source', seedQid: b.qid, seedName: b.name }));
    }
    for (const a of (dossier.authors || []).slice(0, 2)) {
      linkChips.push(chipBtn('person', '✍️', a.name, { seedKind: 'person', seedQid: a.qid, seedName: a.name }));
    }
    for (const c of (dossier.composers || []).slice(0, 2)) {
      linkChips.push(chipBtn('person', '🎵', c.name, { seedKind: 'person', seedQid: c.qid, seedName: c.name }));
    }

    const hasGraphableLinks =
      (nd.kind === 'show' || nd.kind === 'movie') &&
      ((dossier.basedOn || []).some((b) => !graph.byKey.has(b.qid ? `source:${b.qid}` : `source:${b.name.toLowerCase()}`)) ||
        (dossier.authors || []).some((a) => !graph.byKey.has(`person:${a.name.toLowerCase()}`)) ||
        (dossier.composers || []).some((c) => !graph.byKey.has(`person:${c.name.toLowerCase()}`)));

    const awardsHtml = (dossier.awards || []).length
      ? `<div class="gb-wiki-row"><span class="gb-wiki-lbl">Awards</span><div class="gb-wiki-tags">${dossier.awards
          .slice(0, 3)
          .map((a) => `<span class="gb-wiki-tag award" title="${esc(a)}">🏆 ${esc(a)}</span>`)
          .join('')}${dossier.awardsTotal > 3 ? `<span class="gb-wiki-tag">+${dossier.awardsTotal - 3}</span>` : ''}</div></div>`
      : '';
    const locParts = [
      ...(dossier.filmingLocations || []).slice(0, 2).map((l) => `📍 ${l}`),
      ...(dossier.locations || []).slice(0, 2).map((l) => `🌍 ${l}`),
      ...(dossier.movements || []).slice(0, 1).map((m) => `🎞️ ${m}`),
    ];
    const locHtml = locParts.length
      ? `<div class="gb-wiki-row"><span class="gb-wiki-lbl">Context</span><div class="gb-wiki-tags">${locParts
          .map((t) => `<span class="gb-wiki-tag">${esc(t)}</span>`)
          .join('')}</div></div>`
      : '';

    const extText = dossier.extract || dossier.description || '';
    const showExt = extText && (!nd.summary || nd.summary.trim() !== extText.trim());
    const longExt = Boolean(showExt && extText.length > 175);

    box.innerHTML = `
      <div class="gb-wiki-head">
        <span class="gb-wiki-mark" aria-hidden="true">W</span>
        ${dossier.wikiUrl ? `<a class="gb-wiki-link" href="${esc(dossier.wikiUrl)}" target="_blank" rel="noopener noreferrer">${esc(dossier.wikiTitle || nd.name)} ↗</a>` : `<span class="gb-wiki-link">${esc(dossier.wikiTitle || nd.name)}</span>`}
        <span class="gb-wiki-src">${dossier.fromCache ? 'Cached' : 'Wikipedia'}</span>
      </div>
      ${facts.length ? `<div class="gb-wiki-sub">${esc(facts.join(' · '))}</div>` : ''}
      ${showExt ? `<p class="gb-wiki-ext${longExt ? ' clamped' : ''}" id="gbWikiExt">${esc(extText)}</p>` : ''}
      ${longExt ? `<button type="button" class="gb-wiki-more" id="gbWikiMore">Read more</button>` : ''}
      ${linkChips.length ? `<div class="gb-wiki-row"><span class="gb-wiki-lbl">Lore Links</span><div class="gb-wiki-tags">${linkChips.join('')}</div></div>` : ''}
      ${awardsHtml}
      ${locHtml}
      ${hasGraphableLinks ? `<button type="button" class="btn btn-small gb-wiki-bloom" id="gbWikiBloomBtn">🌐 +Bloom Wiki Links</button>` : ''}`;

    box.querySelector('#gbWikiMore')?.addEventListener('click', (e) => {
      const p = box.querySelector('#gbWikiExt');
      if (!p) return;
      const open = p.classList.toggle('clamped');
      e.currentTarget.textContent = open ? 'Read more' : 'Show less';
    });
    box.querySelectorAll('[data-wiki-seed]').forEach((btn) =>
      btn.addEventListener('click', () => {
        try {
          loadSeed(JSON.parse(btn.dataset.wikiSeed));
        } catch {
          /* ignore */
        }
      })
    );
    box.querySelector('#gbWikiBloomBtn')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Blooming Wiki Links…';
      await expandSelectedNode(nd.key, { includeWiki: true });
    });
  }

  async function loadWikiForNode(nd, box) {
    if (!nd || !box) return;
    wikiAbort?.abort();
    const myTok = ++wikiToken;
    const memKey = `${nd.key}|${nd.qid || ''}|${nd.imdbId || ''}`;
    if (wikiMem.has(memKey)) {
      renderWikiLore(nd, box, wikiMem.get(memKey));
      return;
    }

    wikiAbort = new AbortController();
    box.innerHTML = `<div class="gb-wiki-loading"><span class="spinner" aria-hidden="true"></span><span>Fetching Wikipedia lore…</span></div>`;
    try {
      const qs = new URLSearchParams({
        kind: nd.kind || 'show',
        name: String(nd.name || '').replace(/\s*\(\d{4}\)$/, ''),
        ...(nd.premiered ? { year: String(nd.premiered).slice(0, 4) } : {}),
        ...(nd.imdbId ? { imdbId: nd.imdbId } : {}),
        ...(nd.qid ? { qid: nd.qid } : {}),
        ...(nd.wikiTitle ? { wikiTitle: nd.wikiTitle } : {}),
        ...(nd.tvmazeId ? { tvmazeId: String(nd.tvmazeId) } : {}),
        ...(nd.tmdbId ? { tmdbId: String(nd.tmdbId) } : {}),
      });
      const res = await api(`/api/galaxy/wiki?${qs}`, { signal: wikiAbort.signal });
      if (myTok !== wikiToken || selectedKey !== nd.key || paused) return;
      if (wikiMem.size >= 40) {
        const firstKey = wikiMem.keys().next().value;
        if (firstKey !== undefined) wikiMem.delete(firstKey);
      }
      wikiMem.set(memKey, res);
      renderWikiLore(nd, box, res);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (myTok === wikiToken && selectedKey === nd.key && box) {
        box.innerHTML = `<div class="gb-wiki-empty">W Wikipedia lookup skipped</div>`;
      }
    }
  }

  function renderInspector(nd) {
    inspector.hidden = false;
    const isMedia = nd.kind === 'show' || nd.kind === 'movie';
    const typeLabel = nd.kind === 'person' ? (nd.role || 'Creator / Cast') : nd.kind === 'theme' ? 'Theme Nebula' : nd.kind === 'source' ? 'Source Work' : nd.kind === 'movie' ? 'Movie' : 'Series';
    const imgSrc = nd.poster || nd.image || null;
    inspector.innerHTML = `
      <div class="gb-ins-head">
        ${imgSrc ? `<img class="gb-ins-img" src="${esc(imgSrc)}" alt="" />` : `<div class="gb-ins-ph" id="gbInsPh">${nd.kind === 'person' ? '👤' : nd.kind === 'theme' ? '🌌' : nd.kind === 'source' ? '📖' : '✦'}</div>`}
        <div style="min-width:0;flex:1">
          <div class="gb-ins-badges">
            <span class="gb-type-tag ${esc(nd.kind)}">${esc(typeLabel)}</span>
            ${nd.matchPct ? `<span class="disc-match-pill">${nd.matchPct}% Match</span>` : ''}
            ${nd.tracked ? '<span class="gb-state-tag ok">On Calendar</span>' : ''}
            ${nd.seen && !nd.tracked ? '<span class="gb-state-tag">Seen</span>' : ''}
          </div>
          <h3 class="gb-ins-title">${esc(nd.name)}</h3>
          <div class="gb-ins-meta">
            ${nd.premiered ? `<span>${esc(String(nd.premiered).slice(0, 4))}</span>` : ''}
            ${nd.channelName ? `<span>· ${esc(nd.channelName)}</span>` : ''}
            ${nd.rating ? `<span>· ★ ${nd.rating}</span>` : ''}
          </div>
        </div>
        <button id="gbInsClose" class="icon-btn" type="button" aria-label="Close inspector" style="width:28px;height:28px">×</button>
      </div>
      ${
        (nd.reasons || []).length
          ? `<div class="disc-reasons" style="margin:6px 0">${nd.reasons.slice(0, 2).map((r) => `<div class="disc-reason">${esc(r)}</div>`).join('')}</div>`
          : ''
      }
      ${nd.summary ? `<p class="gb-ins-sum">${esc(nd.summary)}</p>` : ''}
      <div class="gb-ins-actions">
        <button id="gbExpandBtn" class="btn btn-small" type="button">⚡ Expand (+1 Hop)</button>
        <button id="gbCenterBtn" class="btn btn-small btn-ghost" type="button" title="${nd.seed ? 'Refocus Seed POV camera' : `Dive & re-seed galaxy into ${esc(nd.name)} POV`}">${nd.seed ? '👁 Re-Center POV' : '🚀 Enter Seed POV'}</button>
      </div>
      ${
        isMedia
          ? `<div class="gb-ins-media-acts">
              ${!nd.tracked ? '<button type="button" class="disc-act-btn primary" data-gb-act="track">+ Calendar</button>' : ''}
              ${nd.kind === 'show' ? `<button type="button" class="disc-act-btn dc${nd.directorsChoice ? ' on' : ''}" data-gb-act="dc" title="Virtual Release starting Today (shifts S01E01 to today)">🎬 ${nd.directorsChoice ? 'DC On' : "Director's Choice"}</button>` : ''}
              <button type="button" class="disc-act-btn love" data-gb-act="liked">${nd.loved ? '♥ Loved' : '♥ Love'}</button>
              <button type="button" class="disc-act-btn seen" data-gb-act="seen">✓ Seen</button>
              <button type="button" class="disc-act-btn nope" data-gb-act="dislike">× Hide</button>
              <button type="button" class="disc-act-btn" id="gbModalBtn">Details</button>
            </div>`
          : ''
      }
      <div class="gb-wiki-box" id="gbWikiBox"></div>`;

    inspector.querySelector('#gbInsClose').addEventListener('click', () => {
      wikiAbort?.abort();
      inspector.hidden = true;
      selectedKey = null;
      reticle.visible = false;
      updateEdgeColors();
    });
    loadWikiForNode(nd, inspector.querySelector('#gbWikiBox'));
    inspector.querySelector('#gbExpandBtn').addEventListener('click', () => expandSelectedNode(nd.key));
    inspector.querySelector('#gbCenterBtn').addEventListener('click', () => diveToNode(nd));
    inspector.querySelector('#gbModalBtn')?.addEventListener('click', () => {
      if (onOpenModal) onOpenModal(nd);
    });
    inspector.querySelectorAll('[data-gb-act]').forEach((b) =>
      b.addEventListener('click', async () => {
        const action = b.dataset.gbAct;
        b.disabled = true;
        const ok = await onFeedback({
          kind: nd.kind,
          id: nd.tvmazeId || nd.tmdbId,
          tvmazeId: nd.tvmazeId,
          tmdbId: nd.tmdbId,
          imdbId: nd.imdbId,
          action,
          item: nd,
        });
        if (ok) {
          sound.playConfirm();
          if (action === 'track') nd.tracked = true;
          else if (action === 'dc') {
            nd.directorsChoice = typeof ok === 'object' && 'enabled' in ok ? Boolean(ok.enabled) : !nd.directorsChoice;
            if (nd.directorsChoice) nd.tracked = true;
          } else if (action === 'liked') nd.loved = true;
          else if (action === 'seen') nd.seen = true;
          else if (action === 'dislike') {
            nd.hidden = true;
            inspector.hidden = true;
          }
          if (nd._mesh) {
            nodeGroup.remove(nd._mesh);
            addNodeMesh(nd, false);
          }
          if (!nd.hidden) renderInspector(nd);
        } else {
          b.disabled = false;
        }
      })
    );
  }

  function renderBreadcrumbs() {
    const bar = container.querySelector('#gbBreadcrumbs');
    if (!bar) return;
    if (!breadcrumbs.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.innerHTML = breadcrumbs
      .map(
        (b, i) =>
          `${i > 0 ? '<span class="gb-bc-sep">➔</span>' : ''}<button type="button" class="gb-bc-btn" data-bc-idx="${i}">${esc(b.label)}</button>`
      )
      .join('');
    bar.querySelectorAll('.gb-bc-btn').forEach((btn) =>
      btn.addEventListener('click', () => {
        const b = breadcrumbs[Number(btn.dataset.bcIdx)];
        if (!b) return;
        const curSeed = graph.nodes.find((n) => n.seed);
        if (b.mode === 'taste') loadTaste();
        else if (b.key && curSeed && curSeed.key === b.key) diveToNode(curSeed);
        else if (b.key && graph.byKey.has(b.key)) selectNode(b.key, true);
        else if (b.seed) loadSeed(b.seed);
      })
    );
  }

  let fpsFrames = 0;
  let fpsTimer = performance.now();
  let lastFps = 60;
  function updateStatsPill() {
    const el = container.querySelector('#gbStatsPill');
    if (el) el.textContent = `${lastFps} FPS · ${graph.nodes.length} Stars · ${graph.edges.length} Synapses`;
  }

  async function loadTaste() {
    const myToken = ++diveToken;
    loadingBox.hidden = false;
    container.querySelector('#gbLoadingText').textContent = 'Constructing Taste Nebula…';
    try {
      const qs = darkMatter ? '?darkMatter=1' : '';
      const data = await api(`/api/galaxy${qs}`);
      if (myToken !== diveToken || paused) return;
      setGraphData(data);
    } catch (err) {
      if (myToken === diveToken) toast(err.message, 'err');
    } finally {
      if (myToken === diveToken) loadingBox.hidden = true;
    }
  }

  async function loadSeed(
    { seedKind = 'show', seedId = null, seedTmdbId = null, seedKeywordId = null, seedQid = null, seedWikiTitle = null, seedName = '', imdbId = null } = {},
    { minPlungeMs = 0, token = null } = {}
  ) {
    const myToken = token ?? ++diveToken;
    if (minPlungeMs === 0) sound.playWarp();
    container.querySelector('#gbLoadingText').textContent = `Warping to ${seedName || 'target'} constellation…`;
    const loadTimer = setTimeout(() => {
      if (myToken === diveToken) loadingBox.hidden = false;
    }, 220);
    try {
      const qs = new URLSearchParams({
        seedKind,
        ...(seedId ? { seedId: String(seedId) } : {}),
        ...(seedTmdbId ? { seedTmdbId: String(seedTmdbId) } : {}),
        ...(seedKeywordId ? { seedKeywordId: String(seedKeywordId) } : {}),
        ...(seedQid ? { seedQid } : {}),
        ...(seedWikiTitle ? { seedWikiTitle } : {}),
        ...(seedName ? { seedName } : {}),
        ...(imdbId ? { imdbId } : {}),
      });
      const req = api(`/api/galaxy?${qs}`);
      const [data] = minPlungeMs > 0
        ? await Promise.all([req, new Promise((r) => setTimeout(r, minPlungeMs))])
        : [await req];
      if (myToken !== diveToken || paused) return;
      setGraphData(data, {
        label: data.title || seedName,
        key: data.seedKey,
        seed: { seedKind, seedId, seedTmdbId, seedKeywordId, seedQid, seedWikiTitle, seedName, imdbId },
      });
    } catch (err) {
      if (myToken === diveToken) toast(err.message, 'err');
    } finally {
      clearTimeout(loadTimer);
      if (myToken === diveToken) loadingBox.hidden = true;
    }
  }

  // ---------- Pointer / Raycast / 6DoF Drag / Mobile Pinch-Zoom / WASD Controls ----------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const activePointers = new Map(); // pointerId -> { x, y }
  let singleDrag = null; // { id, mode, lastX, lastY, moved }
  let gesturePinchDist = 0;
  let touchPinchDist = 0;

  function isInteractiveUi(target) {
    return Boolean(target && target.closest('.gb-hud-top, #gbBreadcrumbs, #gbInspector, #gbLoading, .gb-hud-controls'));
  }

  function applyPinchDolly(deltaPx) {
    if (!deltaPx || !Number.isFinite(deltaPx)) return;
    camState.warpTargetPos = null;
    SCRATCH_V1.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const minDim = Math.max(240, Math.min(stage.clientWidth || 390, stage.clientHeight || 600));
    const scale = Math.max(0.45, Math.min(1.4, 340 / minDim));
    camera.position.addScaledVector(SCRATCH_V1, deltaPx * scale * 0.55);
    camState.vel.addScaledVector(SCRATCH_V1, deltaPx * scale * 1.45);
  }

  function pickAtPointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const meshes = graph.nodes.map((n) => n._mesh).filter(Boolean);
    const hits = raycaster.intersectObjects(meshes, false);
    return hits[0] ? hits[0].object.userData.nodeKey : null;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    if (paused || isInteractiveUi(e.target)) return;
    sound.ensureCtx();
    camState.warpTargetPos = null; // Manual grip cancels autopilot cleanly
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.target === canvas) {
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    }

    if (activePointers.size === 1) {
      pinchUsedInGesture = false;
      gesturePinchDist = 0;
      singleDrag = {
        id: e.pointerId,
        mode: e.button === 2 || e.ctrlKey ? 'roll' : 'rotate',
        lastX: e.clientX,
        lastY: e.clientY,
        moved: 0,
      };
    } else if (activePointers.size >= 2) {
      singleDrag = null;
      pinchUsedInGesture = true;
      const pts = [...activePointers.values()];
      gesturePinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    }
  });

  const onPointerMove = (e) => {
    if (paused) return;
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activePointers.size >= 2) {
        const pts = [...activePointers.values()];
        const nextDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (gesturePinchDist > 0) applyPinchDolly(nextDist - gesturePinchDist);
        gesturePinchDist = nextDist;
        return;
      }
      if (singleDrag && singleDrag.id === e.pointerId) {
        const dx = e.clientX - singleDrag.lastX;
        const dy = e.clientY - singleDrag.lastY;
        singleDrag.moved += Math.abs(dx) + Math.abs(dy);
        singleDrag.lastX = e.clientX;
        singleDrag.lastY = e.clientY;
        if (singleDrag.mode === 'roll') {
          camState.targetRoll += dx * 0.0045;
        } else {
          camState.targetYaw += dx * 0.0042;
          camState.targetPitch = Math.max(-1.45, Math.min(1.45, camState.targetPitch + dy * 0.0042));
        }
        return;
      }
    }
    if (activePointers.size === 0 && e.target === canvas && e.pointerType !== 'touch') {
      const hitKey = pickAtPointer(e.clientX, e.clientY);
      if (hitKey !== hoveredKey) {
        hoveredKey = hitKey;
        canvas.style.cursor = hitKey ? 'pointer' : 'grab';
        updateEdgeColors();
        if (hitKey) {
          const nd = graph.byKey.get(hitKey);
          sound.playHover(((nd && nd.matchPct) || 75) / 100);
        }
      }
    }
  };

  const onPointerEnd = (e) => {
    if (!activePointers.has(e.pointerId)) return;
    const endedDrag = singleDrag && singleDrag.id === e.pointerId ? singleDrag : null;
    activePointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch {}

    if (activePointers.size >= 2) {
      const pts = [...activePointers.values()];
      gesturePinchDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      singleDrag = null;
      return;
    }
    if (activePointers.size === 1) {
      const [remId, remPt] = activePointers.entries().next().value;
      gesturePinchDist = 0;
      singleDrag = { id: remId, mode: 'rotate', lastX: remPt.x, lastY: remPt.y, moved: 999 };
      return;
    }

    singleDrag = null;
    gesturePinchDist = 0;
    if (!paused && e.type === 'pointerup' && !pinchUsedInGesture && endedDrag && endedDrag.moved < 6 && e.target === canvas) {
      const k = pickAtPointer(e.clientX, e.clientY);
      if (k) handleNodeClick(k);
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);

  canvas.addEventListener('dblclick', (e) => {
    if (autoDive) return;
    const k = pickAtPointer(e.clientX, e.clientY);
    if (k) {
      const nd = graph.byKey.get(k);
      if (nd && !nd.seed) diveToNode(nd);
    }
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      sound.ensureCtx();
      camState.warpTargetPos = null;
      SCRATCH_V1.set(0, 0, -1).applyQuaternion(camera.quaternion);
      camState.vel.addScaledVector(SCRATCH_V1, -e.deltaY * 0.08);
    },
    { passive: false }
  );

  // Safari gesture + non-pointer multi-touch pinch fallback
  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length >= 2 && !isInteractiveUi(e.target)) {
        e.preventDefault();
        pinchUsedInGesture = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchPinchDist = Math.hypot(dx, dy);
      }
    },
    { passive: false }
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length >= 2 && !isInteractiveUi(e.target)) {
        e.preventDefault();
        if (activePointers.size < 2 && touchPinchDist > 0) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const nextDist = Math.hypot(dx, dy);
          applyPinchDolly(nextDist - touchPinchDist);
          touchPinchDist = nextDist;
        }
      }
    },
    { passive: false }
  );
  const resetTouchPinch = (e) => {
    if (e.touches.length < 2) touchPinchDist = 0;
  };
  stage.addEventListener('touchend', resetTouchPinch, { passive: true });
  stage.addEventListener('touchcancel', resetTouchPinch, { passive: true });
  stage.addEventListener('gesturestart', (e) => e.preventDefault());
  stage.addEventListener('gesturechange', (e) => e.preventDefault());

  function resetCamera(playAudio = true, snapApproach = false) {
    camState.targetRoll = 0;
    if (currentMode === 'seed') {
      if (povMode) setCameraPov(snapApproach, playAudio);
      else warpCameraTo(new THREE.Vector3(0, 0, -48), 165, playAudio);
    } else {
      warpCameraTo(new THREE.Vector3(0, 0, 0), 220, playAudio);
    }
  }

  function togglePov() {
    povMode = !povMode;
    const pb = container.querySelector('#gbPovBtn');
    if (pb) {
      pb.classList.toggle('on', povMode);
      pb.setAttribute('aria-pressed', String(povMode));
    }
    if (currentMode === 'seed') resetCamera();
  }

  // Keyboard Flight Listeners (WASD + Q/E + Shift + R + V + Space)
  const onKeyDown = (e) => {
    if (paused) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      keysDown.add(k);
      if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) {
        sound.ensureCtx();
        camState.warpTargetPos = null;
      }
    } else if (k === 'r') {
      resetCamera();
    } else if (k === 'v') {
      togglePov();
    } else if (e.code === 'Space') {
      e.preventDefault();
      autoOrbit = !autoOrbit;
      const ob = container.querySelector('#gbOrbitBtn');
      if (ob) {
        ob.classList.toggle('on', autoOrbit);
        ob.setAttribute('aria-pressed', String(autoOrbit));
      }
    }
  };
  const onKeyUp = (e) => keysDown.delete(e.key.toLowerCase());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // HUD Button Wiring & Live Search
  container.querySelector('#gbTasteBtn').addEventListener('click', () => loadTaste());
  container.querySelector('#gbAutoDiveBtn').addEventListener('click', (e) => {
    autoDive = !autoDive;
    e.currentTarget.classList.toggle('on', autoDive);
    e.currentTarget.setAttribute('aria-pressed', String(autoDive));
  });
  container.querySelector('#gbPovBtn').addEventListener('click', () => togglePov());
  container.querySelector('#gbResetCamBtn').addEventListener('click', () => resetCamera());
  container.querySelector('#gbOrbitBtn').addEventListener('click', (e) => {
    autoOrbit = !autoOrbit;
    e.currentTarget.classList.toggle('on', autoOrbit);
    e.currentTarget.setAttribute('aria-pressed', String(autoOrbit));
  });
  container.querySelector('#gbDarkMatterBtn').addEventListener('click', (e) => {
    darkMatter = !darkMatter;
    e.currentTarget.classList.toggle('on', darkMatter);
    e.currentTarget.setAttribute('aria-pressed', String(darkMatter));
    if (currentMode === 'taste') loadTaste();
  });
  container.querySelector('#gbSoundBtn').addEventListener('click', (e) => {
    sound.setEnabled(!sound.enabled);
    e.currentTarget.textContent = sound.enabled ? '🔊 Audio' : '🔇 Muted';
    e.currentTarget.setAttribute('aria-pressed', String(sound.enabled));
    if (sound.enabled) sound.playSelect();
  });

  // Graxobolt Seed Search Dropdown
  const gbSearch = container.querySelector('#gbSearchInput');
  const gbDrop = container.querySelector('#gbSearchDrop');
  let searchDeb = 0;
  gbSearch.addEventListener('input', () => {
    clearTimeout(searchDeb);
    const q = gbSearch.value.trim();
    if (q.length < 2) {
      gbDrop.hidden = true;
      return;
    }
    searchDeb = setTimeout(async () => {
      try {
        const list = await api(`/api/galaxy/search?q=${encodeURIComponent(q)}`);
        if (!list.length) {
          gbDrop.innerHTML = '<div class="gb-sr-empty">No matching shows, movies, or people</div>';
        } else {
          gbDrop.innerHTML = list
            .map(
              (x, idx) => `
            <button type="button" class="gb-sr-item" data-idx="${idx}">
              ${x.poster ? `<img src="${esc(x.poster)}" alt="">` : `<span class="gb-sr-ph">${x.seedKind === 'person' ? '👤' : '✦'}</span>`}
              <span class="gb-sr-txt"><b>${esc(x.name)}</b><small>${esc(x.sub)}</small></span>
            </button>`
            )
            .join('');
          gbDrop.querySelectorAll('.gb-sr-item').forEach((btn) =>
            btn.addEventListener('click', () => {
              const item = list[Number(btn.dataset.idx)];
              gbDrop.hidden = true;
              gbSearch.value = '';
              if (item) loadSeed(item);
            })
          );
        }
        gbDrop.hidden = false;
      } catch {
        gbDrop.hidden = true;
      }
    }, 240);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.gb-search-wrap')) gbDrop.hidden = true;
  });

  // ---------- Main 60 FPS Render Loop ----------
  let prevTime = performance.now();
  function animate(now) {
    if (paused) return;
    rafId = requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0.001, (now - prevTime) / 1000));
    prevTime = now;

    // 1. Update Camera Rotation & Flight Velocity
    camState.yaw += (camState.targetYaw - camState.yaw) * Math.min(1, dt * 14);
    camState.pitch += (camState.targetPitch - camState.pitch) * Math.min(1, dt * 14);
    camState.roll += (camState.targetRoll - camState.roll) * Math.min(1, dt * 12);

    const euler = new THREE.Euler(camState.pitch, camState.yaw, camState.roll, 'YXZ');
    camera.quaternion.setFromEuler(euler);

    // WASD + Q/E thrust
    const shiftBoost = keysDown.has('shift') ? 3.1 : 1.0;
    const accel = 165 * shiftBoost;
    let manualThrust = false;
    SCRATCH_V1.set(0, 0, -1).applyQuaternion(camera.quaternion); // forward
    SCRATCH_V2.set(1, 0, 0).applyQuaternion(camera.quaternion); // right
    SCRATCH_V3.set(0, 1, 0).applyQuaternion(camera.quaternion); // up

    if (keysDown.has('w') || keysDown.has('arrowup')) { camState.vel.addScaledVector(SCRATCH_V1, accel * dt); manualThrust = true; }
    if (keysDown.has('s') || keysDown.has('arrowdown')) { camState.vel.addScaledVector(SCRATCH_V1, -accel * dt); manualThrust = true; }
    if (keysDown.has('d') || keysDown.has('arrowright')) { camState.vel.addScaledVector(SCRATCH_V2, accel * dt); manualThrust = true; }
    if (keysDown.has('a') || keysDown.has('arrowleft')) { camState.vel.addScaledVector(SCRATCH_V2, -accel * dt); manualThrust = true; }
    if (keysDown.has('e')) { camState.vel.addScaledVector(SCRATCH_V3, accel * dt); manualThrust = true; }
    if (keysDown.has('q')) { camState.vel.addScaledVector(SCRATCH_V3, -accel * dt); manualThrust = true; }

    if (camState.warpTargetPos && !manualThrust) {
      camera.position.lerp(camState.warpTargetPos, Math.min(1, dt * 4.5));
      if (camera.position.distanceTo(camState.warpTargetPos) < 0.8) {
        camState.warpTargetPos = null;
      }
    } else {
      camera.position.addScaledVector(camState.vel, dt);
      camState.vel.multiplyScalar(Math.pow(0.015, dt));
    }

    if (autoOrbit && activePointers.size === 0 && !touchPinchDist && !manualThrust && !camState.warpTargetPos) {
      camState.targetYaw += dt * 0.22;
      const offset = SCRATCH_V1.subVectors(camera.position, camState.orbitCenter);
      offset.applyAxisAngle(SCRATCH_V3.set(0, 1, 0), dt * 0.22);
      camera.position.copy(camState.orbitCenter).add(offset);
    }

    const camSpeed = camState.vel.length() + (camState.warpTargetPos ? 60 : 0);
    sound.setFlightIntensity(camSpeed / 140);

    // Dynamic FOV slight kick at warp speed!
    const targetFov = 62 + Math.min(14, camSpeed * 0.08);
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 8);
      camera.updateProjectionMatrix();
    }

    // Wrap foreground dust particles smoothly around camera for endless flight
    const dArr = dustGeo.attributes.position.array;
    for (let i = 0; i < DUST_COUNT; i++) {
      let x = dArr[i * 3] - camera.position.x;
      let y = dArr[i * 3 + 1] - camera.position.y;
      let z = dArr[i * 3 + 2] - camera.position.z;
      if (x > 190) dArr[i * 3] -= 380;
      else if (x < -190) dArr[i * 3] += 380;
      if (y > 140) dArr[i * 3 + 1] -= 280;
      else if (y < -140) dArr[i * 3 + 1] += 280;
      if (z > 190) dArr[i * 3 + 2] -= 380;
      else if (z < -190) dArr[i * 3 + 2] += 380;
    }
    dustGeo.attributes.position.needsUpdate = true;

    // 2. Animate Star Breathing & Newly Bloomed Growth
    const timeSec = now * 0.001;
    for (const nd of graph.nodes) {
      const m = nd._mesh;
      if (!m) continue;
      const ud = m.userData;
      const pulse = 1 + Math.sin(timeSec * 2.2 + ud.phase) * 0.06;
      const isFocus = nd.key === hoveredKey || nd.key === selectedKey ? 1.24 : 1.0;
      const cur = m.scale.x;
      const goal = ud.targetScale * pulse * isFocus;
      m.scale.setScalar(cur + (goal - cur) * Math.min(1, dt * 9));
      if (nd.seed) {
        const visFade = Math.min(1, Math.max(0.06, (camera.position.length() - 8) / 30));
        m.material.opacity = 0.28 * visFade;
        if (ud.aura) ud.aura.material.opacity = 0.56 * visFade;
        if (ud.ring) ud.ring.material.opacity = 0.55 * visFade;
      }
      if (nd.kind === 'person' || nd.kind === 'theme' || nd.kind === 'source') {
        m.rotation.y += dt * 0.65;
        m.rotation.x += dt * 0.25;
      }
    }

    // Reticle & Shockwave VFX
    if (reticle.visible) {
      reticle.material.rotation += dt * 1.4;
    }
    if (shockRing.visible) {
      shockAge += dt;
      if (shockAge > 0.7) {
        shockRing.visible = false;
      } else {
        const s = 3 + shockAge * 36;
        shockRing.scale.set(s, s, 1);
        shockMat.opacity = (1 - shockAge / 0.7) * 0.85;
      }
    }

    // Active lightning expansion bolts fade out crisply
    for (let i = graph.activeBolts.length - 1; i >= 0; i--) {
      const b = graph.activeBolts[i];
      b.age += dt;
      if (b.age >= b.life) {
        b.line.geometry.dispose();
        b.line.material.dispose();
        boltGroup.remove(b.line);
        graph.activeBolts.splice(i, 1);
      } else {
        b.line.material.opacity = 1 - b.age / b.life;
      }
    }

    // Neural signal sparks gliding along synapses
    if (graph.pulsePoints && graph._validEdges && graph._validEdges.length) {
      const pArr = graph.pulsePositions;
      for (let i = 0; i < graph.pulseSeeds.length; i++) {
        const ps = graph.pulseSeeds[i];
        ps.t = (ps.t + dt * ps.speed) % 1;
        const e = graph._validEdges[ps.edgeIdx];
        pArr[i * 3] = e.a.x + (e.b.x - e.a.x) * ps.t;
        pArr[i * 3 + 1] = e.a.y + (e.b.y - e.a.y) * ps.t;
        pArr[i * 3 + 2] = e.a.z + (e.b.z - e.a.z) * ps.t;
      }
      graph.pulsePoints.geometry.attributes.position.needsUpdate = true;
    }

    bgStars.rotation.y += dt * 0.008;
    renderer.render(scene, camera);

    // 3. Project Top Visible 3D Labels onto Pooled DOM Chips (zero allocations!)
    const rect = canvas.getBoundingClientRect();
    const candidates = [];
    for (const nd of graph.nodes) {
      SCRATCH_V1.set(nd.x, nd.y, nd.z);
      const dist = SCRATCH_V1.distanceTo(camera.position);
      const isPin = nd.key === selectedKey || nd.key === hoveredKey || nd.seed || nd.favorite;
      if (!isPin && dist > 260) continue;
      SCRATCH_V2.copy(SCRATCH_V1).project(camera);
      if (!Number.isFinite(SCRATCH_V2.x) || SCRATCH_V2.z > 1 || SCRATCH_V2.z < -1) continue;
      const sx = (SCRATCH_V2.x * 0.5 + 0.5) * rect.width;
      const sy = (-SCRATCH_V2.y * 0.5 + 0.5) * rect.height;
      if (sx < -40 || sx > rect.width + 40 || sy < -20 || sy > rect.height + 20) continue;
      const prio = (isPin ? 1000 : 0) + (nd.kind === 'theme' ? 90 : nd.kind === 'person' ? 60 : 40) - dist;
      candidates.push({ nd, sx, sy, dist, prio, isPin });
    }
    candidates.sort((a, b) => b.prio - a.prio);

    for (let i = 0; i < labelPool.length; i++) {
      const el = labelPool[i];
      const c = candidates[i];
      if (!c) {
        el.style.display = 'none';
        el.textContent = '';
        continue;
      }
      el.style.display = 'inline-flex';
      el.dataset.key = c.nd.key;
      el.className = `gb-label ${c.nd.kind}${c.nd.key === selectedKey ? ' on' : ''}${c.nd.favorite ? ' fav' : ''}`;
      el.textContent = c.nd.name;
      const op = c.isPin ? 1 : Math.max(0.28, Math.min(0.95, 1.15 - c.dist / 240));
      el.style.opacity = op.toFixed(2);
      el.style.transform = `translate3d(${Math.round(c.sx)}px, ${Math.round(c.sy - 14)}px, 0) translate(-50%, -100%)`;
    }

    // FPS telemetry
    fpsFrames++;
    if (now - fpsTimer >= 800) {
      lastFps = Math.round((fpsFrames * 1000) / (now - fpsTimer));
      fpsFrames = 0;
      fpsTimer = now;
      updateStatsPill();
    }
  }

  rafId = requestAnimationFrame(animate);

  return {
    isReady: () => !webglFailed,
    pause() {
      paused = true;
      wikiAbort?.abort();
      cancelAnimationFrame(rafId);
      sound.suspend();
    },
    resume() {
      if (!paused) return;
      paused = false;
      prevTime = performance.now();
      resizeRenderer();
      rafId = requestAnimationFrame(animate);
    },
    loadTaste,
    loadSeed,
    refreshTheme() {
      palette = readThemePalette();
      scene.background = palette.bg;
      scene.fog = new THREE.FogExp2(palette.bg.getHex(), 0.0022);
      coreLight.color.copy(palette.accent);
      rimLight.color.copy(palette.accent2);
      for (const nd of graph.nodes) {
        if (nd._mesh) {
          const c = nodeColor(nd);
          nd._mesh.material.color.copy(c);
          nd._mesh.material.emissive.copy(c);
        }
      }
      updateEdgeColors();
    },
    destroy() {
      paused = true;
      wikiAbort?.abort();
      cancelAnimationFrame(rafId);
      sound.suspend();
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      clearSceneGraph();
      renderer.dispose();
    },
  };
}
