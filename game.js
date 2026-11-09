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
    this.entries = new Map(); this.entryPriority = new Map(); this.urls = new Map(); this.textures = new Map();
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
    await Promise.all(names.map(async (n, priority) => {
      try {
        const r = await fetch('./' + n + '?v=m21'); if (!r.ok) throw Error('HTTP ' + r.status + ' (keep ' + n + ' in the repo root)');
        const z = await JSZip.loadAsync(await r.arrayBuffer());
        // ZIPs mount concurrently. Resolve duplicate basenames by the explicit
        // archive order, not network completion order; later archives have priority.
        for (const f of Object.values(z.files)) if (!f.dir) {
          const k=lc(base(f.name)), previous=this.entryPriority.get(k);
          if(previous===undefined || priority>=previous) {
            this.entries.set(k,f);
            this.entryPriority.set(k,priority);
          }
        }
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
      if (lc(name) === 'newyork.fbx') await this.prefetch(/^new york-\d+-texture\.png$/i);
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
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00145);
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 3500);
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, perf.tier.pixelRatio));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    document.body.prepend(this.renderer.domElement);

    // Image-based lighting (procedural, no download) for metal reflections.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this._environmentTarget = null;
    this._environmentSource = null;

    this.scene.add(new THREE.HemisphereLight(0xd9edff, 0x252f3b, 1.35));
    this.scene.add(new THREE.AmbientLight(0x71849a, 0.22));
    this.sun = new THREE.DirectionalLight(0xffe6c2, 3.0);
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
    // Mobile gets a compact, short-range shadow map rather than having all shadows disabled.
    this.shadows = true;
    if (this.shadows) {
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      this.sun.castShadow = true;
      const shadowSize = perf.isMobile ? 768 : (perf.tier.name === 'high' ? 2048 : 1024);
      this.sun.shadow.mapSize.set(shadowSize, shadowSize);
      const sc = this.sun.shadow.camera, extent = perf.isMobile ? 92 : 140;
      sc.left = -extent; sc.right = extent; sc.top = extent; sc.bottom = -extent; sc.near = 10; sc.far = perf.isMobile ? 360 : 700; sc.updateProjectionMatrix();
      this.sun.shadow.bias = -0.0006; this.sun.shadow.normalBias = 0.035;
      this.sun.shadow.radius = perf.isMobile ? 2 : 3;
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
    progress('BUILDING MANHATTAN ARCHITECTURE', 10);
    // The photogrammetry FBX is deliberately not used for the playable city.
    // Build a clean, deterministic Manhattan-style grid from instanced geometry.
    const [treeLarge, treeSmall, decalCross, decalYellow] = await Promise.all([
      a.has('suburban-tree-large.glb') ? a.loadGLTF('suburban-tree-large.glb').catch(() => null) : Promise.resolve(null),
      a.has('suburban-tree-small.glb') ? a.loadGLTF('suburban-tree-small.glb').catch(() => null) : Promise.resolve(null),
      a.loadGLTF(base + 'Decal_Crosswalk.gltf'), a.loadGLTF(base + 'Decal_DoubleYellow_Straight.gltf'),
    ]);
    progress('PROCESSING MANHATTAN DISTRICTS', 55);
    this.parks = [];
    const parkRng = rng(85);
    for (let bi=0; bi<GRID; bi++) for (let bj=0; bj<GRID; bj++) {
      const cx=(bi-GRID/2+0.5)*PITCH, cz=(bj-GRID/2+0.5)*PITCH;
      if (parkRng()<0.055 && Math.hypot(cx,cz)>180) this.parks.push({cx,cz});
    }
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
    this._buildGround(detailedAsphalt || asphalt, detailedConcrete || concrete, asphaltNormal, asphaltRough, concreteNormal, concreteRough);
    this._buildManhattanArchitecture();
    this._buildDecals(decalCross.scene, decalYellow.scene);
    this._buildStreetLights();
    if (treeLarge && treeSmall) this._buildNature(treeLarge.scene, treeSmall.scene);
    this.manhattanMode = true;
    this.templates = []; this.placements = []; this.nearMeshes = []; this.farMesh = null; this.ringCount = 0;
    this.update(new THREE.Vector3(0, 0, 0), true);
    progress('MANHATTAN GRID READY', 100);
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

  _buildManhattanArchitecture() {
    const makeFacade = (style) => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=512;
      const ctx=canvas.getContext('2d');
      const palettes=[
        ['#172b3b','#35576c','#b7d5e5','#081724'],
        ['#766e61','#b4a994','#e2d8c4','#393a3a'],
        ['#563d37','#936454','#d4ad96','#2b2222'],
        ['#182531','#405568','#b2c5d1','#070f18']
      ];
      const p=palettes[style%palettes.length],grad=ctx.createLinearGradient(0,0,512,0);
      grad.addColorStop(0,p[0]);grad.addColorStop(.48,p[1]);grad.addColorStop(1,p[0]);ctx.fillStyle=grad;ctx.fillRect(0,0,512,512);
      const cols=12,rows=20,cw=512/cols,ch=512/rows;
      for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
        const x=col*cw+5,y=row*ch+4,w=cw-10,h=ch-8,lit=((row*17+col*29+style*13)%17===0)||((row*7+col*11+style)%31===0);
        ctx.fillStyle='#09131d';ctx.fillRect(x-3,y-3,w+6,h+6);
        ctx.fillStyle=lit?'#f6d99a':p[2];ctx.globalAlpha=lit?.98:.76;ctx.fillRect(x,y,w,h);ctx.globalAlpha=1;
        ctx.fillStyle='rgba(255,255,255,.32)';ctx.fillRect(x,y,w,2);
        ctx.fillStyle='rgba(4,10,17,.48)';ctx.fillRect(x,y+h-3,w,3);
        if(col%3===0){ctx.fillStyle='rgba(255,255,255,.10)';ctx.fillRect(x+w-2,y,2,h);}
      }
      ctx.fillStyle='rgba(8,15,22,.82)';for(let row=0;row<=rows;row++)ctx.fillRect(0,row*ch,512,4);
      // Subtle stone spandrels and vertical facade mullions add scale and depth cues.
      ctx.fillStyle='rgba(8,15,22,.38)';for(let col=0;col<=cols;col++)ctx.fillRect(col*cw,0,4,512);
      const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.anisotropy=Math.min(8,this.perf.isMobile?4:8);tex.needsUpdate=true;return tex;
    };
    const roofMat=new THREE.MeshStandardMaterial({color:0x303a45,roughness:.76,metalness:.22});
    const stoneMat=new THREE.MeshStandardMaterial({color:0x777e82,roughness:.84,metalness:.08});
    const facadeMats=[];
    const facadeTextures=[];
    for(let s=0;s<4;s++){
      const tex=makeFacade(s); facadeTextures.push(tex);
      const side=new THREE.MeshStandardMaterial({map:tex,roughness:s===0||s===3?.26:.58,metalness:s===0||s===3?.48:.16,envMapIntensity:s===0||s===3?1.05:.55});
      facadeMats.push([side,side,roofMat,roofMat,side,side]);
    }
    const boxGeo=new THREE.BoxGeometry(1,1,1);
    const mainMeshes=facadeMats.map(mats=>{const im=new THREE.InstancedMesh(boxGeo,mats,GRID*GRID*4);im.count=0;im.castShadow=true;im.receiveShadow=true;im.frustumCulled=false;this.group.add(im);return im;});
    const upperMeshes=facadeMats.map(mats=>{const im=new THREE.InstancedMesh(boxGeo,mats,GRID*GRID*4);im.count=0;im.castShadow=true;im.receiveShadow=true;im.frustumCulled=false;this.group.add(im);return im;});
    const podium=new THREE.InstancedMesh(boxGeo,stoneMat,GRID*GRID*4); podium.count=0; podium.frustumCulled=false; this.group.add(podium);
    const rooftop=new THREE.InstancedMesh(boxGeo,roofMat,GRID*GRID*4); rooftop.count=0; rooftop.frustumCulled=false; this.group.add(rooftop);
    const counts=[0,0,0,0], upperCounts=[0,0,0,0]; let podiumCount=0, roofCount=0;
    const rand=rng(20261109);
    const landmarkBlocks=new Set(['5,5','6,5','5,6']);
    const addTower=(x,z,w,d,h,style,landmark=false)=>{
      const idx=style%4, k=counts[idx]++;
      const baseH=h>105?h*.78:h;
      M.compose(V.set(x,baseH/2,z),Q.identity(),S.set(w,baseH,d));
      mainMeshes[idx].setMatrixAt(k,M);
      mainMeshes[idx].setColorAt(k,new THREE.Color().setHSL(.57+idx*.025,.10,.82+rand()*.14));
      if(h>105){
        const uk=upperCounts[idx]++, uh=h-baseH, uw=w*(landmark?.72:.78), ud=d*(landmark?.72:.78);
        M.compose(V.set(x,baseH+uh/2,z),Q.identity(),S.set(uw,uh,ud));
        upperMeshes[idx].setMatrixAt(uk,M);
        upperMeshes[idx].setColorAt(uk,new THREE.Color().setHSL(.57+idx*.025,.10,.82+rand()*.14));
      }
      M.compose(V.set(x,4,z),Q.identity(),S.set(w*1.035,8,d*1.035));
      podium.setMatrixAt(podiumCount,M); podium.setColorAt(podiumCount++,new THREE.Color().setHSL(.10,.08,.56+rand()*.12));
      if(rand()>.32){
        M.compose(V.set(x+(rand()-.5)*w*.28,h+2,z+(rand()-.5)*d*.28),Q.identity(),S.set(w*.22,4,d*.2));
        rooftop.setMatrixAt(roofCount++,M);
      }
      this.colliders.push({minX:x-w/2,maxX:x+w/2,minZ:z-d/2,maxZ:z+d/2,h});
    };
    this.colliders=[];
    for(let bi=0;bi<GRID;bi++) for(let bj=0;bj<GRID;bj++){
      const cx=(bi-GRID/2+.5)*PITCH, cz=(bj-GRID/2+.5)*PITCH;
      if(landmarkBlocks.has(bi+','+bj)) continue;
      const district=Math.max(0,1-Math.hypot(cx,cz)/(WORLD_LIMIT*.95));
      for(const qx of [-1,1]) for(const qz of [-1,1]){
        const w=34+rand()*3.5,d=34+rand()*3.5;
        const h=38+district*118+rand()*(district*48+34);
        const x=cx+qx*23.2,z=cz+qz*23.2,style=rand()<.48?0:rand()<.57?1:rand()<.72?2:3;
        addTower(x,z,w,d,h,style);
      }
    }
    for(let s=0;s<4;s++){
      mainMeshes[s].count=counts[s]; mainMeshes[s].instanceMatrix.needsUpdate=true; if(mainMeshes[s].instanceColor)mainMeshes[s].instanceColor.needsUpdate=true;
      upperMeshes[s].count=upperCounts[s]; upperMeshes[s].instanceMatrix.needsUpdate=true; if(upperMeshes[s].instanceColor)upperMeshes[s].instanceColor.needsUpdate=true;
    }
    podium.count=podiumCount; podium.instanceMatrix.needsUpdate=true; if(podium.instanceColor)podium.instanceColor.needsUpdate=true;
    rooftop.count=roofCount; rooftop.instanceMatrix.needsUpdate=true;
    // Three skyline anchors with stepped setbacks and spires; positioned on separate blocks.
    const addLandmark=(x,z,style,kind)=>{
      const side=facadeMats[style][0], roof=roofMat;
      const addBox=(w,h,d,y,mat=side)=>{
        const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;this.group.add(m);
      };
      if(kind==='empire'){
        addBox(54,18,54,9,stoneMat);addBox(43,78,43,57);addBox(34,35,34,113);addBox(22,24,22,142);addBox(7,22,7,165,roof);
        const spire=new THREE.Mesh(new THREE.CylinderGeometry(1.1,.5,28,8),roof);spire.position.set(x,190,z);this.group.add(spire);
        this.colliders.push({minX:x-27,maxX:x+27,minZ:z-27,maxZ:z+27,h:178});
      }else if(kind==='chrysler'){
        addBox(48,108,48,54);addBox(38,18,38,117);addBox(28,16,28,134);addBox(18,15,18,149);
        const crown=new THREE.Mesh(new THREE.ConeGeometry(12,25,8),roof);crown.position.set(x,169,z);this.group.add(crown);
        this.colliders.push({minX:x-24,maxX:x+24,minZ:z-24,maxZ:z+24,h:181});
      }else{
        addBox(50,125,50,62.5);const taper=new THREE.Mesh(new THREE.CylinderGeometry(8,24,62,4,1,false),side);taper.position.set(x,156,z);taper.rotation.y=Math.PI/4;this.group.add(taper);
        const spire=new THREE.Mesh(new THREE.CylinderGeometry(.8,.8,32,8),roof);spire.position.set(x,203,z);this.group.add(spire);
        this.colliders.push({minX:x-25,maxX:x+25,minZ:z-25,maxZ:z+25,h:187});
      }
    };
    addLandmark(-55,-55,1,'empire');
    addLandmark(55,-55,0,'chrysler');
    addLandmark(-55,55,3,'wtc');
    this.manhattanMode=true;
    this.placements=[]; this.nearMeshes=[]; this.farMesh=null; this.ringCount=0;
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

  // The Manhattan rebuild is fully instanced and does not need per-frame placement updates.
  // Retain the legacy LOD path only for older generated-city variants.
  update(pos, force = false) {
    if (this.manhattanMode) return;
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



// ===== environment/NYCWorld.js =====
// Optional authored NYC world. Procedural city remains the safe fallback if the archive is absent.
class NYCWorld {
  constructor(scene, assets, perf, fallbackCity) {
    this.scene=scene; this.assets=assets; this.perf=perf; this.fallbackCity=fallbackCity;
    this.group=new THREE.Group(); this.group.visible=false; scene.add(this.group);
    this.ready=false; this.bounds=new THREE.Box3(); this.groundY=0; this.meshCount=0;
  }
  async load(progress=()=>{}) {
    const a=this.assets;
    if(!a.has('newyork.fbx')) return false;
    progress('LOADING NEW YORK WORLD',5);

    // Keep the imported FBX transforms intact. Rotate a wrapper instead of
    // overwriting the FBX root rotation, then infer the likely up-axis from
    // the source bounds (city footprints are normally wider than city height).
    const source=await a.loadFBX('NewYork.fbx');
    source.updateMatrixWorld(true);
    const sourceBounds=new THREE.Box3().setFromObject(source);
    const raw=sourceBounds.getSize(new THREE.Vector3());
    const dims={x:raw.x,y:raw.y,z:raw.z};
    const axes=['x','y','z'].sort((a,b)=>dims[a]-dims[b]);
    const smallest=axes[0], largest=Math.max(raw.x,raw.y,raw.z);
    let upAxis='y';
    // Only override the conventional Y-up orientation when the bounds give
    // a useful signal. Near-cubic assets remain Y-up rather than being guessed.
    if(largest>0 && dims[smallest]/largest<0.82) upAxis=smallest;

    const root=new THREE.Group();
    root.add(source);
    if(upAxis==='z') root.rotation.x=-Math.PI/2;       // Z-up -> Y-up
    else if(upAxis==='x') root.rotation.z=Math.PI/2;   // X-up -> Y-up
    root.updateMatrixWorld(true);
    this.bounds.setFromObject(root);
    let size=this.bounds.getSize(new THREE.Vector3());
    const span=Math.max(size.x,size.z);
    if(!Number.isFinite(span)||span<1) throw new Error('NYC model has invalid dimensions');

    // Do not use the absolute lowest vertex as street level. This FBX contains
    // one large below-grade mesh whose minimum sits ~110 source units below
    // the dominant building-base plane. Align the dense mesh-floor cluster
    // instead, otherwise the playable city floats above the player spawn.
    const meshFloorYs=[];
    root.traverse(o=>{
      if(!o.isMesh || !o.visible || !o.geometry?.attributes?.position?.count)return;
      const box=new THREE.Box3().setFromObject(o);
      if(!box.isEmpty() && Number.isFinite(box.min.y)) meshFloorYs.push(box.min.y);
    });
    let groundDatum=this.bounds.min.y;
    if(meshFloorYs.length>=8){
      meshFloorYs.sort((a,b)=>a-b);
      const windowSize=Math.max(8,size.y*.12);
      let bestStart=0,bestEnd=0,end=0;
      for(let start=0;start<meshFloorYs.length;start++){
        end=Math.max(end,start);
        while(end<meshFloorYs.length && meshFloorYs[end]-meshFloorYs[start]<=windowSize)end++;
        if(end-start>bestEnd-bestStart){bestStart=start;bestEnd=end;}
      }
      const cluster=meshFloorYs.slice(bestStart,bestEnd);
      if(cluster.length>=Math.max(8,Math.ceil(meshFloorYs.length*.2))){
        groundDatum=cluster[Math.floor(cluster.length/2)];
      }
    }

    const targetSpan=this.perf.isMobile?1180:1680, scale=targetSpan/span;
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    this.bounds.setFromObject(root);
    const center=this.bounds.getCenter(new THREE.Vector3());
    // Center the footprint horizontally, but align the dominant street datum
    // to Y=0. Below-grade outliers are allowed to remain below the street.
    root.position.set(-center.x,-groundDatum*scale,-center.z);
    root.updateMatrixWorld(true);
    this.bounds.setFromObject(root);
    size=this.bounds.getSize(new THREE.Vector3());
    this.groundDatum=groundDatum;
    if(![size.x,size.y,size.z,this.bounds.min.y].every(Number.isFinite) ||
       size.x<10 || size.z<10 || size.y<1) {
      throw new Error('NYC world bounds failed validation: '+size.x.toFixed(1)+' × '+size.y.toFixed(1)+' × '+size.z.toFixed(1));
    }
    this.groundY=0;

    let meshCount=0, visibleMeshes=0;
    root.traverse(o=>{
      if(!o.isMesh)return;
      meshCount++;
      if(o.geometry){
        if(!o.geometry.boundingSphere)o.geometry.computeBoundingSphere();
        if(o.visible && o.geometry.attributes?.position?.count>0) visibleMeshes++;
      }
      o.castShadow=false; o.receiveShadow=true; o.frustumCulled=true;
      const mats=Array.isArray(o.material)?o.material:[o.material];
      for(const m of mats) if(m){
        m.side=THREE.DoubleSide;
        m.envMapIntensity=.62;
        if(m.isMeshStandardMaterial){
          m.roughness=Math.max(.3,m.roughness||.65);
          m.metalness=Math.min(.55,m.metalness||0);
          m.needsUpdate=true;
        }
      }
    });
    if(!meshCount || !visibleMeshes) throw new Error('NYC FBX has no visible renderable meshes');
    this.meshCount=meshCount;
    this.meshes=[]; this.meshBounds=[]; this.meshRayBounds=[]; this.surfaceCache={x:NaN,z:NaN,y:0};
    root.traverse(o=>{
      if(!o.isMesh || !o.visible || !o.geometry?.attributes?.position?.count)return;
      this.meshes.push(o);
      const box=new THREE.Box3().setFromObject(o);
      this.meshRayBounds.push({mesh:o,box});
      const s=box.getSize(new THREE.Vector3());
      // Retain plausible building/structure bounds for inexpensive broad-phase collision.
      if(s.x<260 && s.z<260 && s.y>1.2) this.meshBounds.push(box);
    });
    this.raycaster=new THREE.Raycaster();
    this.rayDown=new THREE.Vector3(0,-1,0);
    this.orientation=upAxis.toUpperCase()+'-UP (auto)';
    this.worldSize=size.clone();
    this.group.add(root);
    this.ready=true;
    // Do not hide the procedural city until deployment actually activates NYC.
    this.group.visible=false;
    this.fallbackCity.group.visible=true;
    progress('NYC WORLD READY · '+meshCount+' MESHES · '+this.orientation,100);
    return true;
  }
  // Query the authored NYC FBX instead of the hidden procedural city's grid.
  surfaceAt(x,z,currentY=0){
    if(!this.ready || !this.meshes?.length) return this.groundY;
    // Always cast from above the complete authored world. Starting at playerY+8
    // misses streets when the player has spawned beneath a misaligned FBX.
    const cache=this.surfaceCache;
    if(Math.hypot(x-cache.x,z-cache.z)<0.45) return cache.y;
    const startY=Math.max(this.bounds.max.y+20,currentY+80,100);
    this.raycaster.set(new THREE.Vector3(x,startY,z),this.rayDown);
    this.raycaster.near=0; this.raycaster.far=Math.max(20,startY-this.bounds.min.y+5);
    const candidates=this.meshRayBounds.filter(v=>x>=v.box.min.x-0.1&&x<=v.box.max.x+0.1&&z>=v.box.min.z-0.1&&z<=v.box.max.z+0.1&&v.box.min.y<=startY&&v.box.max.y>=this.bounds.min.y);
    const hits=this.raycaster.intersectObjects(candidates.map(v=>v.mesh),false);
    cache.x=x; cache.z=z; cache.y=hits.length?hits[0].point.y:this.groundY;
    return cache.y;
  }
  resolveCircle(pos,r,y){
    if(!this.ready || !this.meshRayBounds?.length) return false;
    // Do not collide against whole-mesh AABBs: a single FBX mesh can cover an
    // entire block or street and its rectangular bounds trap the player.
    // Cast short horizontal rays against actual triangles at torso height.
    let collided=false;
    const dirs=[[1,0],[-1,0],[0,1],[0,-1],
      [0.7071,0.7071],[0.7071,-0.7071],[-0.7071,0.7071],[-0.7071,-0.7071]];
    const margin=0.12, rayY=y+0.95;
    for(let pass=0;pass<2;pass++){
      for(const [dx,dz] of dirs){
        const origin=new THREE.Vector3(pos.x+dx*(r+margin),rayY,pos.z+dz*(r+margin));
        const direction=new THREE.Vector3(-dx,0,-dz);
        this.raycaster.set(origin,direction);
        this.raycaster.near=0.01; this.raycaster.far=r+margin*2;
        const ray=this.raycaster.ray;
        const candidates=this.meshRayBounds.filter(v=>v.box.intersectsRay(ray)).map(v=>v.mesh);
        if(!candidates.length) continue;
        const hits=this.raycaster.intersectObjects(candidates,false);
        const wall=hits.find(h=>{
          if(!h.face) return true;
          const n=h.face.normal.clone().transformDirection(h.object.matrixWorld);
          return Math.abs(n.y)<0.68;
        });
        if(!wall) continue;
        const penetration=Math.min(r,Math.max(0,wall.distance-margin));
        if(penetration>0.015){
          pos.x-=dx*penetration;
          pos.z-=dz*penetration;
          collided=true;
        }
      }
    }
    return collided;
  }
  raycast(origin,dir,maxDist){
    if(!this.ready || !this.meshes?.length) return maxDist;
    this.raycaster.set(origin,dir); this.raycaster.near=0.05; this.raycaster.far=maxDist;
    const ray=this.raycaster.ray;
    const candidates=this.meshRayBounds.filter(v=>v.box.intersectsRay(ray)).map(v=>v.mesh);
    const hits=this.raycaster.intersectObjects(candidates,false);
    return hits.length?hits[0].distance:maxDist;
  }
  activate(){
    if(!this.ready || !this.meshCount) return false;
    this.group.visible=true;
    this.fallbackCity.group.visible=false;
    return true;
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
    this.attackState = null; this.attackTime = 0; this.attackDuration = 0.42; this.attackBase = {};
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
      if (o.isBone) { const n = key(o.name); for (const [id, re] of [['lHand', /lefthand$/], ['rHand', /righthand$/], ['lFoot', /leftfoot$/], ['rFoot', /rightfoot$/], ['chest', /spine2$/], ['head', /head$/], ['lArm', /leftarm$/], ['rArm', /rightarm$/], ['lLeg', /leftupleg$/], ['rLeg', /rightupleg$/]]) if (re.test(n)) this.bones[id] = o; }
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
    const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');
    const g=x.createRadialGradient(32,32,0,32,32,32);g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(.3,'rgba(120,230,255,.8)');g.addColorStop(1,'rgba(60,180,255,0)');
    x.fillStyle=g;x.fillRect(0,0,64,64);const tex=new THREE.CanvasTexture(c);
    // Layered blue plasma envelope, cyan core and white-hot centre.
    const outerGeo=new THREE.CylinderGeometry(.025,.22,1.9,10,1,true);
    const innerGeo=new THREE.CylinderGeometry(.012,.105,1.35,9,1,true);
    const coreGeo=new THREE.CylinderGeometry(.006,.045,.92,8,1,true);
    const outerMat=new THREE.MeshBasicMaterial({color:0x168dff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide});
    const innerMat=new THREE.MeshBasicMaterial({color:0x62dcff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide});
    const coreMat=new THREE.MeshBasicMaterial({color:0xe8fdff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide});
    this.thrusters=[];
    for(const id of ['lHand','rHand','lFoot','rFoot']){
      const nozzle=new THREE.Group();this.root.add(nozzle);
      const outer=new THREE.Mesh(outerGeo,outerMat.clone());outer.position.y=-.6;nozzle.add(outer);
      const inner=new THREE.Mesh(innerGeo,innerMat.clone());inner.position.y=-.72;nozzle.add(inner);
      const core=new THREE.Mesh(coreGeo,coreMat.clone());core.position.y=-1.18;nozzle.add(core);
      const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,color:0x8cecff,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));
      glow.scale.set(.9,1.7,1);glow.position.y=-2;nozzle.add(glow);
      const flare=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,color:0x2d9fff,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));
      flare.scale.set(1.45,2.7,1);flare.position.y=-2.1;nozzle.add(flare);
      nozzle.visible=false;this.thrusters.push({id,nozzle,outer,inner,core,glow,flare});
    }
    this._jetDir=new THREE.Vector3();this._jetUp=new THREE.Vector3(0,1,0);this._jetWorld=new THREE.Vector3();this._jetLocal=new THREE.Vector3();this._jetPos=new THREE.Vector3();
    this.chestLight=new THREE.PointLight(0x66e6ff,.8,7);this.root.add(this.chestLight);
    this.bloom=new THREE.Sprite(new THREE.SpriteMaterial({map:this._bloomTex(),color:0x66e6ff,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:0}));
    this.bloom.position.set(0,1.2,.2);this.bloom.scale.set(.1,.1,1);this.bloom.renderOrder=9;this.tilt.add(this.bloom);
    this.aura=new THREE.Sprite(new THREE.SpriteMaterial({map:this.bloom.material.map,color:0x9fe8ff,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:false,transparent:true,opacity:0}));
    this.aura.position.set(0,1.1,0);this.aura.scale.set(3.6,3.6,1);this.aura.renderOrder=7;this.root.add(this.aura);
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
        } catch (e) { /* try legacy filename where available */ }
      }
    }));
    // Floating.fbx uses a different skeleton. Reuse the compatible flight clip for hover;
    // if unavailable, keep the idle pose while thrusters and hover stabilization do the work.
    this.actions.hover = this.actions.fly || this.actions.idle || null;
    const loaded = Object.keys(this.actions).filter(k => this.actions[k]).length;
    this.assets.onStatus(loaded, 0);
    if (!this.actions.idle) this.assets.onError('ANIM: idle clip unavailable; suit will use bind pose');
    this.play('idle');
  }
  attack(type='punch') { this.attackState=type; this.attackTime=0; this.firePulse=.22; for(const id of ['lArm','rArm','lLeg','rLeg']){const b=this.bones[id];if(b)this.attackBase[id]={x:b.rotation.x,y:b.rotation.y,z:b.rotation.z};} }
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
  update(dt, flightAmount, speed = 0, boost = false, mode = 'WALK', verticalSpeed = 0, hovering = false, velocity = null) {
    this.flying += (flightAmount - this.flying) * Math.min(1, dt * 6);
    this.firePulse = Math.max(0, (this.firePulse || 0) - dt);
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
    if(this.attackState){this.attackTime+=dt;const t=Math.min(1,this.attackTime/this.attackDuration),wave=Math.sin(t*Math.PI);const arm=this.bones[this.attackState==='punch'?'rArm':'lArm'];const leg=this.bones[this.attackState==='kick'?'rLeg':'lLeg'];if(arm&&this.attackBase[this.attackState==='punch'?'rArm':'lArm']){const base=this.attackBase[this.attackState==='punch'?'rArm':'lArm'];arm.rotation.z=base.z+(this.attackState==='punch'?-0.95:0.35)*wave;}if(this.attackState==='kick'&&leg&&this.attackBase.rLeg){leg.rotation.x=this.attackBase.rLeg.x+0.9*wave;}if(t>=1){for(const [id,v] of Object.entries(this.attackBase)){const b=this.bones[id];if(b)b.rotation.set(v.x,v.y,v.z);}this.attackBase={};this.attackState=null;}}
    this._lastVelX=0;this._lastVelY=0;this._lastVelZ=0;if(velocity){const inv=this.root.quaternion.clone().invert();this._jetLocal.copy(velocity).applyQuaternion(inv);this._lastVelX=this._jetLocal.x;this._lastVelY=this._jetLocal.y;this._lastVelZ=this._jetLocal.z;}
    const p=new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    const flightMode=mode==='TAKEOFF'||mode==='FLIGHT'||mode==='LANDING';
    const thrustBase=mode==='TAKEOFF'?1.12:mode==='LANDING'?.34:hovering?.38:1;
    const thrust=THREE.MathUtils.clamp(this.flying*thrustBase*(boost?1.5:1),0,1.6);
    for(const jet of (this.thrusters||[])){
      const bone=this.bones[jet.id];
      if(bone){bone.getWorldPosition(p);this.root.worldToLocal(p);jet.nozzle.position.copy(p);}
      else {
        const fallback={lHand:[-.42,1.05,-.03],rHand:[.42,1.05,-.03],lFoot:[-.2,.12,0],rFoot:[.2,.12,0]}[jet.id];
        jet.nozzle.position.set(...fallback);
      }
      const isHand=jet.id.includes('Hand');
      this._jetWorld.copy(this._jetUp);
      if(isHand){
        this._jetWorld.set(0,-.35,.94);
      } else {
        this._jetWorld.set(0,-.82,.57);
      }
      if(speed>2){
        const localVelocity=this._jetLocal.set(0,0,0);
        // Velocity is converted to suit-local space by the root's inverse world rotation.
        localVelocity.set(this._lastVelX||0,this._lastVelY||0,this._lastVelZ||0);
        if(localVelocity.lengthSq()>1e-4){localVelocity.normalize();this._jetWorld.lerp(localVelocity.negate(),.62).normalize();}
      }
      jet.nozzle.quaternion.setFromUnitVectors(this._jetUp,this._jetWorld.clone().negate());
      const amount=flightMode?thrust:0;
      jet.nozzle.visible=amount>.035;
      const pulse=1+Math.sin(performance.now()*.035+(isHand?1.4:0))*.055;
      const length=(isHand?.72:1.35)*(.72+amount*.92)*(boost?1.55:1)*pulse;
      jet.outer.scale.set(1,length,1);jet.outer.position.y=-.95*length;
      jet.inner.scale.set(1,length*.9,1);jet.inner.position.y=-.675*length;
      jet.core.scale.set(1,length*.82,1);jet.core.position.y=-.46*length;
      jet.outer.material.opacity=Math.min(.9,amount*.62);
      jet.inner.material.opacity=Math.min(1,amount*.86);
      jet.core.material.opacity=Math.min(1,amount*.95);
      jet.glow.material.opacity=Math.min(1,amount*.9);
      jet.flare.material.opacity=Math.min(.8,amount*(boost?.72:.42));
      jet.glow.position.y=-1.75*length;jet.flare.position.y=-1.9*length;
      jet.glow.scale.set((isHand?.72:1)*length*.72,length*1.25,1);
      jet.flare.scale.set((isHand?1:1.55)*length,length*1.9,1);
    }
    if (this.bloom) { const target = boost ? 0.9 : 0, s = 3.5 + (boost ? 3 : 0) + Math.sin(performance.now() * 0.02) * 0.4 * (boost ? 1 : 0);
      this.bloom.material.opacity += (target - this.bloom.material.opacity) * Math.min(1, dt * 8); this.bloom.scale.set(s, s, 1); }
    if (this.aura) { const a = this.flying * (boost ? 0.4 : 0.22); this.aura.material.opacity += (a - this.aura.material.opacity) * Math.min(1, dt * 6); }
    if (this.chestLight) { this.chestLight.position.set(0, 1.4, -0.25); this.chestLight.intensity = 0.7 + this.flying * 1.5 + (boost ? 3.2 : 0); }
  }

  worldPosOf(id, out) { const b = this.bones[id]; if (b) { b.getWorldPosition(out); return out; } return out.copy(this.root.position).add(new THREE.Vector3(0, 1.3, 0)); }
}


// ===== character/MovementController.js =====

const WALK = 3.2, RUN = 6.2, FLY = 19, FLY_BOOST = 52, RADIUS = 0.7;
const MODE = { WALK: 'WALK', TAKEOFF: 'TAKEOFF', FLY: 'FLIGHT', LANDING: 'LANDING' };

// Camera-relative walking and (M1) free flight with takeoff/landing phases. Animations come in Milestone 2.
class MovementController {
  constructor() {
    this.pos = new THREE.Vector3(0, 0, 0); this.vel = new THREE.Vector3();
    this.heading = 0; this.mode = MODE.WALK; this.targetAlt = 0; this.speed = 0; this.bank = 0; this.pitch = 0; this.hitLimit = false;
  }
  takeoff() { if (this.mode === MODE.WALK) { this.mode = MODE.TAKEOFF; this.takeoffStart = this.pos.y; this.targetAlt = this.pos.y + 10; this.takeoffT = 0; this.vel.set(0,0,0); return true; } return false; }
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
    if (this.mode === MODE.TAKEOFF) top = 0; if (this.mode === MODE.LANDING) top = 3;
    const want = dir.multiplyScalar(top * mag);
    const k = Math.min(1, dt * (airborne ? (inp.boost ? 2.8 : 2.0) : 6));
    this.vel.x += (want.x - this.vel.x) * k; this.vel.z += (want.z - this.vel.z) * k;
    const prevHeading = this.heading;
    if (mag > 0.08) { const a = Math.atan2(-dir.x, -dir.z); let d = a - this.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); this.heading += d * Math.min(1, dt * (airborne ? 7 : 10)); }
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // Altitude state machine.
    if (this.mode === MODE.FLY) this.targetAlt = THREE.MathUtils.clamp(this.targetAlt + (inp.up - inp.down) * (inp.boost ? 40 : 16) * dt, 2, 420);
    const ground = city.surfaceAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.mode === MODE.LANDING) this.targetAlt = ground; // M2: descend onto whatever is below, roof or street
    const climb = this.mode === MODE.TAKEOFF ? 1.25 : this.mode === MODE.LANDING ? 1.35 : 2.0;
    this.pos.y = THREE.MathUtils.damp(this.pos.y, Math.max(this.targetAlt, ground), climb, dt);
    if (this.mode === MODE.TAKEOFF && (this.takeoffT += dt) > 1.35 && this.pos.y > this.targetAlt - 0.8) { this.mode = MODE.FLY; this.targetAlt = this.pos.y; }
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
    el.style.touchAction='none';
    const blocked=t=>!!(t&&t.closest&&t.closest('#joy,.controls,button,input,select,#minimapWrap,#gameTopActions,.pauseShade'));
    const begin=(id,x,y,target)=>{if(blocked(target))return;this.pointers.set(id,{x,y});if(this.pointers.size===2)this.pinch=this._span();};
    const move=(id,x,y,e)=>{const p=this.pointers.get(id);if(!p)return;if(e)e.preventDefault();const dx=x-p.x,dy=y-p.y;p.x=x;p.y=y;if(this.pointers.size>=2){const z=this._span();if(this.pinch>0)this.userDist=clamp(this.userDist*this.pinch/Math.max(z,1),.6,2.2);this.pinch=z;}else{this.yaw-=dx*.006;this.pitch=clamp(this.pitch+dy*.004,-.5,.9);}};
    const end=id=>{this.pointers.delete(id);if(this.pointers.size<2)this.pinch=0;};
    el.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||(e.pointerType==='mouse'&&e.button!==0))return;e.preventDefault();begin('p'+e.pointerId,e.clientX,e.clientY,e.target);try{el.setPointerCapture(e.pointerId);}catch(_){}},{passive:false});
    window.addEventListener('pointermove',e=>{if(e.pointerType!=='touch')move('p'+e.pointerId,e.clientX,e.clientY,e);},{passive:false});
    window.addEventListener('pointerup',e=>end('p'+e.pointerId),{passive:true});window.addEventListener('pointercancel',e=>end('p'+e.pointerId),{passive:true});
    el.addEventListener('touchstart',e=>{for(const t of e.changedTouches)begin('t'+t.identifier,t.clientX,t.clientY,e.target);if(this.pointers.size)e.preventDefault();},{passive:false});
    el.addEventListener('touchmove',e=>{for(const t of e.changedTouches)move('t'+t.identifier,t.clientX,t.clientY,e);},{passive:false});
    const te=e=>{for(const t of e.changedTouches)end('t'+t.identifier);};el.addEventListener('touchend',te,{passive:true});el.addEventListener('touchcancel',te,{passive:true});
    el.addEventListener('lostpointercapture',e=>end('p'+e.pointerId));
    el.addEventListener('wheel',e=>{this.userDist=clamp(this.userDist*(1+e.deltaY*.001),.6,2.2);},{passive:true});
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
  constructor(scene){this.scene=scene;this.energy=100;this.last=0;this.shots=[];this.geo=new THREE.SphereGeometry(.16,12,10);this.mat=new THREE.MeshBasicMaterial({color:0xd9fbff,fog:false});this.axis=new THREE.Vector3(0,0,1);this.pool=[];this.spriteTexture=null;this.fx=null;this.world=null;}
  setTexture(t){this.spriteTexture=t;}
  fire(origins,dir){const now=performance.now();if(this.energy<6||now-this.last<220)return false;this.last=now;this.energy-=6;for(const o of origins){const m=this.pool.pop()||new THREE.Mesh(this.geo,this.mat);m.position.copy(o);m.scale.set(.85,.85,4.2);m.quaternion.setFromUnitVectors(this.axis,dir);this.scene.add(m);let flash=null;if(this.spriteTexture){flash=new THREE.Sprite(new THREE.SpriteMaterial({map:this.spriteTexture,color:0xc9f8ff,transparent:true,opacity:.95,blending:THREE.AdditiveBlending,depthWrite:false}));flash.position.copy(o);flash.scale.set(1.2,1.2,1);this.scene.add(flash);}this.shots.push({m,flash,v:dir.clone().multiplyScalar(150),life:1.8});}return true;}
  update(dt,regenBlocked,mission=null,hud=null){if(!regenBlocked)this.energy=Math.min(100,this.energy+dt*6);for(let i=this.shots.length-1;i>=0;i--){const q=this.shots[i],prev=q.m.position.clone();q.m.position.addScaledVector(q.v,dt);if(q.flash){q.flash.position.copy(q.m.position);q.flash.material.opacity=Math.max(0,Math.min(1,q.life*2));}let struck=false;if(mission&&(mission.hitSegment?mission.hitSegment(prev,q.m.position,hud):mission.hit(q.m.position,hud))){q.life=0;struck=true;}
if(!struck&&this.world&&this.fx){q.chk=(q.chk||0)+1;if(q.chk%3===0){const a0=q.last||prev,seg=q.m.position.clone().sub(a0),len=seg.length();if(len>1e-3){const d0=seg.divideScalar(len),h0=this.world.raycast(a0,d0,len);if(h0<len-1e-3){this.fx.spark(a0.clone().addScaledVector(d0,h0),d0.clone().negate());q.life=0;}}q.last=q.m.position.clone();}}if((q.life-=dt)<=0){this.scene.remove(q.m);this.pool.push(q.m);if(q.flash){this.scene.remove(q.flash);q.flash.material.dispose();}this.shots.splice(i,1);}}}
}

// ===== ui/HUD.js =====
const $ = id => document.getElementById(id);

// All DOM/touch handling. Joystick and buttons use pointer capture so they never leak into the camera swipe.
class HUD {
  constructor() {
    this.steer = { x: 0, y: 0 };
    this.input = { run: false, boost: false, hover: false, up: 0, down: 0, fire: false };
    this.handlers = {};
    this._joystick(); this._buttons();
  }
  on(name, fn) { this.handlers[name] = fn; }
  setLoading(text, pct) { $('loadtext').textContent = text; if (pct != null) $('loadbar').style.width = pct + '%'; }
  logError(msg) { const d = document.createElement('div'); d.textContent = '⚠ ' + msg.slice(0, 120); $('errors').appendChild(d); }
  setAssetStatus(ok, bad) { $('assetstat').textContent = `ASSETS ${ok}${bad ? ' · ' + bad + ' FAILED' : ''}`; $('assetstat').style.color = bad ? '#ff9b91' : ''; }
  hideLoading() { $('loading').classList.add('hide'); const intro=$('starkIntro'); if(!intro)return; requestAnimationFrame(()=>intro.classList.add('ignite')); setTimeout(()=>intro.classList.add('reactorExpand'),1450); setTimeout(()=>intro.classList.add('leave'),2750); setTimeout(()=>intro.remove(),3700); }
  toast(t) { const e = $('toast'); e.textContent = t; e.style.opacity = 1; clearTimeout(this._t); this._t = setTimeout(() => e.style.opacity = 0, 1300); }
  setFlightUI(flying) {
    $('ui').classList.toggle('isFlying', !!flying);
    for (const id of ['fly', 'run', 'attack', 'kick']) $(id).hidden = flying;
    for (const id of ['land', 'hover', 'boost', 'up', 'down']) $(id).hidden = !flying;
    $('fire').hidden = false; $('view').hidden = false; $('lock').hidden = false;
  }
  readout(mode, alt, speedKmh, energy) {
    $('mode').textContent = mode; $('alt').textContent = alt < 0.5 ? 'GROUND' : Math.round(alt) + ' M';
    $('spd').textContent = Math.round(speedKmh) + ' KM/H'; $('nrg').textContent = Math.round(energy);
  }
  _joystick() {
    const joy = $('joy'), stick = $('stick'); let pid = null;
    const move = e => {
      const r = joy.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), max = r.width * 0.30, len = Math.hypot(dx, dy), k = Math.min(1, max / (len || 1)), rawX = dx * k / max, rawY = -dy * k / max, mag = Math.hypot(rawX, rawY);
      const dead = 0.19, shaped = mag <= dead ? 0 : Math.pow((mag - dead) / (1 - dead), 1.85) * 0.68;
      const scale = mag > 0 ? shaped / mag : 0; this.steer.x = rawX * scale; this.steer.y = rawY * scale; stick.style.transform = `translate(${dx * k}px,${dy * k}px)`;
    };
    joy.style.touchAction='none'; joy.addEventListener('pointerdown', e => { e.preventDefault(); pid = e.pointerId; try{joy.setPointerCapture(pid);}catch(_){} move(e); });
    joy.addEventListener('pointermove', e => { if (e.pointerId === pid) {e.preventDefault();move(e);} });
    const end = e => { if (e.pointerId !== pid) return; pid = null; this.steer.x = this.steer.y = 0; stick.style.transform = 'translate(0,0)'; };
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end); joy.addEventListener('lostpointercapture',end);
  }
  _hold(id, key, val = 1) {
    const b = $(id), set = v => { this.input[key] = v ? val : (typeof val === 'number' ? 0 : false); b.classList.toggle('on', !!v); };
    b.style.touchAction='none'; b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); try{b.setPointerCapture(e.pointerId);}catch(_){} set(true); });
    for (const ev of ['pointerup', 'pointercancel','lostpointercapture']) b.addEventListener(ev, () => set(false));
  }
  _buttons() {
    $('run').addEventListener('click', () => { this.input.run = !this.input.run; $('run').classList.toggle('on', this.input.run); this.toast(this.input.run ? 'RUN MODE' : 'WALK MODE'); });
    $('hover').addEventListener('click', () => { this.input.hover = !this.input.hover; $('hover').classList.toggle('on', this.input.hover); this.toast(this.input.hover ? 'HOVER ENGAGED' : 'HOVER OFF'); });
    $('fly').addEventListener('click', () => this.handlers.fly && this.handlers.fly());
    $('land').addEventListener('click', () => this.handlers.land && this.handlers.land());
    // Hold to fire on touch; retain click activation for keyboard/screen-reader users.
     $('fire').addEventListener('click',e=>{if(e.detail===0&&this.handlers.fire)this.handlers.fire();});
     this._hold('fire','fire',true);
    $('attack').addEventListener('click', () => this.handlers.attack && this.handlers.attack('punch'));
    $('kick').addEventListener('click', () => this.handlers.attack && this.handlers.attack('kick'));
    $('view').addEventListener('click', () => this.handlers.view && this.handlers.view());
    $('lock').addEventListener('click', () => this.handlers.lock && this.handlers.lock());
    $('pauseGame').addEventListener('click', () => {
      if (!gameStarted) return;
      gamePaused = !gamePaused;
      $('pauseOverlay').classList.toggle('show', gamePaused);
      $('pauseGame').textContent = gamePaused ? '▶' : 'Ⅱ';
      if (gamePaused) { this.input.boost=false; this.input.up=0; this.input.down=0; this.input.run=false; this.input.hover=false; }
    });
    $('resumeGame').addEventListener('click', () => {
      gamePaused=false; $('pauseOverlay').classList.remove('show'); $('pauseGame').textContent='Ⅱ';
    });
    $('settingsButton').addEventListener('click', () => $('settingsOverlay').classList.add('show'));
    $('closeSettings').addEventListener('click', () => $('settingsOverlay').classList.remove('show'));
    $('cameraReset').addEventListener('click', () => {
      if (this.handlers.resetCamera) this.handlers.resetCamera();
      $('settingsOverlay').classList.remove('show'); this.toast('CAMERA RESET');
    });
    $('startGame').addEventListener('click', () => this.handlers.start && this.handlers.start());
    $('openTutorial').addEventListener('click', () => { $('tutorial').classList.add('show'); if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance('Sir, use the left control pad to move. Drag the screen to look around. Select fly to take off. Use up and down to control altitude. Boost for speed, fire to discharge the repulsors, and land near a safe surface.'); u.rate = 0.94; u.pitch = 0.88; window.speechSynthesis.speak(u); } });
    $('closeTutorial').addEventListener('click', () => $('tutorial').classList.remove('show'));
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
  constructor(scene, n = 64) {
    this.n=n; this.seeded=false; this.off=[]; this.w=[]; this.l=[];
    for(let i=0;i<n;i++){this.off.push(new THREE.Vector3());this.w.push(.12);this.l.push(6);}
    this.mat=new THREE.MeshBasicMaterial({map:streakTexture(),color:0xcfeeff,transparent:true,opacity:0,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
    this.mesh=new THREE.InstancedMesh(new THREE.PlaneGeometry(1,1),this.mat,n);
    this.mesh.frustumCulled=false;this.mesh.visible=false;this.mesh.renderOrder=8;scene.add(this.mesh);
    this._m=new THREE.Matrix4();this._P=new THREE.Vector3();this._X=new THREE.Vector3();this._Y=new THREE.Vector3();this._Z=new THREE.Vector3();this._C=new THREE.Vector3();
    this._side=new THREE.Vector3();this._up=new THREE.Vector3();this._worldUp=new THREE.Vector3(0,1,0);
  }
  _spawn(i,dir,side,up){
    const ahead=5+Math.random()*34, lateral=(Math.random()-.5)*34, vertical=(Math.random()-.5)*22;
    this.off[i].copy(dir).multiplyScalar(ahead).addScaledVector(side,lateral).addScaledVector(up,vertical);
    this.w[i]=.055+Math.random()*.12;this.l[i]=4+Math.random()*8;
  }
  update(dt,pos,vel,active,camPos){
    const sp=vel.length(), intensity=THREE.MathUtils.clamp((sp-6)/58,0,1);
    this.mesh.visible=!!active&&sp>7;
    this.mat.opacity=THREE.MathUtils.damp(this.mat.opacity,this.mesh.visible?.08+intensity*.42:0,8,dt);
    if(!this.mesh.visible)return;
    this._Y.copy(vel).normalize();
    this._side.crossVectors(this._Y,this._worldUp);
    if(this._side.lengthSq()<1e-5)this._side.set(1,0,0);else this._side.normalize();
    this._up.crossVectors(this._side,this._Y).normalize();
    if(!this.seeded){for(let i=0;i<this.n;i++)this._spawn(i,this._Y,this._side,this._up);this.seeded=true;}
    const stretch=.45+intensity*1.35;
    for(let i=0;i<this.n;i++){
      const v=this.off[i];v.addScaledVector(vel,-dt);
      if(v.dot(this._Y)<-10||v.length()>58)this._spawn(i,this._Y,this._side,this._up);
      this._P.set(pos.x+v.x,pos.y+v.y,pos.z+v.z);
      this._C.copy(camPos).sub(this._P).normalize();
      this._X.crossVectors(this._Y,this._C);
      if(this._X.lengthSq()<1e-6)this._X.copy(this._side);
      this._X.normalize();this._Z.crossVectors(this._X,this._Y).normalize();
      const xs=this._X.clone().multiplyScalar(this.w[i]);
      const ys=this._Y.clone().multiplyScalar(this.l[i]*stretch);
      this._m.makeBasis(xs,ys,this._Z);this._m.setPosition(this._P);this.mesh.setMatrixAt(i,this._m);
    }
    this.mesh.instanceMatrix.needsUpdate=true;
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
 constructor(camera,hero){this.camera=camera;this.hero=hero;this.enabled=true;this.mode='MENU';this.time=0;this.duration=6.5;this.tmp=new THREE.Vector3();}
 trigger(mode,duration=1.8){this.mode=mode;this.time=0;this.duration=duration;this.enabled=true;}
 toggle(){this.enabled=!this.enabled;this.mode=this.enabled?'FOLLOW':'MANUAL';return this.enabled;}
 update(dt,move){
  if(!this.enabled)return;this.time+=dt;
  const h=this.hero.root.position,yaw=this.hero.root.rotation.y;
  const f=new THREE.Vector3(-Math.sin(yaw),0,-Math.cos(yaw)),r=new THREE.Vector3(f.z,0,-f.x);
  const p=this.tmp,target=new THREE.Vector3(h.x,h.y+1.1,h.z);
  if(this.mode==='MENU'){
   p.set(h.x+1.35,h.y+1.2,h.z+3.15);
  }else if(this.mode==='INTRO'){
   const t=THREE.MathUtils.clamp(this.time/this.duration,0,1),e=t*t*(3-2*t);
   p.set(h.x+1.5,h.y+1.9,h.z+2.4).lerp(new THREE.Vector3(h.x-f.x*9+3,h.y+4.8,h.z-f.z*9+11),e);
   if(t>=1){this.mode='FOLLOW';this.time=0;this.enabled=false;}
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
  this.camera.fov=THREE.MathUtils.damp(this.camera.fov,this.mode==='MENU'?36:(this.mode==='INTRO'?42:(this.mode==='BOOST'?78:58)),2.8,dt);this.camera.updateProjectionMatrix();
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


// ===== missions/MissionEnvironment.js =====
class MissionEnvironment {
 constructor(scene,city){this.scene=scene;this.city=city;this.group=new THREE.Group();scene.add(this.group);this.active='carrier';this.deckY=7;this.bounds={minX:-82,maxX:82,minZ:-278,maxZ:-32};this.spawn=new THREE.Vector3(0,7,-245);}
 clear(){while(this.group.children.length)this.group.remove(this.group.children[0]);}
 mat(color,metalness=.15,roughness=.72){return new THREE.MeshStandardMaterial({color,metalness,roughness});}
 box(w,h,d,material,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;this.group.add(m);return m;}
 label(text,x,z,w=18,h=8,color='#e7edf0'){
  const c=document.createElement('canvas');c.width=512;c.height=256;const ctx=c.getContext('2d');
  ctx.clearRect(0,0,512,256);ctx.fillStyle=color;ctx.font='900 190px Arial';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,256,132);
  const tex=new THREE.CanvasTexture(c);tex.colorSpace=THREE.SRGBColorSpace;
  const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,side:THREE.DoubleSide}));
  m.rotation.x=-Math.PI/2;m.position.set(x,this.deckY+1.045,z);this.group.add(m);return m;
 }
 light(x,y,z,color=0x77ddff){
  const m=new THREE.Mesh(new THREE.SphereGeometry(.32,8,6),new THREE.MeshBasicMaterial({color}));
  m.position.set(x,y,z);this.group.add(m);
 }
 setMission(type='carrier'){
  this.clear();this.active=type;this.city.group.visible=type==='city';
  if(type==='city'){this.spawn.set(0,this.city.surfaceAt(0,0),0);return;}
  const dark=this.mat(0x17232d,.72,.48),deck=this.mat(0x3b454c,.55,.68),line=this.mat(0xd9e1e4,.2,.6),yellow=this.mat(0xf2b83e,.35,.5),glass=this.mat(0x31576a,.8,.18),white=this.mat(0xb9c4c9,.5,.5),black=this.mat(0x101a23,.35,.8);
  // Deep ocean: a broad reflective surface gives the carrier a clear horizon and scale.
  const seaCanvas=document.createElement('canvas');seaCanvas.width=seaCanvas.height=256;const sx=seaCanvas.getContext('2d');
  sx.fillStyle='#123747';sx.fillRect(0,0,256,256);
  for(let i=0;i<900;i++){const x=(i*73)%256,y=(i*137)%256;sx.strokeStyle=i%3?'rgba(130,205,220,.10)':'rgba(220,245,250,.16)';sx.lineWidth=1;sx.beginPath();sx.moveTo(x,y);sx.lineTo(x+8+(i%17),y+((i%5)-2));sx.stroke();}
  const seaTex=new THREE.CanvasTexture(seaCanvas);seaTex.wrapS=seaTex.wrapT=THREE.RepeatWrapping;seaTex.repeat.set(7,7);
  const sea=new THREE.Mesh(new THREE.PlaneGeometry(1200,1200),new THREE.MeshStandardMaterial({map:seaTex,color:0x9ab8c5,metalness:.35,roughness:.3}));
  sea.rotation.x=-Math.PI/2;sea.position.set(0,-6.2,-150);this.group.add(sea);
  if(type==='carrier'){
   this.bounds={minX:-78,maxX:78,minZ:-278,maxZ:-32};this.deckY=7;
   // Hull, flight deck and angled landing extension.
   this.box(145,10,270,dark,0,0,-155);this.box(118,2,250,deck,0,6,-155);this.box(24,2,65,deck,49,6,-85);
   this.box(142,1.4,246,black,0,-4.7,-155);this.box(2,3,238,yellow,-72,-1.8,-155);this.box(2,3,238,yellow,72,-1.8,-155);
   const bow=new THREE.Mesh(new THREE.ConeGeometry(72,48,4),dark);bow.rotation.x=-Math.PI/2;bow.position.set(0,0,-292);bow.scale.set(1,1,1.25);this.group.add(bow);
   // Flight deck runway, catapult tracks, landing area and arresting cables.
   for(let x of [-48,-24,0,24,48])this.box(.65,.06,210,line,x,7.05,-155);
   for(let z of [-255,-215,-175,-135,-95,-55])this.box(110,.05,.55,line,0,7.06,z);
   this.box(2,.08,90,yellow,-54,7.08,-155);
   for(let i=0;i<5;i++)this.box(92,.045,.24,white,0,7.09,-90+i*3.2);
   for(let x of [-57,57])for(let z=-270;z<-45;z+=18)this.light(x,7.55,z,x<0?0xffc56d:0x66dfff);
   this.label('87',0,-255,22,11);this.label('CAT',-35,-220,12,5,'#f5c65e');
   // Island superstructure with bridge windows, mast, radar and antenna arrays.
   this.box(22,26,32,dark,38,20,-80);this.box(25,2,34,white,38,34,-80);this.box(18,8,20,glass,38,29,-80);
   this.box(20,2,28,dark,38,38,-80);this.box(14,7,16,glass,38,42,-80);this.box(16,1,18,white,38,46,-80);
   for(let i=0;i<5;i++)this.box(.35,3,.35,white,31+i*3.5,29,-63.7);
   this.box(1,16,1,white,38,55,-80);this.box(12,.45,.45,white,38,52,-80);this.box(.45,9,.45,white,33,58,-80);
   const radar=new THREE.Mesh(new THREE.CylinderGeometry(0,3.2,.6,12),white);radar.position.set(38,64,-80);this.group.add(radar);
   for(let i=0;i<3;i++){const z=-220+i*58;this.makeJet(-30,z,deck,white);this.box(5,3,8,yellow,58,8,z+8);}
   for(let x of [-62,62]){this.box(5,3,15,yellow,x,8,-150);this.box(3,5,3,white,x,10,-150);}
   this.spawn.set(0,this.deckY,-245);
  }else{
   this.bounds={minX:-150,maxX:150,minZ:-160,maxZ:160};this.deckY=1;
   this.box(310,2,330,deck,0,0,0);
   for(let x of [-130,-100,100,130])this.box(1,.08,280,line,x,1.08,0);
   for(let z of [-130,-90,-50,0,50,90,130])this.box(270,.06,.5,line,0,1.1,z);
   for(let x of [-92,92]){this.box(58,24,54,dark,x,14,-70);this.box(60,3,56,white,x,27,-70);this.box(54,14,2,glass,x,16,-42);}
   this.box(24,38,24,dark,0,20,95);this.box(28,4,28,white,0,41,95);this.box(20,10,20,glass,0,48,95);
   this.box(52,1,52,yellow,0,2,0);this.makeJet(-38,48,deck,white);this.makeJet(42,48,deck,white);
   this.spawn.set(0,this.deckY,115);
  }
 }
 makeJet(x,z,body,accent){
  const root=new THREE.Group();root.position.set(x,this.deckY+1,z);
  const engineMat=this.mat(0x202a32,.72,.35);
  const fus=new THREE.Mesh(new THREE.CapsuleGeometry(.85,8.5,4,8),body);fus.rotation.x=Math.PI/2;root.add(fus);
  const nose=new THREE.Mesh(new THREE.ConeGeometry(.84,4.2,8),body);nose.rotation.x=-Math.PI/2;nose.position.z=-6.2;root.add(nose);
  const wing=new THREE.Mesh(new THREE.BoxGeometry(15,.32,4.4),accent);wing.position.z=.4;root.add(wing);
  const tail=new THREE.Mesh(new THREE.BoxGeometry(5,.3,2.6),body);tail.position.set(0,.9,4.5);root.add(tail);
  for(const side of [-1,1]){const fin=new THREE.Mesh(new THREE.BoxGeometry(.28,2.4,2.2),body);fin.position.set(side*1.4,1.1,4.1);fin.rotation.z=side*.12;root.add(fin);const engine=new THREE.Mesh(new THREE.CylinderGeometry(.42,.52,2.4,8),engineMat);engine.rotation.x=Math.PI/2;engine.position.set(side*1.6,-.15,2.7);root.add(engine);}
  const cockpit=new THREE.Mesh(new THREE.SphereGeometry(.78,10,8),glass);cockpit.scale.set(.75,.5,1.55);cockpit.position.set(0,.72,-2.4);root.add(cockpit);
  this.group.add(root);
 }
 surfaceAt(x,z,fallback){if(this.active==='city')return fallback(x,z);const b=this.bounds;return x>=b.minX&&x<=b.maxX&&z>=b.minZ&&z<=b.maxZ?this.deckY:fallback(x,z);}
 resolveCircle(pos,r,y){if(this.active==='city')return this.city.resolveCircle(pos,r,y);const b=this.bounds;pos.x=THREE.MathUtils.clamp(pos.x,b.minX+r,b.maxX-r);pos.z=THREE.MathUtils.clamp(pos.z,b.minZ+r,b.maxZ-r);return false;}
}
class CombatMission {
 constructor(scene,hud){
  this.scene=scene;this.hud=hud;this.targets=[];this.enemyShots=[];this.complete=false;this.playerHealth=100;this.elapsed=0;
  this.group=new THREE.Group();scene.add(this.group);
  this.shotGeo=new THREE.SphereGeometry(.13,8,6);this.shotMat=new THREE.MeshBasicMaterial({color:0xff6b4b});
  this.fx=null;this.dying=[];this.onPlayerHit=null;
 }
 build(type){
  this.group.clear();this.targets=[];this.enemyShots=[];this.dying=[];this.complete=false;this.elapsed=0;this.playerHealth=100;
  this.activeName=type==='carrier'?'CARRIER STRIKE':type==='base'?'BASE ASSAULT':'CITY DEFENSE';
  const positions=type==='carrier'?[[-22,7,-178],[22,7,-150],[-42,7,-115],[42,7,-205]]:type==='base'?[[-48,1,15],[48,1,15],[-75,1,-25],[75,1,-25]]:[[-18,18,-90],[18,18,-120],[-42,26,-155],[42,22,-185]];
  positions.forEach((p,i)=>{const root=this.makeSoldier(i);root.position.set(...p);this.group.add(root);this.targets.push({root,alive:true,hp:3,phase:i*1.4,attack:1.4+i*.45,kind:'soldier'});});
  for(let i=0;i<2;i++){const root=this.makeDrone();root.position.set((i?1:-1)*32,24,-190-i*25);this.group.add(root);this.targets.push({root,alive:true,hp:2,phase:i*2,attack:2,kind:'drone'});}
 }
 makeSoldier(i){
  const g=new THREE.Group(),armor=new THREE.MeshStandardMaterial({color:i%2?0x77818a:0x394956,metalness:.58,roughness:.43}),dark=new THREE.MeshStandardMaterial({color:0x151d25,metalness:.3,roughness:.62}),visor=new THREE.MeshBasicMaterial({color:0xff543e}),weapon=new THREE.MeshStandardMaterial({color:0x202a32,metalness:.72,roughness:.35});
  const part=(geo,mat,x,y,z)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;g.add(m);return m;};
  part(new THREE.CapsuleGeometry(.34,.72,5,9),armor,0,1.05,0);
  part(new THREE.SphereGeometry(.26,12,9),dark,0,1.82,0);
  part(new THREE.BoxGeometry(.36,.075,.075),visor,0,1.84,-.235);
  part(new THREE.BoxGeometry(.56,.28,.24),dark,0,1.42,.19);
  for(const side of [-1,1]){
   part(new THREE.SphereGeometry(.22,9,7),armor,side*.43,1.47,0);
   part(new THREE.CapsuleGeometry(.12,.52,4,7),dark,side*.48,1.12,-.02);
   part(new THREE.CapsuleGeometry(.14,.7,4,7),armor,side*.2,.4,0);
   part(new THREE.BoxGeometry(.34,.16,.42),dark,side*.2,.13,-.02);
  }
  // Visible rifle silhouette, aimed forward along local -Z.
  part(new THREE.BoxGeometry(.16,.16,.92),weapon,.28,1.34,-.48);
  part(new THREE.BoxGeometry(.11,.28,.2),weapon,.28,1.14,-.28);
  part(new THREE.CylinderGeometry(.045,.045,.52,7),weapon,.28,1.34,-1.16).rotation.x=Math.PI/2;
  return g;
 }
 makeDrone(){
  const g=new THREE.Group(),m=new THREE.MeshStandardMaterial({color:0x354653,metalness:.8,roughness:.3}),red=new THREE.MeshBasicMaterial({color:0xff553e});
  g.add(new THREE.Mesh(new THREE.SphereGeometry(.65,12,8),m));g.add(new THREE.Mesh(new THREE.BoxGeometry(2.8,.2,.6),m));
  for(const side of [-1,1]){const rotor=new THREE.Mesh(new THREE.CylinderGeometry(.05,.05,2.2,6),m);rotor.rotation.z=Math.PI/2;rotor.position.x=side*1.35;g.add(rotor);}
  const e=new THREE.Mesh(new THREE.SphereGeometry(.18,8,6),red);e.position.z=-.55;g.add(e);return g;
 }
 hit(point,hud){let found=null,dmin=7;for(const t of this.targets)if(t.alive){const d=t.root.position.distanceTo(point);if(d<dmin){found=t;dmin=d;}}if(!found)return false;const hd=found.root.position.clone().sub(point);hd.y=0;if(hd.lengthSq()<1e-4)hd.set(0,0,-1);this.damage(found,1,hud,point.clone(),hd.normalize());return true;}
 hitSegment(a,b,hud){
  const ab=b.clone().sub(a),lenSq=ab.lengthSq();let found=null,best=7;
  for(const t of this.targets)if(t.alive){
   const ap=t.root.position.clone().sub(a),u=lenSq>1e-8?THREE.MathUtils.clamp(ap.dot(ab)/lenSq,0,1):0;
   const closest=a.clone().addScaledVector(ab,u),d=closest.distanceTo(t.root.position);
   if(d<best){best=d;found=t;}
  }
  if(!found)return false;const sd=ab.lengthSq()>1e-8?ab.clone().normalize():new THREE.Vector3(0,0,-1);this.damage(found,1,hud,b.clone(),sd);return true;
 }
 prep(t){
  if(t.vel)return;
  t.vel=new THREE.Vector3();t.flash=0;t.stagger=0;t.mats=[];t.root.rotation.order='YXZ';
  t.root.traverse(o=>{const m=o.material;if(m&&m.emissive&&!t.mats.includes(m))t.mats.push(m);});
 }
 damage(target,amount,hud,point,dir){
  this.prep(target);target.hp-=amount;
  const at=point||target.root.position.clone().add(new THREE.Vector3(0,1.2,0));
  const push=dir?dir.clone():new THREE.Vector3(0,0,-1);push.y=0;if(push.lengthSq()<1e-6)push.set(0,0,-1);push.normalize();
  const power=amount>1?1.7:1,drone=target.kind==='drone';
  if(target.hp<=0){
   target.alive=false;target.flash=1;target.vel.addScaledVector(push,drone?3:8*power);if(drone)target.vel.y=2;
   this.dying.push({t:target,time:0});
   if(this.fx)this.fx.explode(at,drone?2.2:1.7);
   if(hud)hud.toast(drone?'DRONE DESTROYED':'HOSTILE NEUTRALIZED');
  }else{
   target.flash=1;target.stagger=drone?0:.38;target.vel.addScaledVector(push,(drone?4:5.5)*power);
   if(this.fx)this.fx.hit(at,push.clone().negate(),power);
   if(hud)hud.toast('ARMOR HIT · '+target.hp+' HP');
  }
  if(this.targets.every(t=>!t.alive)){this.complete=true;if(hud)hud.toast('MISSION COMPLETE · AREA SECURE');}
 }
 // Knockback slide, white-hot hit flash, stagger lean and the death sequence (soldiers topple, drones spiral and explode).
 updateReactions(dt){
  const fl=this.fx&&this.fx.surfaceAt;
  for(const t of this.targets){
   if(!t.vel)continue;
   if(t.alive){
    t.root.position.addScaledVector(t.vel,dt);t.vel.multiplyScalar(Math.max(0,1-6*dt));
    t.stagger=Math.max(0,t.stagger-dt);if(t.kind==='soldier')t.root.rotation.x=t.stagger*.9;
   }
   if(t.flash>0||t.mats.length&&t.mats[0].emissiveIntensity!==1){
    t.flash=Math.max(0,t.flash-dt*5);const f=t.flash;
    for(const m of t.mats){m.emissive.setRGB(f,.45*f,.18*f);m.emissiveIntensity=1+f;}
   }
  }
  for(let i=this.dying.length-1;i>=0;i--){
   const e=this.dying[i],t=e.t,p=t.root.position;e.time+=dt;
   if(t.kind==='drone'){
    t.vel.y-=22*dt;p.addScaledVector(t.vel,dt);t.root.rotation.z+=dt*9;t.root.rotation.y+=dt*3;
    let floor=-1e9;try{if(fl)floor=fl(p.x,p.z,p.y);}catch(err){}
    if(p.y<=floor+.3||e.time>1.4){if(this.fx)this.fx.explode(p.clone(),2.6);t.root.visible=false;this.dying.splice(i,1);}
   }else{
    p.addScaledVector(t.vel,dt);t.vel.multiplyScalar(Math.max(0,1-4*dt));t.root.rotation.x=Math.min(1.5,e.time*3.4);
    if(e.time>1.1){if(this.fx)this.fx.puff(p.clone().add(new THREE.Vector3(0,.5,0)),1);t.root.visible=false;this.dying.splice(i,1);}
   }
  }
 }
 melee(pos,heading,type,hero,hud){
  const f=new THREE.Vector3(-Math.sin(heading),0,-Math.cos(heading));let target=null,best=type==='kick'?4.4:3.5;
  for(const t of this.targets)if(t.alive&&t.kind==='soldier'){const d=t.root.position.clone().sub(pos),forward=d.x*f.x+d.z*f.z;if(forward>-.2&&d.length()<best){best=d.length();target=t;}}
  if(!target){if(hud)hud.toast('NO TARGET IN RANGE');return false;}
  const pt=target.root.position.clone().add(new THREE.Vector3(0,1.3,0));this.damage(target,type==='kick'?2:1,hud,pt,f.clone());return true;
 }
 fireAtPlayer(origin,pos){
  if(this.enemyShots.length>=24)return;
  const aim=new THREE.Vector3(pos.x-origin.x,pos.y+1.15-origin.y,pos.z-origin.z).normalize();
  const mesh=new THREE.Mesh(this.shotGeo,this.shotMat);mesh.position.copy(origin);mesh.scale.set(.85,.85,3.8);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),aim);this.group.add(mesh);
  if(this.fx)this.fx.muzzle(origin,aim);this.enemyShots.push({mesh,velocity:aim.multiplyScalar(62),life:2.8});
 }
 update(dt,pos,hud){
  this.elapsed+=dt;this.updateReactions(dt);
  for(const t of this.targets)if(t.alive){
   t.phase+=dt;const p=t.root.position;
   if(t.kind==='drone'){
    p.y+=Math.sin(t.phase*1.4)*dt*1.1;t.root.rotation.y+=dt*.45;
    t.attack-=dt;if(t.attack<=0){this.fireAtPlayer(p,pos);t.attack=2.8+((t.phase*10)%1)*.8;}
   }else{
    const dx=pos.x-p.x,dz=pos.z-p.z,d=Math.hypot(dx,dz);
    if(d<46&&!(t.stagger>0)){
     t.root.rotation.y=Math.atan2(dx,dz);
     if(d>6){p.x+=dx/d*dt*1.6;p.z+=dz/d*dt*1.6;}
     t.attack-=dt;
     if(d<34&&t.attack<=0){this.fireAtPlayer(p.clone().add(new THREE.Vector3(0,1.35,0)),pos);t.attack=1.9+((t.phase*7)%1)*.7;}
    }
   }
  }
  const playerAim=pos.clone().add(new THREE.Vector3(0,1.15,0));
  for(let i=this.enemyShots.length-1;i>=0;i--){
   const s=this.enemyShots[i],previous=s.mesh.position.clone();s.mesh.position.addScaledVector(s.velocity,dt);s.life-=dt;
   const segment=s.mesh.position.clone().sub(previous),den=segment.lengthSq();
   const u=den>1e-8?THREE.MathUtils.clamp(playerAim.clone().sub(previous).dot(segment)/den,0,1):0;
   const closest=previous.addScaledVector(segment,u);
   if(closest.distanceTo(playerAim)<1.55){
    this.playerHealth=Math.max(0,this.playerHealth-8);s.life=0;if(this.fx)this.fx.hit(playerAim.clone(),s.velocity.clone().normalize().negate(),.9,true);if(this.onPlayerHit)this.onPlayerHit(this.playerHealth);if(hud)hud.toast(this.playerHealth?'INCOMING FIRE · SUIT -8%':'SUIT CRITICAL · RETREAT');
   }
   if(s.life<=0){this.group.remove(s.mesh);this.enemyShots.splice(i,1);}
  }
  const alive=this.targets.filter(t=>t.alive).length,el=document.getElementById('mission');
  if(el)el.textContent=this.complete?'OBJECTIVE COMPLETE · AREA SECURE':'OPERATION '+this.activeName+' · HOSTILES '+alive+'/'+this.targets.length;
  const hv=document.getElementById('healthValue');if(hv)hv.textContent=Math.round(this.playerHealth)+'%';
 }
}

// ===== effects/ImpactFX.js =====
// Pooled combat feedback: sparks, tumbling debris, shockwave rings, flash and smoke. No per-hit allocation of GPU resources.
class ImpactFX {
  constructor(scene) {
    this.scene = scene; this.camera = null; this.surfaceAt = null; this.onImpact = null; this.smokeTex = null;
    const glow = glowTexture();
    // Sparks: one Points object, vertex colours fade to black (additive) as life runs out.
    this.N = 320; this.cursor = 0;
    this.sPos = new Float32Array(this.N * 3); this.sCol = new Float32Array(this.N * 3); this.sVel = new Float32Array(this.N * 3);
    this.sBase = new Float32Array(this.N * 3); this.sLife = new Float32Array(this.N); this.sMax = new Float32Array(this.N).fill(1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.sPos, 3)); g.setAttribute('color', new THREE.BufferAttribute(this.sCol, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.42, map: glow, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.points.frustumCulled = false; scene.add(this.points);
    // Debris chunks (instanced).
    this.D = 72; this.dc = 0;
    this.deb = Array.from({ length: this.D }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), rv: new THREE.Vector3(), life: 0, fl: 0 }));
    this.debMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.1, 0.22), new THREE.MeshStandardMaterial({ color: 0x858d96, metalness: 0.7, roughness: 0.45 }), this.D);
    this.debMesh.frustumCulled = false; this.debMesh.count = this.D;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._z = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.D; i++) this.debMesh.setMatrixAt(i, this._z);
    scene.add(this.debMesh);
    // Flash + shockwave ring pulses.
    this.pulses = Array.from({ length: 8 }, () => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 28), new THREE.MeshBasicMaterial({ color: 0xffc58a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffe2b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
      ring.visible = flash.visible = false; scene.add(ring, flash); return { ring, flash, t: 1, dur: 0.4, size: 1 };
    });
    this.pc = 0;
    // Smoke puffs.
    this.puffs = Array.from({ length: 18 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x5d636a, transparent: true, opacity: 0, depthWrite: false, fog: true }));
      s.visible = false; scene.add(s); return { s, t: 1, size: 1 };
    });
    this.fc = 0;
  }
  setTextures(t) { if (t && t.smoke) { this.smokeTex = t.smoke; for (const p of this.puffs) { p.s.material.map = t.smoke; p.s.material.needsUpdate = true; } } }

  _floor(p) { try { return this.surfaceAt ? this.surfaceAt(p.x, p.z, p.y) : p.y - 1.3; } catch (e) { return p.y - 1.3; } }
  emitSparks(p, dir, n, speed, col) {
    for (let k = 0; k < n; k++) {
      const i = this.cursor = (this.cursor + 1) % this.N, j = i * 3;
      const rx = Math.random() * 2 - 1, ry = Math.random() * 2 - 1, rz = Math.random() * 2 - 1, l = Math.hypot(rx, ry, rz) || 1, sp = speed * (0.35 + Math.random() * 0.9);
      this.sVel[j] = (rx / l * 0.8 + dir.x * 0.7) * sp; this.sVel[j + 1] = (ry / l * 0.8 + dir.y * 0.7 + 0.25) * sp; this.sVel[j + 2] = (rz / l * 0.8 + dir.z * 0.7) * sp;
      this.sPos[j] = p.x; this.sPos[j + 1] = p.y; this.sPos[j + 2] = p.z;
      this.sBase[j] = col[0]; this.sBase[j + 1] = col[1]; this.sBase[j + 2] = col[2];
      this.sLife[i] = this.sMax[i] = 0.35 + Math.random() * 0.55;
    }
  }
  emitDebris(p, dir, n, speed) {
    const fl = this._floor(p);
    for (let k = 0; k < n; k++) {
      const d = this.deb[this.dc = (this.dc + 1) % this.D];
      d.p.copy(p); d.fl = fl; d.life = 1.2 + Math.random() * 0.8;
      d.v.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).multiplyScalar(speed).addScaledVector(dir, speed * 0.6);
      d.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6); d.rv.set(Math.random() * 14 - 7, Math.random() * 14 - 7, Math.random() * 14 - 7);
    }
  }
  pulse(p, size, color = 0xffc58a, dur = 0.38) {
    const u = this.pulses[this.pc = (this.pc + 1) % this.pulses.length];
    u.t = 0; u.dur = dur; u.size = size; u.ring.position.copy(p); u.flash.position.copy(p);
    u.ring.material.color.setHex(color); u.ring.visible = u.flash.visible = true;
  }
  puff(p, size = 1) { const u = this.puffs[this.fc = (this.fc + 1) % this.puffs.length]; u.t = 0; u.size = size; u.s.position.copy(p); u.s.visible = true; }

  // Small hit: armour spark spray, a couple of chips, flash + ring.
  hit(p, spray, power = 1, onPlayer = false) {
    const col = onPlayer ? [1, 0.35, 0.25] : [1, 0.72, 0.38];
    this.emitSparks(p, spray, Math.round(18 + 14 * power), 9 + 4 * power, col);
    this.emitDebris(p, spray, 2 + Math.round(power * 2), 5 + 2 * power);
    this.pulse(p, 0.9 * power, onPlayer ? 0xff7a5a : 0xffc58a);
    if (this.onImpact) this.onImpact(onPlayer ? 0.8 : power, 'hit');
  }
  // Kill / big explosion.
  explode(p, power = 2) {
    const up = new THREE.Vector3(0, 1, 0);
    this.emitSparks(p, up, 90, 16, [1, 0.62, 0.25]); this.emitSparks(p, up, 30, 10, [1, 0.95, 0.8]);
    this.emitDebris(p, up, 16, 8 + power * 2);
    this.pulse(p, 2.2 * power, 0xffd09a, 0.5); this.pulse(p, 1.2 * power, 0xffffff, 0.25);
    for (let i = 0; i < 4; i++) this.puff(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 0.8, (Math.random() - 0.5) * 1.2)), power);
    if (this.onImpact) this.onImpact(power * 1.3, 'kill');
  }
  // Repulsor strike on a building / ground.
  spark(p, dir) { this.emitSparks(p, dir, 12, 7, [0.7, 0.95, 1]); this.pulse(p, 0.55, 0x9fe8ff, 0.25); }
  muzzle(p, dir) { this.emitSparks(p, dir, 5, 6, [1, 0.35, 0.22]); }

  update(dt) {
    const cq = this.camera ? this.camera.quaternion : null;
    for (let i = 0; i < this.N; i++) {
      const j = i * 3; let l = this.sLife[i];
      if (l <= 0) { if (this.sCol[j] || this.sCol[j + 1] || this.sCol[j + 2]) this.sCol[j] = this.sCol[j + 1] = this.sCol[j + 2] = 0; continue; }
      l -= dt; this.sLife[i] = l; const dr = Math.max(0, 1 - 1.6 * dt);
      this.sVel[j + 1] -= 16 * dt; this.sVel[j] *= dr; this.sVel[j + 1] *= dr; this.sVel[j + 2] *= dr;
      this.sPos[j] += this.sVel[j] * dt; this.sPos[j + 1] += this.sVel[j + 1] * dt; this.sPos[j + 2] += this.sVel[j + 2] * dt;
      const k = Math.max(0, l / this.sMax[i]); this.sCol[j] = this.sBase[j] * k; this.sCol[j + 1] = this.sBase[j + 1] * k; this.sCol[j + 2] = this.sBase[j + 2] * k;
    }
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.color.needsUpdate = true;
    let dirty = false;
    for (let i = 0; i < this.D; i++) {
      const d = this.deb[i]; if (d.life <= 0) continue;
      dirty = true; d.life -= dt;
      if (d.life <= 0) { this.debMesh.setMatrixAt(i, this._z); continue; }
      d.v.y -= 20 * dt; d.p.addScaledVector(d.v, dt);
      if (d.p.y < d.fl + 0.05) { d.p.y = d.fl + 0.05; if (d.v.y < 0) d.v.y *= -0.32; d.v.x *= 0.6; d.v.z *= 0.6; d.rv.multiplyScalar(0.5); }
      d.r.x += d.rv.x * dt; d.r.y += d.rv.y * dt; d.r.z += d.rv.z * dt;
      const sc = Math.min(1, d.life * 3);
      this._m.compose(d.p, this._q.setFromEuler(d.r), this._s.set(sc, sc, sc)); this.debMesh.setMatrixAt(i, this._m);
    }
    if (dirty) this.debMesh.instanceMatrix.needsUpdate = true;
    for (const u of this.pulses) {
      if (u.t >= 1) { if (u.ring.visible) u.ring.visible = u.flash.visible = false; continue; }
      u.t = Math.min(1, u.t + dt / u.dur); const t = u.t;
      u.ring.scale.setScalar(u.size * (0.5 + t * 5)); u.ring.material.opacity = (1 - t) * 0.8; if (cq) u.ring.quaternion.copy(cq);
      u.flash.scale.setScalar(u.size * 3.2 * (1 - t * 0.5)); u.flash.material.opacity = (1 - t) * (1 - t);
    }
    for (const u of this.puffs) {
      if (u.t >= 1) { if (u.s.visible) u.s.visible = false; continue; }
      u.t = Math.min(1, u.t + dt / 1.1); u.s.position.y += dt * 1.3; u.s.scale.setScalar(u.size * (1.5 + u.t * 5)); u.s.material.opacity = 0.5 * (1 - u.t);
    }
  }
}

// ===== main.js =====

let gameStarted = false;
let gamePaused = false;
const hud = new HUD();
const failures = [];
function drawMiniMap(pos, heading, mission) {
 const c=document.getElementById('minimap'); if(!c)return;
 const x=c.getContext('2d'),w=c.width,h=c.height,sc=w/(WORLD_LIMIT*2);
 x.clearRect(0,0,w,h);x.fillStyle='#071725';x.fillRect(0,0,w,h);
 x.strokeStyle='rgba(130,220,255,.14)';x.lineWidth=1;
 for(let i=1;i<4;i++){x.beginPath();x.moveTo(i*w/4,0);x.lineTo(i*w/4,h);x.stroke();x.beginPath();x.moveTo(0,i*h/4);x.lineTo(w,i*h/4);x.stroke();}
 for(const t of mission.targets)if(t.alive){x.fillStyle='#ff665d';x.beginPath();x.arc(w/2+t.root.position.x*sc,h/2+t.root.position.z*sc,3.5,0,Math.PI*2);x.fill();}
 x.save();x.translate(w/2+pos.x*sc,h/2+pos.z*sc);x.rotate(-heading);x.fillStyle='#9ff4ff';x.beginPath();x.moveTo(0,-8);x.lineTo(5,6);x.lineTo(0,3);x.lineTo(-5,6);x.closePath();x.fill();x.restore();
}
async function boot() {
  const perf = new PerformanceManager();
  const sm = new SceneManager(perf);
  const assets = new AssetManager({ onError: m => { failures.push(m); hud.logError(m); }, onStatus: (ok, bad) => hud.setAssetStatus(ok, bad) });
  const city = new CityManager(sm.scene, assets, perf);
  const nycWorld = new NYCWorld(sm.scene, assets, perf, city);
  const hero = new IronMan(assets, perf);
  const move = new MovementController();
  const cam = new ThirdPersonCamera(sm.camera, city);
  const rep = new RepulsorSystem(sm.scene);
  const rings = new RingCourse(sm.scene, city);
  const wind = new WindLines(sm.scene);
  const cine = new CinematicDirector(sm.camera, hero);
  const missionEnv = new MissionEnvironment(sm.scene, city);
  const mission = new CombatMission(sm.scene, hud);
  // Combat feedback: sparks/debris/shockwave, camera shake, hit-stop on kills and a red damage flash.
  const fx = new ImpactFX(sm.scene); fx.camera = sm.camera; fx.surfaceAt = (x, z, y) => city.surfaceAt(x, z, y);
  mission.fx = fx; rep.fx = fx; rep.world = city; let hitStop = 0;
  fx.onImpact = (power, kind) => { cam.bump(Math.min(.32, .05 + .07 * power)); if (kind === 'kill' || power > 1.4) hitStop = Math.max(hitStop, .07); };
  const hitFlash = document.createElement('div');
  hitFlash.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:3;opacity:0;background:radial-gradient(ellipse at center,rgba(255,40,30,0) 45%,rgba(255,40,30,.6) 100%)';
  document.body.appendChild(hitFlash);
  mission.onPlayerHit = () => { hitFlash.style.transition = 'none'; hitFlash.style.opacity = 1; void hitFlash.offsetWidth; hitFlash.style.transition = 'opacity .45s'; hitFlash.style.opacity = 0; cam.bump(.2); };
  const traffic = new TrafficSystem(sm.scene, perf);
  cam.attach(sm.renderer.domElement);
  const citySurfaceAt = city.surfaceAt.bind(city), cityResolveCircle = city.resolveCircle.bind(city), cityRaycast = city.raycast.bind(city);
  city.surfaceAt = (x,z,currentY=0) => nycWorld.group.visible ? nycWorld.surfaceAt(x,z,currentY) : missionEnv.surfaceAt(x,z,citySurfaceAt);
  city.resolveCircle = (pos,r,y) => nycWorld.group.visible ? nycWorld.resolveCircle(pos,r,y) : (missionEnv.active==='city' ? cityResolveCircle(pos,r,y) : missionEnv.resolveCircle(pos,r,y));
  city.raycast = (origin,dir,maxDist) => nycWorld.group.visible ? nycWorld.raycast(origin,dir,maxDist) : cityRaycast(origin,dir,maxDist);
  missionEnv.setMission('city'); mission.build('city'); move.pos.set(0,0,0);
  sm.scene.add(hero.root);
  perf.onTierChange = t => { sm.renderer.setPixelRatio(Math.min(devicePixelRatio, t.pixelRatio)); city.setRadii(t.nearRadius, t.farRadius); hud.toast('QUALITY: ' + t.name.toUpperCase()); };

  hud.setLoading('READING ASSET ARCHIVES', 2);
  await assets.mountZips(['source.zip', 'textures.zip', 'stark-city-part-1.zip', 'stark-city-part-2.zip', 'stark-city-part-3.zip', 'stark-city-part-4.zip', 'stark-animation-assets.zip', 'stark-next-animations.zip', 'stark-next-city.zip', 'stark-next-apartments.zip', 'kenney_city-kit-commercial_2_1.zip', 'stark-environment-pack.zip', 'stark-nyc-world-optimized.zip', 'stark-city-assets.zip', 'stark-npc-male.zip', 'stark-npc-female.zip', 'stark-npc-animations.zip', 'stark-vfx-assets.zip'], p => hud.setLoading('READING ASSET ARCHIVES', 2 + p * 8));
  // Optional community asset layer: static pedestrian silhouettes and street dressing.
  // NPC animation clips are mounted for subsequent retargeting; they are not played until
  // skeleton compatibility is verified, avoiding broken rigs on mobile.
  class CommunityAssetLayer {
    constructor(scene,assets,perf){
      this.scene=scene;this.assets=assets;this.perf=perf;this.group=new THREE.Group();scene.add(this.group);
      this.loaded=[];this.textures={};this.pedestrians=[];this.clock=0;
    }
    report(n,e){hud.logError('COMMUNITY '+n+': '+(e&&e.message||e));}
    place(root,x,z,h=1.8,rot=0){
      const box=new THREE.Box3().setFromObject(root),size=box.getSize(new THREE.Vector3()),k=h/Math.max(size.y,.01);
      root.scale.setScalar(k);root.position.set(x-(box.min.x+box.max.x)*.5*k,-box.min.y*k,z-(box.min.z+box.max.z)*.5*k);root.rotation.y=rot;
      root.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=true;}});
      this.group.add(root);return root;
    }
    rigData(root){
      const bones={leftArm:null,rightArm:null,leftForearm:null,rightForearm:null,leftLeg:null,rightLeg:null,leftShin:null,rightShin:null,spine:null};
      root.traverse(o=>{
        if(!o.isBone)return;
        const n=o.name.toLowerCase().replace(/[^a-z]/g,'');
        if(/leftarm$/.test(n))bones.leftArm=o;
        else if(/rightarm$/.test(n))bones.rightArm=o;
        else if(/leftforearm$/.test(n))bones.leftForearm=o;
        else if(/rightforearm$/.test(n))bones.rightForearm=o;
        else if(/leftupleg$|leftthigh$/.test(n))bones.leftLeg=o;
        else if(/rightupleg$|rightthigh$/.test(n))bones.rightLeg=o;
        else if(/leftleg$/.test(n))bones.leftShin=o;
        else if(/rightleg$/.test(n))bones.rightShin=o;
        else if(/spine$|spine1$/.test(n))bones.spine=o;
      });
      const joints=Object.entries(bones).filter(([,v])=>v).map(([key,bone])=>({key,bone,base:bone.rotation.clone()}));
      return joints.length>=4?joints:null;
    }
    fallback(x,z,i){
      const root=new THREE.Group(),coat=new THREE.MeshStandardMaterial({color:i%2?0x263e54:0x743638,roughness:.78}),skin=new THREE.MeshStandardMaterial({color:0xb98c70,roughness:.9}),pants=new THREE.MeshStandardMaterial({color:0x202a34,roughness:.86});
      const add=(parent,geo,mat,pos)=>{const m=new THREE.Mesh(geo,mat);m.position.set(...pos);m.castShadow=false;parent.add(m);return m;};
      add(root,new THREE.CapsuleGeometry(.21,.48,4,8),coat,[0,1.12,0]);add(root,new THREE.SphereGeometry(.15,10,8),skin,[0,1.62,0]);
      const limbs=[];
      for(const side of [-1,1]){
        const arm=new THREE.Group();arm.position.set(side*.24,1.36,0);add(arm,new THREE.CapsuleGeometry(.065,.42,3,6),coat,[0,-.23,0]);root.add(arm);
        const leg=new THREE.Group();leg.position.set(side*.12,.82,0);add(leg,new THREE.CapsuleGeometry(.085,.48,3,6),pants,[0,-.25,0]);root.add(leg);
        limbs.push({arm,leg,side});
      }
      root.position.set(x,0,z);this.group.add(root);
      const npc={root,joints:null,limbs,phase:i*1.7,speed:.8+(i%3)*.13,originX:x,originZ:z,radius:1.8,heading:i%2?Math.PI:0};
      this.pedestrians.push(npc);return npc;
    }
    async prop(n,x,z,h,r=0){try{const g=await this.assets.loadGLTF(n);this.place(g.scene,x,z,h,r);this.loaded.push(n);}catch(e){this.report(n,e);}}
    async pedestrian(n,x,z,i){
      try{
        const g=await this.assets.loadGLTF(n),root=this.place(g.scene,x,z,1.8,i%2?Math.PI:0),joints=this.rigData(root);
        if(!joints){this.group.remove(root);this.fallback(x,z,i);return;}
        const npc={root,joints,limbs:null,phase:i*1.7,speed:.8+(i%3)*.13,originX:x,originZ:z,radius:2.2,heading:i%2?Math.PI:0};
        this.pedestrians.push(npc);this.loaded.push(n);
      }catch(e){this.report(n,e);this.fallback(x,z,i);}
    }
    async load(){
      await Promise.all([
        this.prop('kenney-roads-dumpster.glb',-13,-42,2.1),this.prop('kenney-roads-electricity-pole.glb',13,-42,8),
        this.prop('kenney-roads-traffic-light.glb',-13,42,5.5,Math.PI),this.prop('kenney-roads-construction-barrier.glb',13,42,1.2,Math.PI/2),
        this.pedestrian('npc-male-Superhero_Male_FullBody.gltf',-9,-20,0),this.pedestrian('npc-female-Superhero_Female_FullBody.gltf',9,-20,1),
        this.pedestrian('npc-male-Superhero_Male_FullBody.gltf',-12,22,2),this.pedestrian('npc-female-Superhero_Female_FullBody.gltf',12,22,3)
      ]);
      for(const [k,n] of Object.entries({flame:'vfx-particle-flame_01.png',muzzle:'vfx-particle-muzzle_01.png',spark:'vfx-particle-spark_01.png',smoke:'vfx-smoke-explosion00.png'})){
        const t=await this.assets.loadTexture(n,{srgb:true,anisotropy:2});if(t)this.textures[k]=t;
      }
      return this.loaded.length;
    }
    update(dt){
      this.clock+=dt;
      for(const n of this.pedestrians){
        const phase=this.clock*n.speed+n.phase,walk=Math.sin(phase),counter=Math.cos(phase);
        // Move along a short sidewalk loop; this is a lightweight crowd pass, not pathfinding.
        n.root.position.x=n.originX+Math.sin(phase*.22)*n.radius;
        n.root.position.z=n.originZ+Math.cos(phase*.22)*n.radius;
        n.root.rotation.y=n.heading+Math.sin(phase*.22)*.22;
        if(n.joints)for(const j of n.joints){
          const k=j.key;
          j.bone.rotation.copy(j.base);
          if(k==='leftArm')j.bone.rotation.x+=walk*.42;
          else if(k==='rightArm')j.bone.rotation.x-=walk*.42;
          else if(k==='leftForearm')j.bone.rotation.x-=.12;
          else if(k==='rightForearm')j.bone.rotation.x-=.12;
          else if(k==='leftLeg')j.bone.rotation.x+=walk*.58;
          else if(k==='rightLeg')j.bone.rotation.x-=walk*.58;
          else if(k==='leftShin')j.bone.rotation.x+=Math.max(0,-walk)*.48;
          else if(k==='rightShin')j.bone.rotation.x+=Math.max(0,walk)*.48;
          else if(k==='spine')j.bone.rotation.z+=counter*.025;
        }
        if(n.limbs)for(const l of n.limbs){l.arm.rotation.x=(l.side===-1?1:-1)*walk*.48;l.leg.rotation.x=(l.side===-1?-1:1)*walk*.62;}
      }
    }
    apply(hero,rep){
      const t=this.textures.flame;if(t)for(const j of hero.thrusters||[]){j.glow.material.map=t;j.glow.material.needsUpdate=true;j.flare.material.map=t;j.flare.material.needsUpdate=true;}
      if(rep&&this.textures.muzzle)rep.setTexture(this.textures.muzzle);
    }
  }

  // Hero first (playable immediately), city second; either failure is reported and never blocks the loop.
  let heroOk = true, cityOk = true, nycOk = false;
  await Promise.all([
    hero.load((t, p) => hud.setLoading(t, p * 0.45)).catch(e => { heroOk = false; hud.setLoading('MARK 85 ERROR: ' + e.message, 100); }),
    city.load((t, p) => hud.setLoading(t, 45 + p * 0.55)).catch(e => { cityOk = false; hud.logError('CITY: ' + e.message); }),
    traffic.loadModels(assets).catch(e => { hud.logError('TRAFFIC MODELS: ' + e.message); return false; }),
    Promise.resolve(false).then(ok=>{nycOk=ok;}),
  ]);
  const community = new CommunityAssetLayer(sm.scene, assets, perf);
  await community.load().catch(e => hud.logError('COMMUNITY ASSETS: ' + e.message));
  fx.setTextures(community.textures);
  const environment = (await assets.loadEXR('modern_evening_street_1k.exr').catch(() => null)) || (await assets.loadEXR('urban_street_01_1k.exr').catch(() => null));
  if (environment) sm.setEnvironment(environment);
  community.apply(hero, rep);
  assets.release();
  const degraded = !heroOk || !cityOk || failures.length > 0;
  hud.setLoading(degraded ? 'CORE SYSTEMS READY · LIMITED ASSETS' : 'SYSTEMS ONLINE · READY FOR DEPLOYMENT', 100);
  setTimeout(() => hud.hideLoading(), 900);
  // Start grounded in WALK mode. Flight begins only when the player presses FLY.
  move.pos.y = nycOk ? nycWorld.surfaceAt(move.pos.x, move.pos.z, nycWorld.bounds.max.y) : city.surfaceAt(move.pos.x, move.pos.z);
  move.mode = MODE.WALK;
  hud.setFlightUI(false);
  hud.toast(heroOk && cityOk ? "MARK 85 ONLINE" : 'DEGRADED MODE — SEE ERRORS');

  hud.on('fly', () => { if (move.takeoff()) { hud.setFlightUI(true); cam.bump(0.05); cine.trigger('TAKEOFF', 1.7); hud.toast('TAKEOFF — THRUSTERS ENGAGED'); } });
  hud.on('land', () => { if (move.land()) { cine.trigger('LANDING', 2.0); hud.toast('LANDING'); } });
  const briefings = {
    overview:['GOOD EVENING, SIR.','All systems are operational. The Mark 85 is ready for deployment. I recommend reviewing the flight controls before entering the city.','Select a database category. I will brief you on the selected system.'],
    city:['CITY GRID / ONLINE','The urban environment is available for exploration. I recommend maintaining a safe altitude near dense structures.','Use the minimap to maintain your heading and locate mission contacts.'],
    districts:['DISTRICT DATABASE','The city is divided into navigable sectors. Buildings and road corridors provide visual landmarks for orientation.','Explore the city before engaging a mission target.'],
    suit:['MARK 85 / ARMOR SYSTEMS','The suit integrates an arc reactor, repulsor emitters and boot propulsion. Energy reserves are shared between sustained boost and repulsor discharge.','Monitor energy consumption during extended flight.'],
    flight:['FLIGHT CONTROL / TRAINING','Takeoff engages the boot thrusters. Directional input steers the suit; UP and DOWN control altitude. Boost increases speed and energy consumption.','Practice hovering and controlled landing before high-speed flight.'],
    story:['PROTOCOL 01 / HOSTILE CONTACT','Three hostile drone signatures have been detected in the forward sector. Approach, align the repulsors and neutralize each target.','Track hostile signatures on the minimap.']
  };
  document.querySelectorAll('.dbTab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.dbTab').forEach(b => b.classList.toggle('active', b === btn));
    const v = briefings[btn.dataset.topic] || briefings.overview;
    document.getElementById('jarvisTitle').textContent = v[0];
    document.getElementById('jarvisText').textContent = v[1];
    document.getElementById('jarvisHint').textContent = v[2];
    document.getElementById('jarvisTag').textContent = 'SYSTEM BRIEFING / ' + btn.dataset.topic.toUpperCase();
    if ('speechSynthesis' in window) { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(v[1]); u.rate = 0.94; u.pitch = 0.88; window.speechSynthesis.speak(u); }
  }));
  document.querySelectorAll('.missionCard[data-mission]').forEach(card=>card.addEventListener('click',()=>{const value=card.dataset.mission;const select=document.getElementById('missionSelect');if(select)select.value=value;document.querySelectorAll('.missionCard').forEach(c=>c.classList.toggle('active',c===card));}));
  hud.on('start', () => { const selected=document.getElementById('missionSelect')?.value||'city'; missionEnv.setMission(selected); mission.build(selected); if(selected==='city'&&nycOk){nycWorld.activate();move.pos.set(0,nycWorld.surfaceAt(0,0,nycWorld.bounds.max.y),0);}else{nycWorld.group.visible=false;city.group.visible=selected==='city';move.pos.copy(missionEnv.spawn);if(selected==='city')hud.toast('MANHATTAN GRID ONLINE');} move.vel.set(0,0,0); move.heading=0; move.mode=MODE.WALK; gameStarted = true; document.getElementById('mainmenu').classList.add('hide'); document.getElementById('ui').classList.remove('gameHidden'); hud.setFlightUI(false); cine.trigger('INTRO', 2.4); });

  const tmp = new THREE.Vector3(), dir = new THREE.Vector3();
  let cameraMode='THIRD', lockedTarget=null;
  hud.on('resetCamera', () => { cam.yaw=0; cam.pitch=0.16; cam.userDist=1; cam.curDist=9; });
  hud.on('attack', type => { if(!gameStarted || move.flying)return; hero.attack(type); mission.melee(move.pos,move.heading,type,hero,hud); cam.bump(type==='kick'?.13:.08); });
  hud.on('view', () => { cameraMode=cameraMode==='THIRD'?'FIRST':'THIRD'; document.getElementById('view').textContent=cameraMode==='FIRST'?'HELMET':'3RD PERSON'; document.getElementById('helmetHud').classList.toggle('active',cameraMode==='FIRST'); hud.toast(cameraMode==='FIRST'?'HELMET VIEW':'THIRD-PERSON VIEW'); });
  hud.on('lock', () => { const alive=mission.targets.filter(t=>t.alive);lockedTarget=alive.length?alive.reduce((best,t)=>t.root.position.distanceTo(move.pos)<best.root.position.distanceTo(move.pos)?t:best):null;document.getElementById('targetStatus').textContent=lockedTarget?'LOCKED':'NO SIGNAL';hud.toast(lockedTarget?'TARGET ACQUIRED':'NO HOSTILE SIGNAL'); });
  hud.on('fire', () => {
    if (!gameStarted) return;
    dir.set(-Math.sin(move.heading + cam.yaw), -Math.sin(cam.pitch) * 0.3, -Math.cos(move.heading + cam.yaw)).normalize();
    if(lockedTarget?.alive){const aim=lockedTarget.root.position.clone().sub(hero.root.position.clone().add(new THREE.Vector3(0,1.2,0))).normalize();dir.lerp(aim,0.78).normalize();}
    const o = [hero.worldPosOf('lHand', new THREE.Vector3()), hero.worldPosOf('rHand', new THREE.Vector3())];
    if (rep.fire(o, dir)) { cam.bump(0.08); hero.firePulse = 0.18; }
  });

  const clock = new THREE.Clock();
  (function frame() {
    requestAnimationFrame(frame);
    let dt = Math.min(clock.getDelta(), 0.05);
    if (hitStop > 0) { hitStop -= dt; dt *= 0.15; }
    perf.frame(dt);
    if (gamePaused) { sm.render(move.pos, {}); return; }
    if (!gameStarted) { hero.root.position.copy(move.pos); hero.root.rotation.y = move.heading; hero.update(dt, 0, 0, false, MODE.WALK, 0, false); city.update(move.pos); community.update(dt); if(missionEnv.active==='city')traffic.update(dt, move.pos); cine.update(dt, move); sm.render(move.pos, {}); return; }
    const inp = { x: hud.steer.x, y: hud.steer.y, run: hud.input.run, boost: hud.input.boost && move.mode === MODE.FLY && rep.energy > 1, hover: hud.input.hover, up: hud.input.up, down: hud.input.down };
    move.update(dt, inp, cam.yaw, city);
    if (move.landed) { move.landed = false; hud.setFlightUI(false); hud.toast('LANDED — WALK MODE'); cam.bump(0.06); }
    if (move.hitLimit) hud.toast('EDGE OF THE MAP');
    if (inp.boost && !cine.boostWasOn) cine.trigger('BOOST',1.25); cine.boostWasOn=inp.boost;
    rings.update(dt, move.pos, rep, hud, move.flying);
    wind.update(dt, move.pos, move.vel, move.flying && move.speed > 7, sm.camera.position);
    hero.root.position.copy(move.pos); hero.root.rotation.y = move.heading;
    hero.tilt.rotation.set(move.pitch, 0, move.bank);
    hero.update(dt, move.flying ? 1 : 0, move.speed, inp.boost, move.mode, move.vel.y, inp.hover, move.vel);
    city.update(move.pos);
    community.update(dt);
    if(missionEnv.active==='city')traffic.update(dt, move.pos);
    rep.update(dt, inp.boost, mission, hud);
     if(hud.input.fire&&gameStarted&&!gamePaused&&hud.handlers.fire)hud.handlers.fire();
     mission.update(dt, move.pos, hud); fx.update(dt); if (inp.boost) rep.energy = Math.max(0, rep.energy - dt * 14);
    if (cine.enabled) cine.update(dt, move); else if(cameraMode==='FIRST'){const eye=hero.root.position.clone().add(new THREE.Vector3(0,1.62,0));sm.camera.position.copy(eye);const a=move.heading+cam.yaw;sm.camera.lookAt(eye.x-Math.sin(a)*30,eye.y-Math.sin(cam.pitch)*8,eye.z-Math.cos(a)*30);sm.camera.fov=THREE.MathUtils.damp(sm.camera.fov,move.flying?76:68,5,dt);sm.camera.updateProjectionMatrix();}else cam.update(dt, move.pos, { flying: move.flying, boost: inp.boost, speed: move.speed });
    hud.readout(move.mode, move.pos.y, move.speed * 3.6, rep.energy);document.getElementById('helmetEnergy').textContent=Math.round(rep.energy)+'%';drawMiniMap(move.pos, move.heading, mission);
    sm.render(move.pos, { speed: move.speed, boost: inp.boost });
  })();
}
boot().catch(e => { console.error(e); hud.setLoading('STARTUP ERROR: ' + (e.message || e), 100); hud.logError(String(e.stack || e).split('\\n')[0]); });
