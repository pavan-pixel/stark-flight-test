// PROJECT STARK — Milestone 1 bundle (built from src/ modules)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';

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
        const r = await fetch('./' + n + '?v=m21'); if (!r.ok) throw Error('HTTP ' + r.status + ' (keep ' + n + ' in the repo root)');
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
      if (/\.glb$/i.test(name)) { // binary GLB: textures are embedded, no sidecar files needed
        const buf = await f.async('arraybuffer');
        // Kenney GLBs point at an external Textures/colormap.png: read the JSON chunk and fetch those images first.
        const jlen = new DataView(buf).getUint32(12, true);
        const j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jlen)));
        await Promise.all((j.images || []).filter(x => x.uri && !x.uri.startsWith('data:')).map(x => this.url(base(x.uri))));
        const g = await new Promise((res, rej) => this.gltf.parse(buf, '', res, rej));
        this.shrinkMaterials(g.scene); this._ok(name); return g;
      }
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
  async loadEXR(name) {
    try { const t = await new EXRLoader().loadAsync(await this.url(name)); t.mapping = THREE.EquirectangularReflectionMapping; this._ok(name); return t; }
    catch (e) { this._fail(name, e); return null; }
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

const SUN_DIR = new THREE.Vector3(0.4, 0.3, -0.87).normalize();
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const gr = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,240,210,0.85)');
  gr.addColorStop(0.4, 'rgba(255,220,160,0.22)'); gr.addColorStop(1, 'rgba(255,220,160,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const FOG_COLOR = 0xcdd9e0;

// Speed motion blur: radial smear from the screen centre, strength driven by flight speed.
const MotionBlurShader = {
  uniforms: { tDiffuse: { value: null }, strength: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float strength; varying vec2 vUv; void main(){ vec2 d = (vUv - 0.5) * strength; vec4 c = texture2D(tDiffuse, vUv); float w = 1.0; for (int i = 1; i <= 6; i++) { float f = float(i) / 6.0; c += texture2D(tDiffuse, vUv - d * f); w += 1.0; } gl_FragColor = c / w; }',
};
// Colour grade: a little more contrast and saturation, warm highlights, cool shadows.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, contrast: { value: 1.12 }, sat: { value: 1.1 }, warm: { value: 0.05 }, vig: { value: 0.55 }, grain: { value: 0.035 }, time: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float contrast; uniform float sat; uniform float warm; uniform float vig; uniform float grain; uniform float time; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)); vec3 s = mix(vec3(l), c.rgb, sat); s = (s - 0.5) * contrast + 0.5; s.r += warm; s.b -= warm * 0.7; float d = length(vUv - 0.5); s *= 1.0 - smoothstep(0.3, 0.95, d) * vig; float n = fract(sin(dot(vUv * 1000.0 + vec2(time * 37.0, time * 17.0), vec2(12.9898, 78.233))) * 43758.5453); s += (n - 0.5) * grain; gl_FragColor = vec4(clamp(s, 0.0, 1.0), c.a); }',
};
// Soft round or ring-shaped flare sprites for the lens flare.
function flareTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  if (kind === 0) { g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)'); }
  else { g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.7, 'rgba(255,255,255,0)'); g.addColorStop(0.85, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)'); }
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

class SceneManager {
  constructor(perf) {
    this.perf = perf;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(FOG_COLOR);
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0021);
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
    this._environmentTarget = null;
    this._environmentSource = null;

    this.scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x3b4350, 1.1));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
    this.sun.position.copy(SUN_DIR).multiplyScalar(300);
    this.scene.add(this.sun);

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: SUN_DIR } },
      vertexShader: 'varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'varying vec3 vD;uniform vec3 sunDir;void main(){vec3 d=normalize(vD);float h=clamp(d.y,0.,1.);vec3 hor=vec3(.80,.85,.88),mid=vec3(.46,.62,.84),top=vec3(.16,.38,.72);vec3 c=mix(hor,mid,smoothstep(0.,.25,h));c=mix(c,top,smoothstep(.25,.9,h));float s=max(dot(d,sunDir),0.);c+=vec3(1.,.9,.7)*(pow(s,8.)*.12+pow(s,64.)*.22+pow(s,800.)*1.15);gl_FragColor=vec4(c,1.);}',
    }));
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);

  // Soft radial glow used for the sun flare and the boost bloom.
    this.glowTex = glowTexture();
    this.sunFlare = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xfff1d0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false, transparent: true }));
    this.sunFlare.scale.set(110, 110, 1); this.sunFlare.material.opacity = 0.07; this.sunFlare.renderOrder = 10; this.sunFlare.visible = !perf.isMobile;
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
    // Post-processing: bloom + grade + speed blur on medium/high; low tier renders directly.
    this.post = perf.tier.name !== 'low';
    if (this.post) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.28, 0.35, 0.88);
      this.composer.addPass(this.bloom);
      this.grade = new ShaderPass(GradeShader); this.composer.addPass(this.grade);
      this.blur = new ShaderPass(MotionBlurShader); this.composer.addPass(this.blur);
      this.composer.addPass(new OutputPass());
      this._pr = this.renderer.getPixelRatio();
    }
    // Lens flare is enabled on mobile too; previously it was hidden inside
    // the desktop post-processing branch, so iPhones never rendered it.
    this.lensflare = new Lensflare();
    this.lensflare.addElement(new LensflareElement(flareTexture(0), 48, 0, new THREE.Color(1, 0.88, 0.7)));
    this.lensflare.addElement(new LensflareElement(flareTexture(1), 34, 0.32, new THREE.Color(1, 0.78, 0.48)));
    this.lensflare.addElement(new LensflareElement(flareTexture(1), 58, 0.62, new THREE.Color(0.62, 0.8, 1)));
    this.lensflare.addElement(new LensflareElement(flareTexture(0), 22, 0.92, new THREE.Color(1, 0.68, 0.38)));
    this.lensflare.visible = !perf.isMobile; this.scene.add(this.lensflare);
    addEventListener('resize', () => this.resize());
    perf.onTierChange = t => this.renderer.setPixelRatio(Math.min(devicePixelRatio, t.pixelRatio));
  }
  setEnvironment(texture) {
    if (!texture) return false;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const target = pmrem.fromEquirectangular(texture);
    pmrem.dispose();
    if (this._environmentTarget) this._environmentTarget.dispose();
    if (this._environmentSource && this._environmentSource !== texture) this._environmentSource.dispose();
    this._environmentTarget = target;
    this._environmentSource = texture;
    // Keep the procedural sky dome as the visible world background.
    // The EXR is an image-based lighting source only; using it as the background
    // creates a flat photographic street horizon behind the 3D city.
    this.scene.environment = target.texture;
    this.sky.visible = true;
    return true;
  }
  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    if (this.composer) this.composer.setSize(innerWidth, innerHeight);
  }
  render(hero, motion = { speed: 0, boost: false }) {
    this.sky.position.copy(this.camera.position);
    const sunPos = this.camera.position.clone().addScaledVector(SUN_DIR, 2800);
    this.sunFlare.position.copy(sunPos);
    if (this.lensflare) this.lensflare.position.copy(sunPos);
    if (this.shadows && hero) {
      this.sun.target.position.set(hero.x, 0, hero.z);
      this.sun.position.copy(this.sun.target.position).addScaledVector(SUN_DIR, 300);
    }
    if (this.composer) {
      const pr = this.renderer.getPixelRatio();
      if (pr !== this._pr) { this._pr = pr; this.composer.setPixelRatio(pr); this.composer.setSize(innerWidth, innerHeight); }
      this.blur.uniforms.strength.value = Math.min(0.06, Math.max(0, (motion.speed - 25) * 0.0012)) + (motion.boost ? 0.02 : 0);
      this.grade.uniforms.time.value = performance.now() * 0.001;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}


// ===== environment/CityManager.js =====

// Grid layout (metres). Roads run along lines x = k*PITCH and z = k*PITCH.
const PITCH = 110, BLOCK = 86, HALF = BLOCK / 2, GRID = 12, SLOT = 37, PAD_H = 0.12;
const WORLD_LIMIT = (GRID / 2) * PITCH + PITCH * 0.5;
// Building models are discovered automatically from every mounted ZIP (any file named building_*.gltf).
const buildingNames = (assets) => [...assets.entries.keys()].filter(k => /^building[-_].*\.(gltf|glb)$/.test(k));

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), C = new THREE.Color();

class CityManager {
  constructor(scene, assets, perf) {
    this.scene = scene; this.assets = assets; this.perf = perf;
    this.group = new THREE.Group(); scene.add(this.group);
    this.templates = []; this.suburbanTemplates = []; this.placements = []; this.colliders = []; this.parks = [];
    this.nearMeshes = []; this.farMesh = null; this.ringCount = 0;
    this.lastUpdate = new THREE.Vector3(1e9, 0, 1e9);
    this.near = perf.tier.nearRadius; this.far = perf.tier.farRadius;
  }

  async load(progress = () => {}) {
    const a = this.assets; a.maxTex = this.perf.tier.texSize; a.dropNormals = !this.perf.tier.normalMaps; const base = '';
    progress('LOADING BUILDING MODELS', 10);
    const names = buildingNames(a);
    if (!names.length) throw new Error('No building_*.gltf models found in any ZIP');
    // Only request optional suburban assets that actually exist in the mounted archives.
    // Missing optional files should never delay the core city build.
    const suburbanNames = Array.from({ length: 8 }, (_, i) => `suburban-building-type-${String.fromCharCode(97 + i)}.glb`).filter(n => a.has(n));
    const [gb, suburban, treeLarge, treeSmall, decalCross, decalYellow] = await Promise.all([
      Promise.all(names.map(n => a.loadGLTF(n).catch(() => null))),
      Promise.all(suburbanNames.map(n => a.loadGLTF(n).catch(() => null))),
      a.has('suburban-tree-large.glb') ? a.loadGLTF('suburban-tree-large.glb').catch(() => null) : Promise.resolve(null),
      a.has('suburban-tree-small.glb') ? a.loadGLTF('suburban-tree-small.glb').catch(() => null) : Promise.resolve(null),
      a.loadGLTF(base + 'Decal_Crosswalk.gltf'), a.loadGLTF(base + 'Decal_DoubleYellow_Straight.gltf'),
    ]);
    progress('PROCESSING CITY GEOMETRY', 55);
    gb.forEach(g => { if (g) this.templates.push(this._template(g.scene)); });
    suburban.forEach(g => { if (g) { this.templates.push(this._template(g.scene)); this.suburbanTemplates.push(this.templates.length - 1); } });
    if (!this.templates.length) throw new Error('All building models failed to load');
    const [asphalt, concrete, detailedAsphalt, asphaltNormal, asphaltRough, detailedConcrete, concreteNormal, concreteRough] = await Promise.all([
      a.loadTexture(base + 'T_Concrete_Asphalt_BaseColor.png', { srgb: true, repeat: 260 }),
      a.loadTexture(base + 'T_Concrete_BaseColor.png', { srgb: true, repeat: 14 }),
      a.loadTexture('asphalt-color.jpg', { srgb: true, repeat: 260 }),
      this.perf.tier.normalMaps ? a.loadTexture('asphalt-normal.jpg', { repeat: 260 }) : Promise.resolve(null),
      a.loadTexture('asphalt-roughness.jpg', { repeat: 260 }),
      a.loadTexture('concrete-color.jpg', { srgb: true, repeat: 14 }),
      this.perf.tier.normalMaps ? a.loadTexture('concrete-normal.jpg', { repeat: 14 }) : Promise.resolve(null),
      a.loadTexture('concrete-roughness.jpg', { repeat: 14 }),
    ]);
    progress('BUILDING STREETS', 70);
    this._generate();
    this._buildGround(detailedAsphalt || asphalt, detailedConcrete || concrete, asphaltNormal, asphaltRough, concreteNormal, concreteRough);
    this._buildBuildingInstances();
    this._buildFarAndSkyline();
    this._buildDecals(decalCross.scene, decalYellow.scene);
    this._buildStreetLights();
    if (treeLarge && treeSmall) this._buildNature(treeLarge.scene, treeSmall.scene);
    this.update(new THREE.Vector3(0, 0, 0), true);
    progress('CITY READY', 100);
  }

  _template(root) {
    root.updateMatrixWorld(true);
    const meshes = [];
    // Bake each GLTF child transform into its geometry before instancing.
    root.traverse(o => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone();
      geometry.applyMatrix4(o.matrixWorld);
      meshes.push({ geometry, material: o.material });
    });
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
        const useSuburban = this.suburbanTemplates.length && dist > 0.58 && r() < 0.72;
        const ti = useSuburban ? this.suburbanTemplates[Math.floor(r() * this.suburbanTemplates.length)] : Math.floor(r() * (this.templates.length - this.suburbanTemplates.length));
        const t = this.templates[ti];
        const faceZ = r() < 0.5;
        const rot = faceZ ? (qz > 0 ? 0 : Math.PI) : (qx > 0 ? Math.PI / 2 : -Math.PI / 2);
        const target = 31 + r() * 5; // fills the block quadrant (31-36 m), so neighbours sit flush
        const s = Math.min(target / t.w, target / t.d);
        const sy = Math.min(95 / t.h, s * (0.85 + r() * 0.5) * (1 + (1 - Math.min(1, dist)) * 0.7)); // cap towers at 95 m so the 70 m flight height stays above the skyline mostly
        // Non-uniform scale: same model comes out wider/narrower and deeper/shallower per building (capped to the 36 m block).
        const sx = Math.min(s * (0.92 + r() * 0.1), 36 / t.w), sz = Math.min(s * (0.92 + r() * 0.1), 36 / t.d);
        const sw = t.w * sx, sd = t.d * sz;
        const hx = (faceZ ? sw : sd) / 2, hz = (faceZ ? sd : sw) / 2;
        const px = faceZ ? cx + qx * SLOT / 2 : cx + qx * (SLOT - hx);
        const pz = faceZ ? cz + qz * (SLOT - hz) : cz + qz * SLOT / 2;
        M.compose(V.set(px, 0, pz), Q.setFromAxisAngle(UP, rot), S.set(sx, sy, sz));
        M.multiply(new THREE.Matrix4().makeTranslation(-t.cx, -t.min.y, -t.cz));
        let height = t.h * sy;
        const sh = 0.55 + r() * 0.75, wa = 0.85 + r() * 0.3;
        // Keep one complete building per plot; stacking unrelated GLTFs caused floating roofs and overlap blocks.
        const top = null;
        this.placements.push({ ti, px, pz, hx, hz, height, top, matrix: M.clone(), tint: 0.55 + r() * 0.3, color: new THREE.Color().setRGB(sh * wa, sh, sh / wa) });
        this.colliders.push({ minX: px - hx, maxX: px + hx, minZ: pz - hz, maxZ: pz + hz, h: height });
      }
    }
  }

  _buildNature(largeRoot, smallRoot) {
    const roots = [largeRoot, smallRoot], bounds = roots.map(root => new THREE.Box3().setFromObject(root));
    const r = rng(64021), count = this.perf.isMobile ? 30 : 62;
    const addTree = (root, box, x, z, scale) => {
      const tree = root.clone(true);
      tree.position.set(x - (box.min.x + box.max.x) * 0.5 * scale, -box.min.y * scale, z - (box.min.z + box.max.z) * 0.5 * scale);
      tree.scale.setScalar(scale); tree.rotation.y = r() * Math.PI * 2;
      tree.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
      this.group.add(tree);
    };
    let made = 0;
    for (const park of this.parks) {
      for (let i = 0, n = this.perf.isMobile ? 3 : 5; i < n && made < count; i++, made++) {
        const k = r() < 0.55 ? 0 : 1;
        addTree(roots[k], bounds[k], park.cx + (r() - 0.5) * 52, park.cz + (r() - 0.5) * 52, (k ? 5.5 : 7.5) * (0.85 + r() * 0.35));
      }
    }
    for (let axis = 0; axis < 2 && made < count; axis++) for (let road = 1; road < GRID && made < count; road++) {
      for (let along = 0; along < GRID && made < count; along += 2) {
        const lane = (road - GRID / 2) * PITCH, offset = (along - GRID / 2 + 0.5) * PITCH;
        const k = r() < 0.7 ? 0 : 1, side = r() < 0.5 ? -1 : 1;
        addTree(roots[k], bounds[k], axis === 0 ? offset : lane + side * (HALF + 5), axis === 0 ? lane + side * (HALF + 5) : offset, (k ? 4.5 : 6.2) * (0.85 + r() * 0.3));
        made++;
      }
    }
  }

  _buildGround(asphalt, concrete, asphaltNormal = null, asphaltRough = null, concreteNormal = null, concreteRough = null) {
    const size = GRID * PITCH + 2000;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: asphalt, normalMap: asphaltNormal, roughnessMap: asphaltRough, color: 0xbdbdbd, roughness: 0.95, metalness: 0, envMapIntensity: 0.2 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true; this.group.add(ground);
    const padGeo = new THREE.BoxGeometry(BLOCK, PAD_H, BLOCK); padGeo.translate(0, PAD_H / 2, 0);
    const pads = new THREE.InstancedMesh(padGeo, new THREE.MeshStandardMaterial({ map: concrete, normalMap: concreteNormal, roughnessMap: concreteRough, color: 0xcfcfcf, roughness: 0.9, envMapIntensity: 0.2 }), GRID * GRID);
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
    const source = t.name.slice(0, i).split(/[|:]/).pop().replace(/^mixamorig:?/i, '');
    const prop = t.name.slice(i), keyName = source.toLowerCase();
    const direct = boneKeys.get(keyName);
    const mappedName = UE_TO_MIXAMO[keyName];
    const target = direct || (mappedName && boneKeys.get(mappedName.toLowerCase()));
    if (!target) continue;
    // Preserve hips rotation but ignore root translation: world movement belongs to the controller.
    if ((keyName === 'hips' || keyName === 'pelvis') && prop === '.position') continue;
    t.name = target + prop;
    tracks.push(t);
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
    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.bloom.material.map, color: 0x9fe8ff, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true, opacity: 0 }));
    this.aura.position.set(0, 1.1, 0); this.aura.scale.set(3.6, 3.6, 1); this.aura.renderOrder = 7; this.root.add(this.aura);
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
    const files = {
      idle: ['Idle.fbx', 'Idle_relaxed.fbx'],
      idleTransition: ['Action Idle To Standing Idle.fbx'],
      walk: ['Walking.fbx', 'Walk_forwards.fbx'],
      run: ['Running.fbx', 'Run_sprint.fbx'],
      takeoff: ['Jumping.fbx'],
      fly: ['Flying.fbx', 'Jump_in_the_air.fbx'],
      hover: ['Floating.fbx'],
      fall: ['Falling Idle.fbx'],
      land: ['Falling To Landing.fbx'],
    };
    await Promise.all(Object.entries(files).map(async ([keyName, candidates]) => {
      for (const fileName of candidates) {
        try {
          const o = await this.assets.loadFBX(fileName);
          const raw = o.animations && o.animations[0];
          const clip = raw && retargetClip(raw, boneKeys);
          if (clip && clip.tracks.length >= 2) {
            const action = this.mixer.clipAction(clip);
            action.setLoop(THREE.LoopRepeat);
            action.play(); action.setEffectiveWeight(0);
            this.actions[keyName] = action;
            return;
          }
          this.assets.onError('ANIM ' + fileName + ': no compatible bone tracks');
        } catch (e) { /* try legacy filename where available */ }
      }
      if (!this.actions[keyName]) this.assets.onError('ANIM ' + keyName + ': no compatible FBX clip found');
    }));
    const loaded = Object.keys(this.actions).length;
    this.assets.onStatus(loaded, 0);
    if (!this.actions.idle) this.assets.onError('ANIM: idle clip unavailable; suit will use bind pose');
    this.play('idle');
  }
  play(name, oneShot = false) {
    const next = this.actions && this.actions[name];
    if (!next || next === this.current) return;
    next.reset(); next.enabled = true;
    next.setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat, oneShot ? 1 : Infinity);
    next.clampWhenFinished = oneShot;
    next.setEffectiveWeight(1).fadeIn(0.22);
    if (this.current) this.current.fadeOut(0.22);
    this.current = next;
    this.currentName = name;
  }

  _bloomTex() {
    const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(180,240,255,0.6)'); gr.addColorStop(1, 'rgba(120,220,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // Thruster glow follows the real hand/foot bones; intensity = flight state.
  update(dt, flightAmount, speed = 0, boost = false, mode = 'WALK', verticalSpeed = 0, hovering = false) {
    this.flying += (flightAmount - this.flying) * Math.min(1, dt * 6);
    if (this.mixer) {
      this.mixer.update(dt);
      let desired = 'idle', oneShot = false;
      if (mode === 'TAKEOFF') {
        this.takeoffAnimTime = (this.takeoffAnimTime || 0) + dt;
        desired = this.takeoffAnimTime < 0.72 ? 'takeoff' : 'fly';
      } else if (mode === 'LANDING') {
        desired = 'land'; oneShot = true;
      } else if (mode === 'FLIGHT') {
        desired = verticalSpeed < -3 ? 'fall' : (hovering || speed < 1.5 ? 'hover' : 'fly');
      } else {
        if (this.previousMode === 'LANDING') { desired = 'idleTransition'; oneShot = true; }
        else if (speed > 7) desired = 'run';
        else if (speed > 0.6) desired = 'walk';
        this.takeoffAnimTime = 0;
      }
      if (!this.actions[desired]) {
        desired = mode === 'FLIGHT' ? (verticalSpeed < -3 ? 'fly' : 'hover') :
          (mode === 'TAKEOFF' ? 'fly' : mode === 'LANDING' ? 'idle' :
            (speed > 7 ? 'run' : speed > 0.6 ? 'walk' : 'idle'));
        oneShot = false;
      }
      this.play(desired, oneShot);
      this.previousMode = mode;
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
    if (this.aura) { const a = this.flying * (boost ? 0.4 : 0.22); this.aura.material.opacity += (a - this.aura.material.opacity) * Math.min(1, dt * 6); }
    if (this.chestLight) { this.chestLight.position.set(0, 1.4, -0.25); this.chestLight.intensity = 1.6 + this.flying * 1.6 + (boost ? 4 : 0); }
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
  // Walk-first startup: LAND puts Mark 85 on the nearest surface (street or rooftop).
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
    const want = (flying ? (boost ? 22 : 4.5) + Math.min(5, speed * 0.04) : 5.4) * this.userDist;
    this.curDist = THREE.MathUtils.damp(this.curDist, want, 2.2, dt);
    const focus = this._tmp.set(target.x, target.y + (flying ? 0.95 : 1.15), target.z);
    const off = this._dir.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch) + (flying ? 0.14 : 0.18), Math.cos(this.yaw) * Math.cos(this.pitch)).normalize();
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
    const fov = (flying ? 66 : 62) + (boost ? 18 : 0) + Math.min(14, speed * 0.12);
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
  update(dt, regenBlocked, mission = null, hud = null) {
    if (!regenBlocked) this.energy = Math.min(100, this.energy + dt * 6);
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i]; s.m.position.addScaledVector(s.v, dt);
      if (mission && mission.hit(s.m.position, hud)) s.life = 0;
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
    $('cine').addEventListener('click', () => this.handlers.cine && this.handlers.cine());
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
// Speed streaks: soft additive strips that face the camera and stretch along the motion (no hard lines).
function streakTexture() {
  const c = document.createElement('canvas'); c.width = 32; c.height = 256; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(230,248,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
class WindLines {
  constructor(scene, n = 90) {
    this.n = n; this.seeded = false;
    this.off = []; this.w = []; this.l = [];
    for (let i = 0; i < n; i++) { this.off.push(new THREE.Vector3()); this.w.push(0.12); this.l.push(6); }
    this.mat = new THREE.MeshBasicMaterial({ map: streakTexture(), color: 0xcfeeff, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.mat, n);
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 8;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._P = new THREE.Vector3(); this._X = new THREE.Vector3(); this._Y = new THREE.Vector3(); this._Z = new THREE.Vector3(); this._C = new THREE.Vector3();
  }
  _spawn(i, fx, fz) {
    const ahead = 4 + Math.random() * 36, side = (Math.random() - 0.5) * 40, up = (Math.random() - 0.4) * 24;
    this.off[i].set(fx * ahead - fz * side, up, fz * ahead + fx * side);
    this.w[i] = 0.12 + Math.random() * 0.25; this.l[i] = 4 + Math.random() * 10;
  }
  update(dt, pos, vel, active, camPos) {
    this.mesh.visible = active;
    if (!active) return;
    const sp = Math.hypot(vel.x, vel.z), dl = sp || 1, fx = vel.x / dl, fz = vel.z / dl;
    if (!this.seeded) { for (let i = 0; i < this.n; i++) this._spawn(i, fx, fz); this.seeded = true; }
    const stretch = 0.5 + Math.min(1, sp / 60);
    this._Y.set(fx, 0, fz);
    for (let i = 0; i < this.n; i++) {
      const v = this.off[i];
      v.x -= vel.x * dt; v.z -= vel.z * dt;                 // stationary in the world: the hero rushes past them
      if (v.length() > 45) this._spawn(i, fx, fz);
      this._P.set(pos.x + v.x, pos.y + 1.2 + v.y, pos.z + v.z);
      this._C.copy(camPos).sub(this._P).normalize();
      this._X.crossVectors(this._Y, this._C); if (this._X.lengthSq() < 1e-6) this._X.set(1, 0, 0); this._X.normalize();
      this._Z.crossVectors(this._X, this._Y).normalize();   // faces the camera
      const xs = this._X.clone().multiplyScalar(this.w[i]), ys = this._Y.clone().multiplyScalar(this.l[i] * stretch);
      this._m.makeBasis(xs, ys, this._Z); this._m.setPosition(this._P);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}


// ===== city/TrafficSystem.js =====
// Lightweight instanced traffic on the grid streets. No per-car draw calls.
class TrafficSystem {
  constructor(scene, perf) {
    this.count = perf.isMobile ? 14 : 24;
    this.items = [];
    const bodyGeo = new THREE.BoxGeometry(4.2, 1.05, 1.9);
    bodyGeo.translate(0, 0.78, 0);
    const cabinGeo = new THREE.BoxGeometry(2.15, 0.82, 1.62);
    cabinGeo.translate(-0.12, 1.62, 0);
    const glassGeo = new THREE.BoxGeometry(1.72, 0.54, 1.66);
    glassGeo.translate(-0.12, 1.66, 0);
    this.body = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.38, metalness: 0.42 }), this.count);
    this.cabin = new THREE.InstancedMesh(cabinGeo, new THREE.MeshStandardMaterial({ color: 0x252d38, roughness: 0.5, metalness: 0.35 }), this.count);
    this.glass = new THREE.InstancedMesh(glassGeo, new THREE.MeshStandardMaterial({ color: 0x7ca8bb, roughness: 0.18, metalness: 0.55, transparent: true, opacity: 0.82 }), this.count);
    this.body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cabin.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.models = [];
    this.items = Array.from({ length: this.count }, (_, i) => ({
      axis: i % 2, road: (i * 3) % 11, lane: i % 4 < 2 ? -4.3 : 4.3,
      dir: i % 4 < 2 ? 1 : -1, offset: ((i * 67) % 1200) - 600,
      speed: 9 + (i * 7 % 10), phase: i * 0.37
    }));
    const dummy = new THREE.Object3D(), color = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      color.setHSL((i * 0.173) % 1, 0.42, 0.42);
      this.body.setColorAt(i, color);
    }
    this.body.instanceColor.needsUpdate = true;
    scene.add(this.body, this.cabin, this.glass);
    this.dummy = dummy;
    this.scene = scene;
  }
  async loadModels(assets) {
    const names = ['sedan', 'suv', 'taxi', 'van', 'police', 'delivery', 'truck', 'ambulance'];
    const loaded = (await Promise.all(names.map(n => assets.loadGLTF(`vehicle-${n}.glb`).catch(() => null)))).filter(Boolean);
    if (!loaded.length) return false;
    const bounds = loaded.map(g => new THREE.Box3().setFromObject(g.scene));
    for (let i = 0; i < this.count; i++) {
      const k = i % loaded.length, root = loaded[k].scene.clone(true), box = bounds[k], size = box.getSize(new THREE.Vector3());
      const scale = 4.2 / Math.max(size.x, size.z, 0.01);
      root.position.set(-(box.min.x + box.max.x) * 0.5 * scale, -box.min.y * scale, -(box.min.z + box.max.z) * 0.5 * scale);
      root.scale.setScalar(scale);
      root.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
      const holder = new THREE.Group(); holder.add(root); holder.visible = false; holder.userData.yawOffset = size.z > size.x ? Math.PI / 2 : 0;
      this.models.push(holder); this.scene.add(holder);
    }
    this.body.visible = this.cabin.visible = this.glass.visible = false;
    return true;
  }
  update(dt, focus) {
    const d = this.dummy;
    for (let i = 0; i < this.count; i++) {
      const v = this.items[i];
      v.offset += v.dir * v.speed * dt;
      if (v.offset > 680) v.offset = -680;
      if (v.offset < -680) v.offset = 680;
      const boundary = (v.road - 5) * 110;
      const x = v.axis === 0 ? v.offset : boundary + v.lane;
      const z = v.axis === 0 ? boundary + v.lane : v.offset;
      const yaw = v.axis === 0 ? (v.dir > 0 ? 0 : Math.PI) : (v.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      const distance = Math.hypot(x - focus.x, z - focus.z);
      const visible = distance < 520;
      if (this.models[i]) {
        const car = this.models[i]; car.visible = visible; car.position.set(x, 0, z); car.rotation.y = yaw + car.userData.yawOffset;
      } else {
        d.position.set(x, 0, z); d.rotation.set(0, yaw, 0); d.scale.setScalar(visible ? 1 : 0.0001); d.updateMatrix();
        this.body.setMatrixAt(i, d.matrix); this.cabin.setMatrixAt(i, d.matrix); this.glass.setMatrixAt(i, d.matrix);
      }
    }
    this.body.instanceMatrix.needsUpdate = this.cabin.instanceMatrix.needsUpdate = this.glass.instanceMatrix.needsUpdate = true;
  }
}


class CinematicDirector {
 constructor(camera,hero){this.camera=camera;this.hero=hero;this.enabled=true;this.mode='INTRO';this.time=0;this.duration=6.5;this.tmp=new THREE.Vector3();}
 trigger(mode,duration=1.8){this.mode=mode;this.time=0;this.duration=duration;this.enabled=true;}
 toggle(){this.enabled=!this.enabled;this.mode=this.enabled?'FOLLOW':'MANUAL';return this.enabled;}
 update(dt,move){
  if(!this.enabled)return;this.time+=dt;
  const h=this.hero.root.position,yaw=this.hero.root.rotation.y;
  const f=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)),r=new THREE.Vector3(f.z,0,-f.x);
  const p=this.tmp,target=new THREE.Vector3(h.x,h.y+1.1,h.z);
  if(this.mode==='INTRO'){
   const t=THREE.MathUtils.clamp(this.time/this.duration,0,1),e=t*t*(3-2*t);
   p.set(h.x+1.5,h.y+1.9,h.z+2.4).lerp(new THREE.Vector3(h.x-f.x*9+3,h.y+4.8,h.z-f.z*9+11),e);
   if(t>=1){this.mode='FOLLOW';this.time=0;}
  }else if(this.mode==='TAKEOFF'||this.mode==='BOOST'||this.mode==='LANDING'){
   const t=THREE.MathUtils.clamp(this.time/this.duration,0,1);
   const d=this.mode==='BOOST'?15: this.mode==='LANDING'?8:7;
   p.set(h.x-f.x*(d*t+3)+r.x*(this.mode==='LANDING'?5:3),h.y+2+(1-t)*(this.mode==='LANDING'?3:1),h.z-f.z*(d*t+3)+r.z*(this.mode==='LANDING'?5:3));
   if(t>=1){this.mode='FOLLOW';this.time=0;}
  }else{
   const d=move.mode===MODE.FLY?(move.speed>35?13:8):6;
   p.set(h.x-f.x*d+r.x*2.2,h.y+(move.mode===MODE.FLY?3.4:2.1),h.z-f.z*d+r.z*2.2);
  }
  this.camera.position.lerp(p,Math.min(1,dt*3.8));this.camera.lookAt(target);
  this.camera.fov=THREE.MathUtils.damp(this.camera.fov,this.mode==='INTRO'?42:(this.mode==='BOOST'?78:58),2.8,dt);this.camera.updateProjectionMatrix();
 }
}
class StoryMission {
 constructor(scene){this.targets=[];this.complete=false;this.group=new THREE.Group();scene.add(this.group);
  const core=new THREE.MeshStandardMaterial({color:0x263746,metalness:.8,roughness:.3}),red=new THREE.MeshBasicMaterial({color:0xff633f});
  const body=new THREE.SphereGeometry(.62,10,8),wing=new THREE.BoxGeometry(2.2,.22,.55),eye=new THREE.SphereGeometry(.18,8,6);
  for(let i=0;i<3;i++){const root=new THREE.Group();root.add(new THREE.Mesh(body,core));root.add(new THREE.Mesh(wing,core));const e=new THREE.Mesh(eye,red);e.position.z=-.52;root.add(e);root.position.set((i-1)*34,32+i*8,-155-i*24);this.group.add(root);this.targets.push({root,alive:true,phase:i*2});}
 }
 hit(point,hud){let found=null,dmin=5.5;for(const t of this.targets)if(t.alive){const d=t.root.position.distanceTo(point);if(d<dmin){found=t;dmin=d;}}if(!found)return false;found.alive=false;found.root.visible=false;const n=this.targets.filter(t=>t.alive).length;if(hud)hud.toast(n?'HOSTILE DRONE DISABLED · '+(3-n)+'/3':'MISSION COMPLETE — SECTOR SECURE');if(!n)this.complete=true;return true;}
 update(dt,hud){for(const t of this.targets)if(t.alive){t.phase+=dt;t.root.position.y+=Math.sin(t.phase*1.5)*dt*1.2;t.root.rotation.y+=dt*.5;}const el=document.getElementById('mission');if(el)el.textContent=this.complete?'OBJECTIVE COMPLETE · SECTOR SECURE':'PROTOCOL 01 · NEUTRALIZE HOSTILE DRONES · '+(3-this.targets.filter(t=>t.alive).length)+'/3';}
}

// ===== main.js =====

let gameStarted = false;
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
  const cine = new CinematicDirector(sm.camera, hero);
  const mission = new StoryMission(sm.scene);
  const traffic = new TrafficSystem(sm.scene, perf);
  cam.attach(sm.renderer.domElement);
  sm.scene.add(hero.root);
  perf.onTierChange = t => { sm.renderer.setPixelRatio(Math.min(devicePixelRatio, t.pixelRatio)); city.setRadii(t.nearRadius, t.farRadius); hud.toast('QUALITY: ' + t.name.toUpperCase()); };

  hud.setLoading('READING ASSET ARCHIVES', 2);
  await assets.mountZips(['source.zip', 'textures.zip', 'stark-city-part-1.zip', 'stark-city-part-2.zip', 'stark-city-part-3.zip', 'stark-city-part-4.zip', 'stark-animation-assets.zip', 'stark-next-animations.zip', 'stark-next-city.zip', 'stark-next-apartments.zip', 'kenney_city-kit-commercial_2_1.zip', 'stark-environment-pack.zip'], p => hud.setLoading('READING ASSET ARCHIVES', 2 + p * 8));
  // Hero first (playable immediately), city second; either failure is reported and never blocks the loop.
  let heroOk = true, cityOk = true;
  await Promise.all([
    hero.load((t, p) => hud.setLoading(t, p * 0.45)).catch(e => { heroOk = false; hud.setLoading('MARK 85 ERROR: ' + e.message, 100); }),
    city.load((t, p) => hud.setLoading(t, 45 + p * 0.55)).catch(e => { cityOk = false; hud.logError('CITY: ' + e.message); }),
    traffic.loadModels(assets).catch(e => { hud.logError('TRAFFIC MODELS: ' + e.message); return false; }),
  ]);
  const environment = await assets.loadEXR('modern_evening_street_1k.exr').catch(() => null);
  if (environment) sm.setEnvironment(environment);
  assets.release();
  hud.setLoading(failures.length ? `STARTED WITH ${failures.length} ASSET ERROR(S)` : 'ALL SYSTEMS ONLINE', 100);
  setTimeout(() => hud.hideLoading(), failures.length ? 2500 : 500);
  // Start grounded in WALK mode. Flight begins only when the player presses FLY.
  move.pos.y = city.surfaceAt(move.pos.x, move.pos.z);
  move.mode = MODE.WALK;
  hud.setFlightUI(false);
  hud.toast(heroOk && cityOk ? "MARK 85 ONLINE" : 'DEGRADED MODE — SEE ERRORS');

  hud.on('fly', () => { if (move.takeoff()) { hud.setFlightUI(true); cam.bump(0.05); cine.trigger('TAKEOFF', 1.7); hud.toast('TAKEOFF — THRUSTERS ENGAGED'); } });
  hud.on('land', () => { if (move.land()) { cine.trigger('LANDING', 2.0); hud.toast('LANDING'); } });
  hud.on('start', () => { gameStarted = true; document.getElementById('mainmenu').classList.add('hide'); cine.enabled = false; });
  hud.on('tutorial', () => document.getElementById('tutorial').classList.toggle('show'));
  hud.on('cine', () => { const on=cine.toggle(); hud.toast(on?'CINEMATIC CAMERA':'MANUAL CAMERA'); });
  const tmp = new THREE.Vector3(), dir = new THREE.Vector3();
  hud.on('fire', () => {
    if (!gameStarted || !move.flying) return;
    dir.set(-Math.sin(cam.yaw), -Math.sin(cam.pitch) * 0.3, -Math.cos(cam.yaw)).normalize();
    const o = [hero.worldPosOf('lHand', new THREE.Vector3()), hero.worldPosOf('rHand', new THREE.Vector3())];
    if (rep.fire(o, dir)) { cam.bump(0.08); hero.firePulse = 0.16; }
  });

  const clock = new THREE.Clock();
  (function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    perf.frame(dt);
    if (!gameStarted) { cine.update(dt, move); hero.root.position.copy(move.pos); city.update(move.pos); traffic.update(dt, move.pos); sm.render(move.pos, {}); return; }
    const inp = { x: hud.steer.x, y: hud.steer.y, run: hud.input.run, boost: hud.input.boost && move.mode === MODE.FLY && rep.energy > 1, hover: hud.input.hover, up: hud.input.up, down: hud.input.down };
    move.update(dt, inp, cam.yaw, city);
    if (move.landed) { move.landed = false; hud.setFlightUI(false); hud.toast('LANDED — WALK MODE'); cam.bump(0.06); }
    if (move.hitLimit) hud.toast('EDGE OF THE MAP');
    if (inp.boost && !cine.boostWasOn) cine.trigger('BOOST',1.25); cine.boostWasOn=inp.boost;
    rings.update(dt, move.pos, rep, hud, move.flying);
    wind.update(dt, move.pos, move.vel, move.flying && move.speed > 20, sm.camera.position);
    hero.root.position.copy(move.pos); hero.root.rotation.y = move.heading;
    hero.tilt.rotation.set(move.pitch, 0, move.bank);
    hero.update(dt, move.flying ? 1 : 0, move.speed, inp.boost, move.mode, move.vel.y, inp.hover);
    city.update(move.pos);
    traffic.update(dt, move.pos);
    rep.update(dt, inp.boost, mission, hud); mission.update(dt, hud); if (inp.boost) rep.energy = Math.max(0, rep.energy - dt * 14);
    if (cine.enabled) cine.update(dt, move); else cam.update(dt, move.pos, { flying: move.flying, boost: inp.boost, speed: move.speed });
    hud.readout(move.mode, move.pos.y, move.speed * 3.6, rep.energy);
    sm.render(move.pos, { speed: move.speed, boost: inp.boost });
  })();
}
boot().catch(e => { console.error(e); hud.setLoading('STARTUP ERROR: ' + (e.message || e), 100); hud.logError(String(e.stack || e).split('\\n')[0]); });
