// PROJECT STARK — Milestone 1 bundle (built from src/ modules)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ===== core/PerformanceManager.js =====
// Detects device capability, exposes a quality tier, and steps DOWN if FPS stays low.
const TIERS = [
  { name: 'low',    pixelRatio: 1.0,  nearRadius: 110, farRadius: 420, normalMaps: false, texSize: 512 },
  { name: 'medium', pixelRatio: 1.25, nearRadius: 160, farRadius: 600, normalMaps: true, texSize: 1024 },
  { name: 'high',   pixelRatio: 1.75, nearRadius: 220, farRadius: 800, normalMaps: true, texSize: 1024 },
];

class PerformanceManager {
  constructor() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const mobile = isIOS || /Android|Mobile/.test(ua);
    const mem = navigator.deviceMemory || (isIOS ? 4 : 8);
    const cores = navigator.hardwareConcurrency || 4;
    let tier = 2;
    if (mobile) tier = (mem >= 6 && cores >= 6) ? 1 : 0;
    else if (mem < 4 || cores < 4) tier = 1;
    this.isMobile = mobile;
    this.tierIndex = tier;
    this.fpsAvg = 60;
    this.lowTime = 0;
    this.onTierChange = null;
  }
  get tier() { return TIERS[this.tierIndex]; }
  // Called every frame. Lowers quality after ~3 s under 27 FPS.
  frame(dt) {
    if (dt <= 0) return;
    this.fpsAvg += (1 / dt - this.fpsAvg) * 0.05;
    this.lowTime = this.fpsAvg < 27 ? this.lowTime + dt : 0;
    if (this.lowTime > 3 && this.tierIndex > 0) {
      this.tierIndex--; this.lowTime = 0; this.fpsAvg = 40;
      if (this.onTierChange) this.onTierChange(this.tier);
    }
  }
}


// ===== core/AssetManager.js =====

const base = p => p.split('?')[0].split('/').pop().split('\\').pop();
const lc = s => decodeURIComponent(s).toLowerCase();

// Reads assets straight out of the ZIP files already in the repo root. Every failure is reported.
class AssetManager {
  constructor({ onError = () => {}, onStatus = () => {} } = {}) {
    this.onError = onError; this.onStatus = onStatus;
    this.entries = new Map(); this.urls = new Map(); this.textures = new Map();
    this.maxTex = 1024; this.dropNormals = false;
    this.manager = new THREE.LoadingManager();
    this.manager.setURLModifier(u => this.urls.get(lc(base(u))) || u);
    this.gltf = new GLTFLoader(this.manager);
    this.loaded = []; this.failed = [];
  }
  _ok(n) { this.loaded.push(n); this.onStatus(this.loaded.length, this.failed.length); }
  _fail(n, e) { const m = `${n}: ${e && e.message ? e.message : e}`; this.failed.push(m); this.onError(m); this.onStatus(this.loaded.length, this.failed.length); }

  async mountZips(names, progress = () => {}) {
    let i = 0;
    await Promise.all(names.map(async n => {
      try {
        const r = await fetch('./' + n + '?v=m14'); if (!r.ok) throw Error('HTTP ' + r.status + ' (keep ' + n + ' in the repo root)');
        const z = await JSZip.loadAsync(await r.arrayBuffer());
        for (const f of Object.values(z.files)) if (!f.dir) this.entries.set(lc(base(f.name)), f);
        this._ok(n);
      } catch (e) { this._fail(n, e); }
      progress(++i / names.length);
    }));
  }
  has(name) { return this.entries.has(lc(name)); }
  async url(name) {
    const k = lc(name); if (this.urls.has(k)) return this.urls.get(k);
    const f = this.entries.get(k); if (!f) throw Error(name + ' not found in any ZIP');
    const u = URL.createObjectURL(await f.async('blob')); this.urls.set(k, u); return u;
  }
  release() { for (const u of this.urls.values()) URL.revokeObjectURL(u); this.urls.clear(); this.entries.clear(); }

  // Downscale textures that are larger than the device budget (keeps iPhone memory in check).
  shrink(tex, size = this.maxTex) {
    const img = tex && tex.image; if (!img || !img.width || img.width <= size) return;
    const c = document.createElement('canvas'), k = size / Math.max(img.width, img.height);
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    tex.image = c; tex.needsUpdate = true;
  }
  shrinkMaterials(root) {
    const slots = ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'aoMap', 'emissiveMap'];
    const done = new Set();
    root.traverse(o => { if (!o.material) return; for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (this.dropNormals) { m.normalMap = null; m.needsUpdate = true; }
      for (const s of slots) { const t = m[s]; if (t && !done.has(t)) { done.add(t); this.shrink(t); } }
    } });
  }

  async loadGLTF(name) {
    try {
      const f = this.entries.get(lc(name)); if (!f) throw Error('not found in any ZIP');
      const text = await f.async('string'), j = JSON.parse(text);
      await Promise.all([...(j.images || []), ...(j.buffers || [])].filter(x => x.uri && !x.uri.startsWith('data:')).map(x => this.url(base(x.uri))));
      const g = await new Promise((res, rej) => this.gltf.parse(text, '', res, rej));
      this.shrinkMaterials(g.scene); this._ok(name); return g;
    } catch (e) { this._fail(name, e); throw e; }
  }
  async prefetch(re) { await Promise.all([...this.entries.keys()].filter(k => re.test(k)).map(k => this.url(k))); }
  async loadFBX(name) {
    try {
      const url = await this.url(name);
      await this.prefetch(/^for_substance.*\.(png|jpe?g|tga)$/);
      const m = new THREE.LoadingManager(); m.setURLModifier(u => this.urls.get(lc(base(u))) || u);
      const o = await new FBXLoader(m).loadAsync(url); this._ok(name); return o;
    } catch (e) { this._fail(name, e); throw e; }
  }
  async loadTexture(name, { srgb = false, repeat = null, anisotropy = 4 } = {}) {
    const key = name + (srgb ? '#s' : ''); if (this.textures.has(key)) return this.textures.get(key);
    try {
      const t = await new THREE.TextureLoader().loadAsync(await this.url(name));
      if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = anisotropy; this.shrink(t);
      if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); }
      this.textures.set(key, t); this._ok(name); return t;
    } catch (e) { this._fail(name, e); return null; }
  }
}


// ===== core/SceneManager.js =====

const SUN_DIR = new THREE.Vector3(-0.5, 0.7, 0.45).normalize();
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const gr = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,240,210,0.85)');
  gr.addColorStop(0.4, 'rgba(255,220,160,0.22)'); gr.addColorStop(1, 'rgba(255,220,160,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const FOG_COLOR = 0xcdd9e0;

class SceneManager {
  constructor(perf) {
    this.perf = perf;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0017);
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3500);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, perf.tier.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    document.body.prepend(this.renderer.domElement);

    // Image-based lighting (procedural, no download) for metal reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3b4350, 1.1));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(300);
    this.scene.add(this.sun);

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: SUN_DIR } },
      vertexShader: 'varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec3 vD;uniform vec3 sunDir;void main(){vec3 d=normalize(vD);float h=clamp(d.y,0.,1.);vec3 hor=vec3(.80,.85,.88),mid=vec3(.46,.62,.84),top=vec3(.16,.38,.72);vec3 c=mix(hor,mid,smoothstep(0.,.25,h));c=mix(c,top,smoothstep(.25,.9,h));float s=max(dot(d,sunDir),0.);c+=vec3(1.,.9,.7)*(pow(s,8.)*.25+pow(s,64.)*.6+pow(s,800.)*4.);gl_FragColor=vec4(c,1.);}',
    }));
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

    // Soft radial glow used for the sun flare and the boost bloom.
    this.glowTex = glowTexture();
    this.sunFlare = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xfff1d0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, transparent: true }));
    this.sunFlare.scale.set(420, 420, 1); this.sunFlare.renderOrder = 10;
    this.scene.add(this.sunFlare);

    // Realtime sun shadows on the high tier only (follows the hero, so the 280 m box stays sharp).
    this.shadows = perf.tier.name === 'high';
    if (this.shadows) {
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048);
      const sc = this.sun.shadow.camera; sc.left = -140; sc.right = 140; sc.top = 140; sc.bottom = -140; sc.near = 10; sc.far = 700; sc.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0008; this.sun.shadow.normalBias = 0.6;
      this.scene.add(this.sun.target);
    }
    addEventListener('resize', () => this.resize());
    perf.onTierChange = t => this.renderer.setPixelRatio(Math.min(devicePixelRatio, t.pixelRatio));
  }
  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }
  render(hero) {
    this.sky.position.copy(this.camera.position);
    this.sunFlare.position.copy(this.camera.position).addScaledVector(SUN_DIR, 2800);
    if (this.shadows && hero) {
      this.sun.target.position.set(hero.x, 0, hero.z);
      this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 300);
    }
    this.renderer.render(this.scene, this.camera);
  }
}


// ===== environment/CityManager.js =====

// Grid layout (metres). Roads run along lines x = k*PITCH and z = k*PITCH.
const PITCH = 110, BLOCK = 86, HALF = BLOCK / 2, GRID = 8, SLOT = 37, PAD_H = 0.12;
const WORLD_LIMIT = (GRID / 2) * PITCH + PITCH * 0.5;
// Building models are discovered automatically from every mounted ZIP (any file named building_*.gltf).
const buildingNames = (assets) => [...assets.entries.keys()].filter(k => /^building_.*\.gltf$/.test(k)).map(k => k.slice(0, -5));

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), C = new THREE.Color();

class CityManager {
  constructor(scene, assets, perf) {
    this.scene = scene; this.assets = assets; this.perf = perf;
    this.group = new THREE.Group(); scene.add(this.group);
    this.templates = []; this.placements = []; this.colliders = []; this.parks = [];
    this.nearMeshes = []; this.farMesh = null; this.ringCount = 0;
    this.lastUpdate = new THREE.Vector3(1e9, 0, 1e9);
    this.near = perf.tier.nearRadius; this.far = perf.tier.farRadius;
  }

  async load(progress = () => {}) {
    const a = this.assets; a.maxTex = this.perf.tier.texSize; a.dropNormals = !this.perf.tier.normalMaps; const base = '';
    progress('LOADING BUILDING MODELS', 10);
    const names = buildingNames(a);
    if (!names.length) throw new Error('No building_*.gltf models found in any ZIP');
    const [gb, decalCross, decalYellow] = await Promise.all([
      Promise.all(names.map(n => a.loadGLTF(base + n + '.gltf').catch(() => null))),
      a.loadGLTF(base + 'Decal_Crosswalk.gltf'), a.loadGLTF(base + 'Decal_DoubleYellow_Straight.gltf'),
    ]);
    progress('PROCESSING CITY GEOMETRY', 55);
    gb.forEach(g => { if (g) this.templates.push(this._template(g.scene)); });
    if (!this.templates.length) throw new Error('All building models failed to load');
    const [asphalt, concrete] = await Promise.all([
      a.loadTexture(base + 'T_Concrete_Asphalt_BaseColor.png', { srgb: true, repeat: 260 }),
      a.loadTexture(base + 'T_Concrete_BaseColor.png', { srgb: true, repeat: 14 }),
    ]);
    progress('BUILDING STREETS', 70);
    this._generate();
    this._buildGround(asphalt, concrete);
    this._buildBuildingInstances();
    this._buildFarAndSkyline();
    this._buildDecals(decalCross.scene, decalYellow.scene);
    this._buildStreetLights();
    this.update(new THREE.Vector3(0, 0, 0), true);
    progress('CITY READY', 100);
  }

  _template(root) {
    root.updateMatrixWorld(true);
    const meshes = []; root.traverse(o => { if (o.isMesh) meshes.push(o); });
    if (!meshes.length) throw new Error('Building model has no meshes');
    const box = new THREE.Box3().setFromObject(root);
    const t = { meshes, min: box.min.clone(), max: box.max.clone() };
    t.w = box.max.x - box.min.x; t.d = box.max.z - box.min.z; t.h = box.max.y - box.min.y;
    t.cx = (box.max.x + box.min.x) / 2; t.cz = (box.max.z + box.min.z) / 2;
    for (const m of meshes) for (const mat of (Array.isArray(m.material) ? m.material : [m.material])) mat.envMapIntensity = 0.3;
    return t;
  }

  // Four corner towers per block, facing the street, tiled inside a 74x74 m usable area.
  _generate() {
    const r = rng(85), half = GRID / 2;
    for (let bi = 0; bi < GRID; bi++) for (let bj = 0; bj < GRID; bj++) {
      const cx = (bi - half + 0.5) * PITCH, cz = (bj - half + 0.5) * PITCH;
      const dist = Math.hypot(cx, cz) / (half * PITCH);
      if (r() < 0.08 && dist > 0.15) { this.parks.push({ cx, cz }); continue; }
      for (const qx of [-1, 1]) for (const qz of [-1, 1]) {
        const ti = Math.floor(r() * this.templates.length), t = this.templates[ti];
        const faceZ = r() < 0.5;
        const rot = faceZ ? (qz > 0 ? 0 : Math.PI) : (qx > 0 ? Math.PI / 2 : -Math.PI / 2);
        const target = 18 + r() * 22; // each building gets its own footprint (18-40 m)
        const s = Math.min(target / t.w, target / t.d);
        const sy = s * (0.85 + r() * 0.5) * (1 + (1 - Math.min(1, dist)) * 0.7);
        // Non-uniform scale: same model comes out wider/narrower and deeper/shallower per building (capped to the 36 m block).
        const sx = Math.min(s * (0.78 + r() * 0.44), 36 / t.w), sz = Math.min(s * (0.78 + r() * 0.44), 36 / t.d);
        const sw = t.w * sx, sd = t.d * sz;
        const hx = (faceZ ? sw : sd) / 2, hz = (faceZ ? sd : sw) / 2;
        const px = faceZ ? cx + qx * SLOT / 2 : cx + qx * (SLOT - hx);
        const pz = faceZ ? cz + qz * (SLOT - hz) : cz + qz * SLOT / 2;
        M.compose(V.set(px, 0, pz), Q.setFromAxisAngle(UP, rot), S.set(sx, sy, sz));
        M.multiply(new THREE.Matrix4().makeTranslation(-t.cx, -t.min.y, -t.cz));
        let height = t.h * sy;
        const sh = 0.55 + r() * 0.75, wa = 0.85 + r() * 0.3;
        // ~half the buildings get a second model stacked on top (footprint matched to the base), so 3 models give many silhouettes.
        let top = null;
        if (r() < 0.5) {
          const ti2 = Math.floor(r() * this.templates.length), t2 = this.templates[ti2];
          const sy2 = s * (0.5 + r() * 0.8);
          const M2 = new THREE.Matrix4().compose(V.set(px, height, pz), Q.setFromAxisAngle(UP, rot), S.set(sw / t2.w, sy2, sd / t2.d));
          M2.multiply(new THREE.Matrix4().makeTranslation(-t2.cx, -t2.min.y, -t2.cz));
          top = { ti: ti2, matrix: M2 };
          height += t2.h * sy2;
        }
        this.placements.push({ ti, px, pz, hx, hz, height, top, matrix: M.clone(), tint: 0.55 + r() * 0.3, color: new THREE.Color().setRGB(sh * wa, sh, sh / wa) });
        this.colliders.push({ minX: px - hx, maxX: px + hx, minZ: pz - hz, maxZ: pz + hz, h: height });
      }
    }
  }

  _buildGround(asphalt, concrete) {
    const size = GRID * PITCH + 2000;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: asphalt, color: 0xbdbdbd, roughness: 0.95, metalness: 0, envMapIntensity: 0.2 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true; this.group.add(ground);
    const padGeo = new THREE.BoxGeometry(BLOCK, PAD_H, BLOCK); padGeo.translate(0, PAD_H / 2, 0);
    const pads = new THREE.InstancedMesh(padGeo, new THREE.MeshStandardMaterial({ map: concrete, color: 0xcfcfcf, roughness: 0.9, envMapIntensity: 0.2 }), GRID * GRID);
    const parkKeys = new Set(this.parks.map(p => p.cx + ',' + p.cz));
    let n = 0, pn = 0;
    const parkMesh = new THREE.InstancedMesh(padGeo, new THREE.MeshStandardMaterial({ color: 0x41653d, roughness: 1, envMapIntensity: 0.1 }), Math.max(1, this.parks.length));
    for (let bi = 0; bi < GRID; bi++) for (let bj = 0; bj < GRID; bj++) {
      const cx = (bi - GRID / 2 + 0.5) * PITCH, cz = (bj - GRID / 2 + 0.5) * PITCH;
      M.makeTranslation(cx, 0, cz);
      if (parkKeys.has(cx + ',' + cz)) parkMesh.setMatrixAt(pn++, M); else pads.setMatrixAt(n++, M);
    }
    pads.count = n; parkMesh.count = pn;
    pads.frustumCulled = parkMesh.frustumCulled = false;
    this.group.add(pads, parkMesh);
  }

  _buildBuildingInstances() {
    const cap = (this.placements.length * 2) || 1;
    this.templates.forEach(t => {
      t.instanced = t.meshes.map(m => {
        const im = new THREE.InstancedMesh(m.geometry, m.material, cap); im.castShadow = true; im.receiveShadow = true;
        im.setColorAt(0, C.setRGB(1, 1, 1)); // create the instance colour buffer up front...
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (m.material) m.material.needsUpdate = true; // ...and make the shader compile with instance colour
        im.count = 0; im.frustumCulled = false; this.group.add(im); this.nearMeshes.push(im); return im;
      });
    });
  }

  // Far LOD: one instanced box per distant building + outer skyline ring for depth.
  _buildFarAndSkyline() {
    const r = rng(1985), ringN = 150, cap = ringN + this.placements.length;
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    this.farMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0.1, envMapIntensity: 0.25 }), cap);
    this.farMesh.frustumCulled = false;
    for (let i = 0; i < ringN; i++) {
      const ang = r() * Math.PI * 2, rad = WORLD_LIMIT + 120 + r() * 800, h = 45 + Math.pow(r(), 2.2) * 230, w = 28 + r() * 50, d = 28 + r() * 50;
      M.compose(V.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad), Q.setFromAxisAngle(UP, r() * 3), S.set(w, h, d));
      this.farMesh.setMatrixAt(i, M);
      this.farMesh.setColorAt(i, C.setHSL(0.58, 0.12, 0.42 + r() * 0.2));
    }
    this.ringCount = ringN; this.farMesh.count = ringN; this.group.add(this.farMesh);
  }

  _decalMesh(root) { let m = null; root.traverse(o => { if (o.isMesh && !m) m = o; }); if (!m) throw new Error('Decal has no mesh'); return m; }
  _buildDecals(crossRoot, yellowRoot) {
    const cross = this._decalMesh(crossRoot), yellow = this._decalMesh(yellowRoot);
    for (const m of [cross, yellow]) {
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      mat.transparent = true; mat.depthWrite = false; mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
    }
    const lines = []; for (let k = 0; k <= GRID; k++) lines.push((k - GRID / 2) * PITCH);
    const ROAD_HALF = (PITCH - BLOCK) / 2, y = 0.148 + 0.03;
    // Crosswalks: 4 per junction, stripes spanning the road width.
    const cm = []; 
    for (const x of lines) for (const z of lines) for (const [dx, dz, rot] of [[1, 0, 0], [-1, 0, 0], [0, 1, Math.PI / 2], [0, -1, Math.PI / 2]]) {
      const off = ROAD_HALF + 3.4;
      cm.push(new THREE.Matrix4().compose(V.set(x + dx * off, y, z + dz * off), Q.setFromAxisAngle(UP, rot), S.set(1.3, 1, (ROAD_HALF * 2 - 1) / 5.43)));
    }
    this._instanceDecal(cross, cm);
    // Double yellow centre lines between junctions, tiled to the decal length.
    cross.geometry.computeBoundingBox(); yellow.geometry.computeBoundingBox();
    const bb = yellow.geometry.boundingBox, lx = bb.max.x - bb.min.x, lz = bb.max.z - bb.min.z, alongZ = lz >= lx, len = Math.max(lx, lz);
    const tiles = Math.floor((BLOCK + 2) / len), ym = [];
    for (const lineA of lines) for (let k = 0; k < GRID; k++) {
      const mid = (k - GRID / 2 + 0.5) * PITCH;
      for (let i = 0; i < tiles; i++) {
        const u = mid - (tiles * len) / 2 + (i + 0.5) * len;
        // road along z (x = lineA): decal long axis must align with z; road along x: rotate.
        ym.push(new THREE.Matrix4().compose(V.set(lineA, y, u), Q.setFromAxisAngle(UP, alongZ ? 0 : Math.PI / 2), S.set(1, 1, 1)));
        ym.push(new THREE.Matrix4().compose(V.set(u, y, lineA), Q.setFromAxisAngle(UP, alongZ ? Math.PI / 2 : 0), S.set(1, 1, 1)));
      }
    }
    this._instanceDecal(yellow, ym);
  }
  _instanceDecal(mesh, mats) {
    const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m)); im.frustumCulled = false; this.group.add(im);
  }

  _buildStreetLights() {
    const pole = new THREE.CylinderGeometry(0.1, 0.17, 8, 6); pole.translate(0, 4, 0);
    const head = new THREE.BoxGeometry(1.6, 0.16, 0.5); head.translate(0.7, 8, 0);
    const lines = []; for (let k = 0; k <= GRID; k++) lines.push((k - GRID / 2) * PITCH);
    const n = lines.length * lines.length * 4;
    const poles = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x59656e, metalness: 0.7, roughness: 0.4 }), n);
    const heads = new THREE.InstancedMesh(head, new THREE.MeshBasicMaterial({ color: 0xffe4b5 }), n);
    let i = 0; const off = (PITCH - BLOCK) / 2 + 1.2;
    for (const x of lines) for (const z of lines) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      // Arm points toward the junction centre.
      M.compose(V.set(x + sx * off, 0, z + sz * off), Q.setFromAxisAngle(UP, Math.atan2(-sx, -sz) - Math.PI / 2), S.set(1, 1, 1));
      poles.setMatrixAt(i, M); heads.setMatrixAt(i, M); i++;
    }
    poles.frustumCulled = heads.frustumCulled = false; this.group.add(poles, heads);
  }

  setRadii(near, far) { this.near = near; this.far = far; this.lastUpdate.set(1e9, 0, 1e9); }

  // Distance-based visibility: full models near the player, box LOD mid-range, nothing beyond.
  update(pos, force = false) {
    if (!force && Math.hypot(pos.x - this.lastUpdate.x, pos.z - this.lastUpdate.z) < 10) return;
    this.lastUpdate.copy(pos);
    const counts = this.templates.map(() => 0); let far = this.ringCount;
    for (const p of this.placements) {
      const d = Math.hypot(p.px - pos.x, p.pz - pos.z);
      if (d < this.near) {
        const t = this.templates[p.ti], k = counts[p.ti]++;
        for (const im of t.instanced) { im.setMatrixAt(k, p.matrix); im.setColorAt(k, p.color); }
        if (p.top) {
          const t2 = this.templates[p.top.ti], k2 = counts[p.top.ti]++;
          for (const im of t2.instanced) { im.setMatrixAt(k2, p.top.matrix); im.setColorAt(k2, p.color); }
        }
      } else if (d < this.far) {
        M.compose(V.set(p.px, 0, p.pz), Q.identity(), S.set(p.hx * 2, p.height, p.hz * 2));
        this.farMesh.setMatrixAt(far, M); this.farMesh.setColorAt(far, C.setHSL(0.07, 0.25, p.tint * 0.6)); far++;
      }
    }
    this.templates.forEach((t, i) => t.instanced.forEach(im => { im.count = counts[i]; im.instanceMatrix.needsUpdate = true; }));
    this.farMesh.count = far; this.farMesh.instanceMatrix.needsUpdate = true;
    if (this.farMesh.instanceColor) this.farMesh.instanceColor.needsUpdate = true;
  }

  // Highest walkable surface at (x, z): street/pad, or the roof of a building covering that point.
  surfaceAt(x, z) {
    let y = this.groundHeight(x, z);
    for (const c of this.colliders) if (c.h > y && x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ) y = c.h;
    return y;
  }
  groundHeight(x, z) {
    const u = x / PITCH + GRID / 2, v = z / PITCH + GRID / 2;
    if (u < 0 || v < 0 || u > GRID || v > GRID) return 0;
    return (Math.abs((u % 1) - 0.5) * PITCH < HALF && Math.abs((v % 1) - 0.5) * PITCH < HALF) ? PAD_H : 0;
  }

  // Pushes a circle (radius r, at height y) out of building footprints. Returns true if it moved.
  resolveCircle(pos, r, y) {
    let hit = false;
    for (const c of this.colliders) {
      if (y > c.h + 0.5 || pos.x < c.minX - r || pos.x > c.maxX + r || pos.z < c.minZ - r || pos.z > c.maxZ + r) continue;
      const nx = Math.max(c.minX, Math.min(pos.x, c.maxX)), nz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
      let dx = pos.x - nx, dz = pos.z - nz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      hit = true;
      if (d2 > 1e-6) { const d = Math.sqrt(d2); pos.x = nx + dx / d * r; pos.z = nz + dz / d * r; }
      else { // centre inside the box: exit through the nearest face
        const e = [pos.x - c.minX, c.maxX - pos.x, pos.z - c.minZ, c.maxZ - pos.z], m = Math.min(...e);
        if (m === e[0]) pos.x = c.minX - r; else if (m === e[1]) pos.x = c.maxX + r; else if (m === e[2]) pos.z = c.minZ - r; else pos.z = c.maxZ + r;
      }
    }
    return hit;
  }

  // Ray vs building boxes; returns the nearest hit distance (or maxDist).
  raycast(origin, dir, maxDist) {
    let best = maxDist;
    for (const c of this.colliders) {
      let t0 = 0, t1 = best;
      const o = [origin.x, origin.y, origin.z], d = [dir.x, dir.y, dir.z], lo = [c.minX, 0, c.minZ], hi = [c.maxX, c.h, c.maxZ];
      let ok = true;
      for (let i = 0; i < 3 && ok; i++) {
        if (Math.abs(d[i]) < 1e-8) { if (o[i] < lo[i] || o[i] > hi[i]) ok = false; }
        else { let a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i]; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) ok = false; }
      }
      if (ok && t0 < best) best = t0;
    }
    return best;
  }
}


// ===== character/IronMan.js =====

const TEX = 'For_Substance_Low_Polly_';
// Per-part PBR texture sets shipped with the Mark 85 (file names are truncated in the source pack).
const PARTS = {
  silver:     { base: 'Silver_Part_BaseCo', metal: 'Silver_Part_Metall', rough: 'Silver_Part_Roughn', normal: 'Silver_Part_Normal' },
  gold:       { base: 'Gold_Part_BaseColo', metal: 'Gold_Part_Metallic', rough: 'Gold_Part_Roughnes', normal: 'Gold_Part_Normal' },
  red:        { base: 'Red_Part_BaseColor', metal: 'Red_Part_Metallic', rough: 'Red_Part_Roughness', normal: 'Red_Part_Normal' },
  arcreactor: { base: 'Arc_Reactor_BaseCo', metal: 'Arc_Reactor_Metall', rough: 'Arc_Reactor_Roughn', normal: 'Arc_Reactor_Normal' },
  lights:     { base: 'Lights_BaseColor' },
};
const key = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// The clip files use UE Mannequin bone names; Og.fbx uses Mixamo names. Map them so tracks bind.
const UE_TO_MIXAMO = {
  pelvis: 'Hips', spine_01: 'Spine', spine_02: 'Spine1', spine_03: 'Spine2', neck_01: 'Neck', head: 'Head',
  clavicle_l: 'LeftShoulder', clavicle_r: 'RightShoulder', upperarm_l: 'LeftArm', upperarm_r: 'RightArm',
  lowerarm_l: 'LeftForeArm', lowerarm_r: 'RightForeArm', hand_l: 'LeftHand', hand_r: 'RightHand',
  thigh_l: 'LeftUpLeg', thigh_r: 'RightUpLeg', calf_l: 'LeftLeg', calf_r: 'RightLeg',
  foot_l: 'LeftFoot', foot_r: 'RightFoot', ball_l: 'LeftToeBase', ball_r: 'RightToeBase',
};
// boneKeys: lowercase Mixamo short name -> exact hero node name. Direct copy of the clip tracks (the M3 look).
function retargetClip(clip, boneKeys) {
  const tracks = [];
  for (const t of clip.tracks) {
    const i = t.name.lastIndexOf('.'); if (i < 0) continue;
    const ue = t.name.slice(0, i).split(/[|:]/).pop(), prop = t.name.slice(i);
    if (ue === 'pelvis') continue; // root/hips rotation in the clip lays the hero flat; the tilt group owns posture
    const mix = UE_TO_MIXAMO[ue], target = mix && boneKeys.get(mix.toLowerCase());
    if (!target) continue;
    t.name = target + prop; tracks.push(t);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

class IronMan {
  constructor(assets, perf) {
    this.assets = assets; this.perf = perf;
    this.root = new THREE.Group();   // position + heading (forward = -Z)
    this.tilt = new THREE.Group();   // flight pitch / bank
    this.root.add(this.tilt);
    this.model = null; this.bones = {}; this.glows = []; this.height = 1.9; this.fallback = false;
    this.flying = 0;                 // 0..1 thruster intensity
  }

  async load(progress = () => {}) {
    progress('LOADING MARK 85', 5);
    let obj;
    try { obj = await this.assets.loadFBX('Og.fbx'); }
    catch (e) { this._buildFallback(); return; }
    // Scale to ~1.95 m tall and plant the feet on y = 0 (original model orientation preserved: rotation.y = PI).
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3());
    if (!isFinite(size.y) || size.y <= 0) { this._buildFallback(); throw new Error('Mark 85 has invalid dimensions'); }
    const k = 1.95 / size.y; obj.scale.multiplyScalar(k);
    obj.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(obj), c = b2.getCenter(new THREE.Vector3());
    obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= b2.min.y;
    const holder = new THREE.Group(); holder.rotation.y = Math.PI; holder.add(obj);
    this.tilt.add(holder); this.model = obj;

    await this._loadAnimations(obj);
    progress('APPLYING SUIT MATERIALS', 60);
    obj.traverse(o => {
      if (o.isBone) { const n = key(o.name); for (const [id, re] of [['lHand', /lefthand$/], ['rHand', /righthand$/], ['lFoot', /leftfoot$/], ['rFoot', /rightfoot$/], ['chest', /spine2$/], ['head', /head$/]]) if (re.test(n)) this.bones[id] = o; }
    });
    await this._applyMaterials(obj);
    this._buildGlows();
    progress('MARK 85 ONLINE', 100);
  }

  async _applyMaterials(obj) {
    const meshes = []; obj.traverse(o => { if (o.isMesh) meshes.push(o); });
    const useNormal = this.perf.tier.normalMaps;
    for (const m of meshes) {
      m.frustumCulled = false; m.castShadow = true; // skinned bounds are unreliable on imported FBX
      const k = key(m.name) || key(Array.isArray(m.material) ? m.material[0].name : m.material.name);
      const orig = Array.isArray(m.material) ? m.material[0] : m.material;
      const set = PARTS[k];
      if (k.includes('glass')) {
        m.material = new THREE.MeshStandardMaterial({ color: 0x9fd8e8, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.45, envMapIntensity: 1.4 });
      } else if (set) {
        const g = async (f, srgb) => f ? this.assets.loadTexture(TEX + f + '.png', { srgb }) : null;
        const [base, metal, rough, normal] = await Promise.all([g(set.base, true), g(set.metal), g(set.rough), useNormal ? g(set.normal) : null]);
        const mat = new THREE.MeshStandardMaterial({ map: base || orig.map, color: 0xffffff, metalness: metal ? 1 : 0.6, roughness: rough ? 1 : 0.4, metalnessMap: metal, roughnessMap: rough, normalMap: normal, envMapIntensity: 1.1 });
        if (k === 'arcreactor') { mat.emissive = new THREE.Color(0x66e6ff); mat.emissiveMap = base; mat.emissiveIntensity = 1.6; }
        if (k === 'lights') { mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = base; mat.emissiveIntensity = 1.4; mat.metalness = 0; mat.roughness = 0.5; }
        m.material = mat;
      } else if (orig) {
        // Unknown part: keep the original texture, convert to PBR so lighting/reflections work.
        m.material = new THREE.MeshStandardMaterial({ map: orig.map, color: orig.color, normalMap: useNormal ? orig.normalMap : null, metalness: 0.6, roughness: 0.4 });
      }
    }
  }

  _buildGlows() {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(120,230,255,.8)'); g.addColorStop(1, 'rgba(60,180,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    for (const id of ['lHand', 'rHand', 'lFoot', 'rFoot']) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      s.visible = false; s.userData.bone = id; this.root.add(s); this.glows.push(s);
    }
    this.chestLight = new THREE.PointLight(0x66e6ff, 0.8, 7); this.root.add(this.chestLight);
    this.bloom = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._bloomTex(), color: 0x66e6ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
    this.bloom.position.set(0, 1.2, 0.2); this.bloom.scale.set(0.1, 0.1, 1); this.bloom.renderOrder = 9; this.tilt.add(this.bloom);
  }

  _buildFallback() {
    this.fallback = true;
    const red = new THREE.MeshStandardMaterial({ color: 0x9d2027, metalness: .8, roughness: .25 }), gold = new THREE.MeshStandardMaterial({ color: 0xc69a4d, metalness: .85, roughness: .22 });
    const add = (geo, m, p) => { const o = new THREE.Mesh(geo, m); o.position.set(...p); this.tilt.add(o); };
    add(new THREE.CapsuleGeometry(.36, .9, 6, 10), red, [0, 1.1, 0]); add(new THREE.SphereGeometry(.28, 16, 12), gold, [0, 1.9, 0]);
    for (const s of [-1, 1]) { add(new THREE.CapsuleGeometry(.13, .65, 4, 8), red, [s * .53, 1.15, 0]); add(new THREE.CapsuleGeometry(.12, .62, 4, 8), red, [s * .22, .4, 0]); }
  }

    async _loadAnimations(obj) {
    this.mixer = new THREE.AnimationMixer(obj); this.actions = {}; this.current = null;
    const boneKeys = new Map();
    obj.traverse(o => { if (o.isBone) boneKeys.set(o.name.replace(/^mixamorig:?/, '').toLowerCase(), o.name); });
    const files = { idle: 'Idle_relaxed.fbx', walk: 'Walk_forwards.fbx', run: 'Run_sprint.fbx', fly: 'Jump_in_the_air.fbx' };
    await Promise.all(Object.entries(files).map(async ([k, f]) => {
      try {
        const o = await this.assets.loadFBX(f);
        const raw = o.animations && o.animations[0];
        const clip = raw && retargetClip(raw, boneKeys);
        if (clip && clip.tracks.length) { const a = this.mixer.clipAction(clip); a.setLoop(THREE.LoopRepeat); a.play(); a.setEffectiveWeight(0); this.actions[k] = a; }
      } catch (e) { this.assets.onError('ANIM ' + f + ': ' + (e.message || e)); }
    }));
    const n = Object.keys(this.actions).length;
    this.assets.onStatus(n, 0);
    if (n < 4) this.assets.onError('ANIM: only ' + n + '/4 clips loaded');
    this.play('idle');
  }
  play(name) {
    const next = this.actions && this.actions[name];
    if (!next || next === this.current) return;
    next.reset().setEffectiveWeight(1).fadeIn(0.25);
    if (this.current) this.current.fadeOut(0.25);
    this.current = next;
  }

  _bloomTex() {
    const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(180,240,255,0.6)'); gr.addColorStop(1, 'rgba(120,220,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // Thruster glow follows the real hand/foot bones; intensity = flight state.
  update(dt, flightAmount, speed = 0, boost = false) {
    this.flying += (flightAmount - this.flying) * Math.min(1, dt * 6);
    if (this.mixer) {
      this.mixer.update(dt);
      this.play(this.flying > 0.5 ? 'fly' : speed > 7 ? 'run' : speed > 0.6 ? 'walk' : 'idle');
    }
    const p = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    for (const s of this.glows) {
      const b = this.bones[s.userData.bone]; s.visible = !!b && this.flying > 0.05;
      if (!s.visible) continue;
      b.getWorldPosition(p); this.root.worldToLocal(p); s.position.copy(p);
      const foot = s.userData.bone.endsWith('Foot'); s.scale.setScalar((foot ? 0.9 : 0.55) * this.flying * (1 + Math.min(1.2, speed * 0.02) + (boost ? 1.5 : 0)) * (0.9 + Math.random() * 0.2));
    }
    if (this.bloom) { const target = boost ? 0.9 : 0, s = 3.5 + (boost ? 3 : 0) + Math.sin(performance.now() * 0.02) * 0.4 * (boost ? 1 : 0);
      this.bloom.material.opacity += (target - this.bloom.material.opacity) * Math.min(1, dt * 8); this.bloom.scale.set(s, s, 1); }
    if (this.chestLight) { this.chestLight.position.set(0, 1.4, -0.25); this.chestLight.intensity = 0.6 + this.flying * 1.2 + (boost ? 4 : 0); }
  }

  worldPosOf(id, out) { const b = this.bones[id]; if (b) { b.getWorldPosition(out); return out; } return out.copy(this.root.position).add(new THREE.Vector3(0, 1.3, 0)); }
}


// ===== character/MovementController.js =====

const WALK = 4.5, RUN = 9.5, FLY = 38, FLY_BOOST = 95, RADIUS = 0.7;
const MODE = { WALK: 'WALK', TAKEOFF: 'TAKEOFF', FLY: 'FLIGHT', LANDING: 'LANDING' };

// Camera-relative walking and (M1) free flight with takeoff/landing phases. Animations come in Milestone 2.
class MovementController {
  constructor() {
    this.pos = new THREE.Vector3(0, 0, 0); this.vel = new THREE.Vector3();
    this.heading = 0; this.mode = MODE.WALK; this.targetAlt = 0; this.speed = 0; this.bank = 0; this.pitch = 0; this.hitLimit = false;
  }
  takeoff() { if (this.mode === MODE.WALK) { this.mode = MODE.TAKEOFF; this.targetAlt = 70; this.takeoffT = 0; return true; } return false; }
  land() { if (this.mode === MODE.FLY || this.mode === MODE.TAKEOFF) { this.mode = MODE.LANDING; this.targetAlt = 0; return true; } return false; }
  // M1: the game starts in the air. LAND puts Mark 85 on the nearest surface (street or rooftop).
  startFlying() { this.mode = MODE.FLY; this.pos.y = 70; this.targetAlt = 70; this.landed = false; }
  get flying() { return this.mode !== MODE.WALK; }

  update(dt, inp, camYaw, city) {
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw)), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const dir = fwd.clone().multiplyScalar(inp.y).add(right.multiplyScalar(inp.x));
    const mag = Math.min(1, dir.length()); if (mag > 1e-3) dir.normalize();
    const airborne = this.mode !== MODE.WALK;
    let top = airborne ? (inp.boost ? FLY_BOOST : (inp.hover ? 4 : FLY)) : (inp.run ? RUN : WALK);
    if (this.mode === MODE.TAKEOFF || this.mode === MODE.LANDING) top = Math.min(top, 8);
    const want = dir.multiplyScalar(top * mag);
    const k = Math.min(1, dt * (airborne ? 4 : 9));
    this.vel.x += (want.x - this.vel.x) * k; this.vel.z += (want.z - this.vel.z) * k;
    const prevHeading = this.heading;
    if (mag > 0.08) { const a = Math.atan2(-dir.x, -dir.z); let d = a - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); this.heading += d * Math.min(1, dt * (airborne ? 7 : 10)); }
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // Altitude state machine.
    if (this.mode === MODE.FLY) this.targetAlt = THREE.MathUtils.clamp(this.targetAlt + (inp.up - inp.down) * (inp.boost ? 40 : 16) * dt, 2, 420);
    const ground = city.surfaceAt(this.pos.x, this.pos.z);
    if (this.mode === MODE.LANDING) this.targetAlt = ground; // M2: descend onto whatever is below, roof or street
    const climb = this.mode === MODE.LANDING ? 1.8 : 2.4;
    this.pos.y = THREE.MathUtils.damp(this.pos.y, Math.max(this.targetAlt, ground), climb, dt);
    if (this.mode === MODE.TAKEOFF && (this.takeoffT += dt) > 0.6 && this.pos.y > this.targetAlt - 1.5) this.mode = MODE.FLY;
    if (this.mode === MODE.LANDING && this.pos.y < ground + 0.06) { this.pos.y = ground; this.mode = MODE.WALK; this.landed = true; }
    if (this.mode === MODE.WALK) this.pos.y = THREE.MathUtils.damp(this.pos.y, ground, 14, dt);

    // Collision with buildings (flight collides only below roof height) and the soft world edge.
    city.resolveCircle(this.pos, RADIUS, this.pos.y);
    this.hitLimit = false;
    for (const ax of ['x', 'z']) if (Math.abs(this.pos[ax]) > WORLD_LIMIT) { this.pos[ax] = Math.sign(this.pos[ax]) * WORLD_LIMIT; this.vel[ax] = 0; this.hitLimit = true; }

    // Visual lean (used by IronMan.tilt).
    const yawRate = Math.atan2(Math.sin(this.heading - prevHeading), Math.cos(this.heading - prevHeading)) / Math.max(dt, 1e-3);
    const fast = airborne ? Math.min(1, this.speed / FLY) : 0;
    this.pitch = THREE.MathUtils.damp(this.pitch, airborne ? -0.1 - fast * 0.85 : 0, 5, dt);
    this.bank = THREE.MathUtils.damp(this.bank, airborne ? THREE.MathUtils.clamp(yawRate * 0.18, -0.6, 0.6) * fast : 0, 5, dt);
  }
}


// ===== camera/ThirdPersonCamera.js =====
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Preserves the original swipe-to-orbit (yaw -= dx*.006, pitch += dy*.004) and adds pinch zoom,
// walk/fly transitions, boost FOV and building collision.
class ThirdPersonCamera {
  constructor(camera, city) {
    this.camera = camera; this.city = city;
    this.yaw = 0; this.pitch = 0.16; this.dist = 9; this.userDist = 1; this.curDist = 9;
    this.pointers = new Map(); this.pinch = 0; this.shake = 0;
    this._tmp = new THREE.Vector3(); this._dir = new THREE.Vector3(); this.pos = new THREE.Vector3(0, 4, 12);
  }
  attach(el) {
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', e => { this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); el.setPointerCapture(e.pointerId); if (this.pointers.size === 2) this.pinch = this._span(); });
    el.addEventListener('pointermove', e => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size >= 2) { const s = this._span(); this.userDist = clamp(this.userDist * (this.pinch / Math.max(s, 1)), 0.6, 2.2); this.pinch = s; }
      else { this.yaw -= dx * 0.006; this.pitch = clamp(this.pitch + dy * 0.004, -0.3, 1.0); }
    });
    const up = e => { this.pointers.delete(e.pointerId); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', e => { this.userDist = clamp(this.userDist * (1 + e.deltaY * 0.001), 0.6, 2.2); }, { passive: true });
  }
  _span() { const a = [...this.pointers.values()]; return a.length < 2 ? 1 : Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); }
  bump(amount) { this.shake = Math.max(this.shake, amount); }

  update(dt, target, { flying, boost, speed }) {
    const want = ((flying ? 26 + Math.min(6, speed * 0.05) : 8)) * this.userDist * (boost ? 1.2 : 1);
    this.curDist = THREE.MathUtils.damp(this.curDist, want, 3, dt);
    const focus = this._tmp.set(target.x, target.y + (flying ? 1.1 : 1.35), target.z);
    const off = this._dir.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch) + (flying ? 0.5 : 0.18), Math.cos(this.yaw) * Math.cos(this.pitch)).normalize();
    // Collision: pull the camera in if a building is between player and camera.
    const hit = this.city.raycast(focus, off, this.curDist + 0.5);
    const d = Math.max(1.2, Math.min(this.curDist, hit - 0.6));
    const desired = focus.clone().addScaledVector(off, d); desired.y = Math.max(desired.y, 0.6);
    // Snap in quickly when blocked, ease out when free.
    const rate = d < this.curDist ? 18 : 7;
    this.pos.lerp(desired, Math.min(1, dt * rate));
    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) { this.camera.position.x += (Math.random() - .5) * this.shake; this.camera.position.y += (Math.random() - .5) * this.shake; this.shake *= Math.pow(0.02, dt); }
    this.camera.lookAt(focus.x, focus.y + 0.1, focus.z);
    const fov = 70 + (boost ? 18 : 0) + Math.min(16, speed * 0.14);
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, fov, 4, dt); this.camera.updateProjectionMatrix();
  }
}


// ===== combat/RepulsorSystem.js =====

// Milestone-1 port of the original FIRE button (pooled: no geometry/material created per shot).
class RepulsorSystem {
  constructor(scene) {
    this.scene = scene; this.energy = 100; this.last = 0; this.shots = [];
    this.geo = new THREE.SphereGeometry(0.16, 8, 8); this.mat = new THREE.MeshBasicMaterial({ color: 0x8ff0ff, fog: false });
    this.pool = [];
  }
  fire(origins, dir) {
    const now = performance.now();
    if (this.energy < 6 || now - this.last < 220) return false;
    this.last = now; this.energy -= 6;
    for (const o of origins) {
      const m = this.pool.pop() || new THREE.Mesh(this.geo, this.mat); m.position.copy(o); this.scene.add(m);
      this.shots.push({ m, v: dir.clone().multiplyScalar(120), life: 2.2 });
    }
    return true;
  }
  update(dt, regenBlocked) {
    if (!regenBlocked) this.energy = Math.min(100, this.energy + dt * 6);
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]; s.m.position.addScaledVector(s.v, dt);
      if ((s.life -= dt) <= 0) { this.scene.remove(s.m); this.pool.push(s.m); this.shots.splice(i, 1); }
    }
  }
}


// ===== ui/HUD.js =====
const $ = id => document.getElementById(id);

// All DOM/touch handling. Joystick and buttons use pointer capture so they never leak into the camera swipe.
class HUD {
  constructor() {
    this.steer = { x: 0, y: 0 };
    this.input = { run: false, boost: false, hover: false, up: 0, down: 0 };
    this.handlers = {};
    this._joystick(); this._buttons();
  }
  on(name, fn) { this.handlers[name] = fn; }
  setLoading(text, pct) { $('loadtext').textContent = text; if (pct != null) $('loadbar').style.width = pct + '%'; }
  logError(msg) { const d = document.createElement('div'); d.textContent = '⚠ ' + msg.slice(0, 120); $('errors').appendChild(d); }
  setAssetStatus(ok, bad) { $('assetstat').textContent = `ASSETS ${ok}${bad ? ' · ' + bad + ' FAILED' : ''}`; $('assetstat').style.color = bad ? '#ff9b91' : ''; }
  hideLoading() { $('loading').classList.add('hide'); }
  toast(t) { const e = $('toast'); e.textContent = t; e.style.opacity = 1; clearTimeout(this._t); this._t = setTimeout(() => e.style.opacity = 0, 1300); }
  setFlightUI(flying) {
    for (const id of ['fly', 'run']) $(id).hidden = flying;
    for (const id of ['land', 'hover', 'boost', 'fire', 'up', 'down']) $(id).hidden = !flying;
  }
  readout(mode, alt, speedKmh, energy) {
    $('mode').textContent = mode; $('alt').textContent = alt < 0.5 ? 'GROUND' : Math.round(alt) + ' M';
    $('spd').textContent = Math.round(speedKmh) + ' KM/H'; $('nrg').textContent = Math.round(energy);
  }
  _joystick() {
    const joy = $('joy'), stick = $('stick'); let pid = null;
    const move = e => {
      const r = joy.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), max = r.width * 0.34, len = Math.hypot(dx, dy), k = Math.min(1, max / (len || 1));
      this.steer.x = dx * k / max; this.steer.y = -dy * k / max; stick.style.transform = `translate(${dx * k}px,${dy * k}px)`;
    };
    joy.addEventListener('pointerdown', e => { pid = e.pointerId; joy.setPointerCapture(pid); move(e); });
    joy.addEventListener('pointermove', e => { if (e.pointerId === pid) move(e); });
    const end = e => { if (e.pointerId !== pid) return; pid = null; this.steer.x = this.steer.y = 0; stick.style.transform = 'translate(0,0)'; };
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
  }
  _hold(id, key, val = 1) {
    const b = $(id), set = v => { this.input[key] = v ? val : (typeof val === 'number' ? 0 : false); b.classList.toggle('on', !!v); };
    b.addEventListener('pointerdown', e => { b.setPointerCapture(e.pointerId); set(true); });
    for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => set(false));
  }
  _buttons() {
    $('run').addEventListener('click', () => { this.input.run = !this.input.run; $('run').classList.toggle('on', this.input.run); this.toast(this.input.run ? 'RUN MODE' : 'WALK MODE'); });
    $('hover').addEventListener('click', () => { this.input.hover = !this.input.hover; $('hover').classList.toggle('on', this.input.hover); this.toast(this.input.hover ? 'HOVER ENGAGED' : 'HOVER OFF'); });
    $('fly').addEventListener('click', () => this.handlers.fly && this.handlers.fly());
    $('land').addEventListener('click', () => this.handlers.land && this.handlers.land());
    $('fire').addEventListener('click', () => this.handlers.fire && this.handlers.fire());
    this._hold('boost', 'boost', true); this._hold('up', 'up', 1); this._hold('down', 'down', 1);
  }
}


// ===== gameplay/RingCourse.js =====
// M3: floating rings above the rooftops. Fly through one to collect it and refill repulsor energy.
class RingCourse {
  constructor(scene, city, count = 14) {
    this.city = city; this.count = count; this.got = 0; this.rings = [];
    this.geo = new THREE.TorusGeometry(3.2, 0.14, 8, 36);
    this.mat = new THREE.MeshBasicMaterial({ color: 0x73e7ff, transparent: true, opacity: 0.85 });
    this.group = new THREE.Group(); scene.add(this.group);
  }
  build() {
    const r = rng(2031);
    for (let i = 0; i < this.count; i++) {
      const x = (r() * 2 - 1) * WORLD_LIMIT * 0.85, z = (r() * 2 - 1) * WORLD_LIMIT * 0.85;
      const y = this.city.surfaceAt(x, z) + 20 + r() * 60;
      const m = new THREE.Mesh(this.geo, this.mat);
      m.position.set(x, y, z); m.rotation.set(r() * 0.6 - 0.3, r() * Math.PI * 2, 0);
      this.group.add(m); this.rings.push({ m, done: false });
    }
  }
  update(dt, pos, rep, hud, flying) {
    const hx = pos.x, hy = pos.y + 1.1, hz = pos.z;
    for (const r of this.rings) {
      if (r.done) continue;
      r.m.rotation.z += dt * 0.6;
      if (!flying) continue;
      const dx = r.m.position.x - hx, dy = r.m.position.y - hy, dz = r.m.position.z - hz;
      if (dx * dx + dy * dy + dz * dz < 3.2 * 3.2) {
        r.done = true; r.m.visible = false; this.got++;
        rep.energy = Math.min(100, rep.energy + 20);
        hud.toast(this.got === this.count ? 'COURSE CLEAR — ALL RINGS' : `RING ${this.got} / ${this.count}`);
      }
    }
  }
}

// ===== effects/WindLines.js =====
// M4: speed streaks that rush past while flying fast. Plain line geometry, no textures.
class WindLines {
  constructor(scene, n = 80) {
    this.n = n; this.off = []; this.buf = new Float32Array(n * 6); this.seeded = false;
    for (let i = 0; i < n; i++) this.off.push(new THREE.Vector3());
    this.geo = new THREE.BufferGeometry(); this.geo.setAttribute('position', new THREE.BufferAttribute(this.buf, 3));
    this.mat = new THREE.LineBasicMaterial({ color: 0xdffbff, transparent: true, opacity: 0.6, depthWrite: false });
    this.lines = new THREE.LineSegments(this.geo, this.mat); this.lines.frustumCulled = false; this.lines.visible = false;
    scene.add(this.lines);
  }
  // Spawn in front of the hero (along its motion) so streaks come at the camera and flash past.
  _spawn(v, fx, fz) {
    const ahead = 5 + Math.random() * 8, side = (Math.random() - 0.5) * 12;
    v.set(fx * ahead - fz * side, (Math.random() - 0.3) * 8, fz * ahead + fx * side);
  }
  update(dt, pos, vel, active) {
    this.lines.visible = active;
    if (!active) return;
    const sp = Math.hypot(vel.x, vel.z), len = Math.min(14, 3 + sp * 0.2), dl = sp || 1;
    const fx = vel.x / dl, fz = vel.z / dl;
    if (!this.seeded) { this.off.forEach(v => this._spawn(v, fx, fz)); this.seeded = true; }
    for (let i = 0; i < this.n; i++) {
      const v = this.off[i];
      v.x -= vel.x * dt; v.z -= vel.z * dt;          // stationary in the world, so the hero rushes past them
      if (v.length() > 14) this._spawn(v, fx, fz);
      const sx = pos.x + v.x, sy = pos.y + 1.2 + v.y, sz = pos.z + v.z, k = i * 6;
      this.buf[k] = sx; this.buf[k + 1] = sy; this.buf[k + 2] = sz;
      this.buf[k + 3] = sx - fx * len; this.buf[k + 4] = sy; this.buf[k + 5] = sz - fz * len;
    }
    this.geo.attributes.position.needsUpdate = true;
  }
}


// ===== main.js =====

const hud = new HUD();
const failures = [];
async function boot() {
  const perf = new PerformanceManager();
  const sm = new SceneManager(perf);
  const assets = new AssetManager({ onError: m => { failures.push(m); hud.logError(m); }, onStatus: (ok, bad) => hud.setAssetStatus(ok, bad) });
  const city = new CityManager(sm.scene, assets, perf);
  const hero = new IronMan(assets, perf);
  const move = new MovementController();
  const cam = new ThirdPersonCamera(sm.camera, city);
  const rep = new RepulsorSystem(sm.scene);
  const rings = new RingCourse(sm.scene, city);
  const wind = new WindLines(sm.scene);
  cam.attach(sm.renderer.domElement);
  sm.scene.add(hero.root);
  perf.onTierChange = t => { sm.renderer.setPixelRatio(Math.min(devicePixelRatio, t.pixelRatio)); city.setRadii(t.nearRadius, t.farRadius); hud.toast('QUALITY: ' + t.name.toUpperCase()); };

  hud.setLoading('READING ASSET ARCHIVES', 2);
  await assets.mountZips(['source.zip', 'textures.zip', 'stark-city-part-1.zip', 'stark-city-part-2.zip', 'stark-city-part-3.zip', 'stark-city-part-4.zip', 'stark-animation-assets.zip'], p => hud.setLoading('READING ASSET ARCHIVES', 2 + p * 8));
  // Hero first (playable immediately), city second; either failure is reported and never blocks the loop.
  let heroOk = true, cityOk = true;
  await Promise.all([
    hero.load((t, p) => hud.setLoading(t, p * 0.45)).catch(e => { heroOk = false; hud.setLoading('MARK 85 ERROR: ' + e.message, 100); }),
    city.load((t, p) => hud.setLoading(t, 45 + p * 0.55)).catch(e => { cityOk = false; hud.logError('CITY: ' + e.message); }),
  ]);
  assets.release();
  hud.setLoading(failures.length ? `STARTED WITH ${failures.length} ASSET ERROR(S)` : 'ALL SYSTEMS ONLINE', 100);
  setTimeout(() => hud.hideLoading(), failures.length ? 2500 : 500);
  // M1: start in the air; M3: rings only once the city exists.
  if (cityOk) rings.build();
  move.startFlying(); hud.setFlightUI(true);
  hud.toast(heroOk && cityOk ? `MARK 85 ONLINE · ${rings.count} RINGS` : 'DEGRADED MODE — SEE ERRORS');

  hud.on('fly', () => { if (move.takeoff()) { hud.setFlightUI(true); cam.bump(0.05); hud.toast('TAKEOFF — THRUSTERS ENGAGED'); } });
  hud.on('land', () => { if (move.land()) hud.toast('LANDING'); });
  const tmp = new THREE.Vector3(), dir = new THREE.Vector3();
  hud.on('fire', () => {
    if (!move.flying) return;
    dir.set(-Math.sin(cam.yaw), -Math.sin(cam.pitch) * 0.3, -Math.cos(cam.yaw)).normalize();
    const o = [hero.worldPosOf('lHand', new THREE.Vector3()), hero.worldPosOf('rHand', new THREE.Vector3())];
    if (rep.fire(o, dir)) cam.bump(0.03);
  });

  const clock = new THREE.Clock();
  (function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    perf.frame(dt);
    const inp = { x: hud.steer.x, y: hud.steer.y, run: hud.input.run, boost: hud.input.boost && move.mode === MODE.FLY && rep.energy > 1, hover: hud.input.hover, up: hud.input.up, down: hud.input.down };
    move.update(dt, inp, cam.yaw, city);
    if (move.landed) { move.landed = false; hud.setFlightUI(false); hud.toast('LANDED — WALK MODE'); cam.bump(0.06); }
    if (move.hitLimit) hud.toast('EDGE OF THE MAP');
    rings.update(dt, move.pos, rep, hud, move.flying);
    wind.update(dt, move.pos, move.vel, move.flying && move.speed > 20);
    hero.root.position.copy(move.pos); hero.root.rotation.y = move.heading;
    hero.tilt.rotation.set(move.pitch, 0, move.bank);
    hero.update(dt, move.flying ? 1 : 0, move.speed, inp.boost);
    city.update(move.pos);
    rep.update(dt, inp.boost); if (inp.boost) rep.energy = Math.max(0, rep.energy - dt * 14);
    cam.update(dt, move.pos, { flying: move.flying, boost: inp.boost, speed: move.speed });
    hud.readout(move.mode, move.pos.y, move.speed * 3.6, rep.energy);
    sm.render(move.pos);
  })();
}
boot().catch(e => { console.error(e); hud.setLoading('STARTUP ERROR: ' + (e.message || e), 100); hud.logError(String(e.stack || e).split('\n')[0]); });
