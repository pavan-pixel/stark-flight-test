import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import {FBXLoader} from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/FBXLoader.js';
import {GLTFLoader} from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let scene, camera, renderer, clock;
let iron = null, mixer = null, animActions = {}, currentAnim = '';
let city = [], cars = [], shots = [];
let steer = {x: 0, y: 0}, flight = false, run = false, boost = false, hover = false;
let energy = 100, shotAt = 0;
let cameraYaw = 0, cameraPitch = 0.22, cameraDistance = 10;
let draggingCamera = false, lastPointer = {x: 0, y: 0};
let suitMeshes = [], thrusterLights = [];

function loading(t, p) {
  const lt = $('loadtext'), lb = $('loadbar');
  if (lt) lt.textContent = t;
  if (lb) lb.style.width = p + '%';
}

function mat(color, metalness = 0.2, roughness = 0.7) {
  return new THREE.MeshStandardMaterial({color, metalness, roughness});
}

function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8da9c2);
  scene.fog = new THREE.FogExp2(0x9aafc2, 0.00035);

  camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 3500);

  renderer = new THREE.WebGLRenderer({antialias: devicePixelRatio < 1.5, powerPreference: 'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  document.body.prepend(renderer.domElement);

  clock = new THREE.Clock();

  const hemi = new THREE.HemisphereLight(0xdbeeff, 0x303842, 2.2);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.position.set(180, 320, 150);
  scene.add(sun);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2600, 24, 16),
    new THREE.MeshBasicMaterial({color: 0x8da9c2, side: THREE.BackSide})
  );
  scene.add(sky);

  try {
    makeCity();
    loadSuitAndAnimations();
    controls();
    setupCameraSwipe();
    addEventListener('resize', resize);
    animate();
  } catch (err) {
    console.error('STARK INIT FAILED', err);
    loading('STARTUP ERROR: ' + (err.message || err), 100);
  }
}

function makeCity() {
  const asphalt = mat(0x1e242b, 0.05, 0.92);
  const sidewalkMat = mat(0x7d8387, 0.04, 0.88);
  const curbMat = mat(0xa8abaa, 0.08, 0.75);

  // Broad NYC Central Avenue
  const road = new THREE.Mesh(new THREE.PlaneGeometry(60, 3200), asphalt);
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, -0.09, -1200);
  scene.add(road);

  for (const side of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(12, 3200), sidewalkMat);
    walk.rotation.x = -Math.PI / 2;
    walk.position.set(side * 36, -0.015, -1200);
    scene.add(walk);

    const curb = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 3200), curbMat);
    curb.position.set(side * 29.8, 0.1, -1200);
    scene.add(curb);
  }

  // Cross intersections & Avenue Crosswalks
  for (let z = 200; z > -2800; z -= 220) {
    const crossStreet = new THREE.Mesh(new THREE.PlaneGeometry(280, 24), asphalt);
    crossStreet.rotation.x = -Math.PI / 2;
    crossStreet.position.set(0, -0.07, z);
    scene.add(crossStreet);

    for (let x = -26; x <= 26; x += 3.2) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 6), new THREE.MeshBasicMaterial({color: 0xedf1f4}));
      bar.rotation.x = -Math.PI / 2;
      bar.position.set(x, 0.015, z + 11);
      scene.add(bar);
    }
  }

  // Street furniture & light posts
  const metal = mat(0x4d5b66, 0.8, 0.3);
  const lampGlow = new THREE.MeshBasicMaterial({color: 0xffefc6});
  for (let z = 250; z > -2800; z -= 65) {
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 8.5, 7), metal);
      pole.position.set(side * 28.5, 4.25, z);
      scene.add(pole);

      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 0.14), metal);
      arm.position.set(side * 27.4, 8.2, z);
      scene.add(arm);

      const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.15, 0.35), lampGlow);
      bulb.position.set(side * 26.3, 8.05, z);
      scene.add(bulb);
    }
  }

  // Dynamic NYC Traffic
  for (let i = 0; i < 30; i++) {
    const c = new THREE.Group();
    const colors = [0x223548, 0x852e2a, 0x98a3a8, 0x273133, 0xbfa97d, 0x111317];
    const paint = mat(colors[i % colors.length], 0.6, 0.3);
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.75, 4.4), paint);
    body.position.y = 0.55;
    c.add(body);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.58, 2.0), mat(0x142330, 0.6, 0.15));
    cabin.position.set(0, 1.15, -0.15);
    c.add(cabin);

    c.position.set((i % 2 ? 1 : -1) * (7 + Math.random() * 16), 0, 150 - Math.random() * 2800);
    scene.add(c);
    cars.push(c);
  }

  const infiniteGround = new THREE.Mesh(new THREE.PlaneGeometry(4500, 4500), mat(0x454f54, 0.02, 0.99));
  infiniteGround.rotation.x = -Math.PI / 2;
  infiniteGround.position.set(0, -0.5, -1200);
  scene.add(infiniteGround);

  loadCityModels();
}

async function loadCityModels() {
  try {
    loading('DOWNLOADING CITY DISTRICTS', 20);
    const partNames = ['stark-city-part-1.zip', 'stark-city-part-2.zip', 'stark-city-part-3.zip', 'stark-city-part-4.zip'];
    const archives = await Promise.all(partNames.map(async name => {
      const r = await fetch('./' + name + '?v=stark-city-08');
      if (!r.ok) throw Error(name + ' missing');
      return JSZip.loadAsync(await r.arrayBuffer());
    }));

    const files = new Map(), urls = new Map();
    for (const archive of archives) {
      for (const f of Object.values(archive.files)) {
        if (f.dir || !f.name.startsWith('city/')) continue;
        const base = f.name.split('/').pop();
        const bytes = await f.async('uint8array');
        files.set(f.name, bytes);
        if (!base.endsWith('.gltf')) {
          urls.set(base, URL.createObjectURL(new Blob([bytes])));
        }
      }
    }

    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => urls.get(decodeURIComponent(url.split('/').pop().split('?')[0])) || url);
    const loader = new GLTFLoader(manager);

    const loadModel = async name => new Promise((resolve, reject) => {
      const bytes = files.get('city/' + name + '.gltf');
      if (!bytes) { reject(Error('Missing ' + name)); return; }
      loader.parse(new TextDecoder().decode(bytes), '', g => resolve(g.scene), reject);
    });

    loading('BUILDING MANHATTAN CANYON', 40);
    const [large, medium, small] = await Promise.all([
      loadModel('Building_Large_2'),
      loadModel('Building_Medium_2_001'),
      loadModel('Building_Small_1')
    ]);

    const templates = [large, medium, small];

    // Primary Avenue Skyscraper Frontage (Surrounding player completely)
    for (let block = -4; block < 36; block++) {
      const z = -block * 78;
      for (const side of [-1, 1]) {
        const template = templates[Math.abs(block * 3 + (side > 0 ? 1 : 0)) % 3];
        const model = template.clone(true);
        const raw = new THREE.Box3().setFromObject(model);
        const rawSize = raw.getSize(new THREE.Vector3());
        const targetHeight = Math.abs(block) % 5 === 0 ? 75 : (Math.abs(block) % 3 === 0 ? 56 : 44);
        model.scale.setScalar(targetHeight / Math.max(1, rawSize.y));

        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const x = side * (46 + (Math.abs(block) % 4) * 4);
        model.position.set(x - center.x, -box.min.y, z - center.z);
        model.rotation.y = side < 0 ? 0 : Math.PI;
        scene.add(model);
        city.push(model);
      }
    }

    // Outer Skyline Blocks
    for (let i = 0; i < 35; i++) {
      const template = templates[i % 3];
      const model = template.clone(true);
      const raw = new THREE.Box3().setFromObject(model);
      const size = raw.getSize(new THREE.Vector3());
      const h = 75 + (i % 7) * 16;
      model.scale.setScalar(h / Math.max(1, size.y));

      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const side = i % 2 === 0 ? -1 : 1;
      const depth = 200 - (i % 15) * 180;
      model.position.set(side * (120 + (i % 5) * 22) - center.x, -box.min.y, depth - center.z);
      model.rotation.y = side < 0 ? 0 : Math.PI;
      scene.add(model);
      city.push(model);
    }

    for (const u of urls.values()) URL.revokeObjectURL(u);
    loading('DOWNTOWN SKYLINE READY', 55);
  } catch (err) {
    console.error('City asset loading error:', err);
    loading('FALLBACK SKYLINE ACTIVE', 45);
  }
}

async function loadSuitAndAnimations() {
  loading('INITIALIZING STARK ARMORY', 60);
  try {
    const [sourceRes, textRes] = await Promise.all([
      fetch('./source.zip'),
      fetch('./textures.zip')
    ]);

    if (!sourceRes.ok || !textRes.ok) throw Error('source.zip or textures.zip missing');

    const [sourceZip, textZip] = await Promise.all([
      JSZip.loadAsync(await sourceRes.arrayBuffer()),
      JSZip.loadAsync(await textRes.arrayBuffer())
    ]);

    const fbxFile = Object.values(sourceZip.files).find(x => !x.dir && /\.fbx$/i.test(x.name));
    if (!fbxFile) throw Error('FBX not found in source.zip');

    const modelURL = URL.createObjectURL(await fbxFile.async('blob'));
    const textureMap = new Map();
    for (const e of Object.values(textZip.files)) {
      if (e.dir || !/\.(png|jpe?g|tga)$/i.test(e.name)) continue;
      textureMap.set(e.name.split('/').pop().split('\\').pop(), URL.createObjectURL(await e.async('blob')));
    }

    loading('MOUNTING MARK 85 ARMURE', 75);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => textureMap.get(decodeURIComponent(url.split('/').pop().split('\\').pop())) || url);

    const fbxLoader = new FBXLoader(manager);
    fbxLoader.load(modelURL, async obj => {
      iron = obj;
      const box = new THREE.Box3().setFromObject(iron);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);

      iron.position.sub(center);
      iron.scale.setScalar(3.2 / maxDim);
      iron.rotation.y = 0;

      iron.traverse(o => {
        if (o.isMesh) {
          suitMeshes.push(o);
          o.frustumCulled = true;
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(m => {
              m.metalness = Math.max(m.metalness || 0, 0.88);
              m.roughness = clamp(m.roughness || 0.35, 0.18, 0.45);
              m.envMapIntensity = 1.6;
            });
          }
        }
      });

      // Arc Reactor and Boot Thruster Glow
      const glowMat = new THREE.MeshBasicMaterial({color: 0x47e8ff});
      const arc = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 16), glowMat);
      arc.position.set(0, 1.45, 0.18);
      iron.add(arc);

      const bootL = new THREE.PointLight(0x00e5ff, 0, 5);
      bootL.position.set(-0.25, 0.1, 0);
      iron.add(bootL);
      thrusterLights.push(bootL);

      const bootR = new THREE.PointLight(0x00e5ff, 0, 5);
      bootR.position.set(0.25, 0.1, 0);
      iron.add(bootR);
      thrusterLights.push(bootR);

      // Spawn in center of Manhattan Avenue
      iron.position.set(0, 0, -180);
      scene.add(iron);
      URL.revokeObjectURL(modelURL);

      // Setup Animation Mixer & Extract KinemIQ motion captures
      mixer = new THREE.AnimationMixer(iron);

      await tryLoadAnimationClips(fbxLoader);

      loading('MARK 85 ONLINE', 100);
      setTimeout(() => $('loading').classList.add('hide'), 500);
    }, undefined, err => {
      console.warn('Suit FBX fallback triggered:', err);
      setupFallbackIronMan();
    });
  } catch (e) {
    console.warn('Suit extraction failed, initiating fallback:', e);
    setupFallbackIronMan();
  }
}

async function tryLoadAnimationClips(loader) {
  try {
    loading('SYNCING FLIGHT & COMBAT RIG', 88);
    const animRes = await fetch('./stark-animation-assets.zip');
    if (!animRes.ok) return;

    const animZip = await JSZip.loadAsync(await animRes.arrayBuffer());
    const animFiles = Object.values(animZip.files).filter(f => !f.dir && /\.fbx$/i.test(f.name));

    for (const f of animFiles) {
      const blob = await f.async('blob');
      const url = URL.createObjectURL(blob);
      const clipObj = await new Promise(res => loader.load(url, res, undefined, () => res(null)));
      URL.revokeObjectURL(url);

      if (clipObj && clipObj.animations && clipObj.animations.length > 0) {
        const rawName = f.name.toLowerCase();
        let actionKey = 'idle';
        if (rawName.includes('walk')) actionKey = 'walk';
        else if (rawName.includes('run')) actionKey = 'run';
        else if (rawName.includes('fly') || rawName.includes('hover')) actionKey = 'fly';

        const clip = clipObj.animations[0];
        const action = mixer.clipAction(clip);
        animActions[actionKey] = action;
      }
    }

    if (animActions['idle']) {
      animActions['idle'].play();
      currentAnim = 'idle';
    }
  } catch (err) {
    console.warn('Animation pack parse notice:', err);
  }
}

function playAnimation(name) {
  if (!mixer) return;
  if (currentAnim === name) return;

  const nextAction = animActions[name];
  const prevAction = animActions[currentAnim];

  if (nextAction) {
    nextAction.reset();
    nextAction.fadeIn(0.25);
    nextAction.play();
    if (prevAction) prevAction.fadeOut(0.25);
    currentAnim = name;
  }
}

function setupFallbackIronMan() {
  loading('TACTICAL PROTOCOL ACTIVE', 100);
  const root = new THREE.Group();
  const red = mat(0x9d1c1c, 0.85, 0.25);
  const gold = mat(0xd4a537, 0.9, 0.22);
  const glow = new THREE.MeshBasicMaterial({color: 0x5feaff});

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.95, 0.4), red);
  torso.position.y = 1.35;
  root.add(torso);

  const arc = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.05, 16), glow);
  arc.rotation.x = Math.PI / 2;
  arc.position.set(0, 1.45, 0.22);
  root.add(arc);

  const helm = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.44, 0.4), gold);
  helm.position.y = 2.0;
  root.add(helm);

  root.limbs = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, 0.8, 8), red);
    arm.position.set(side * 0.55, 1.25, 0);
    root.add(arm);

    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 1.0, 8), gold);
    leg.position.set(side * 0.22, 0.5, 0);
    root.add(leg);

    root.limbs.push({arm, leg, side});
  }

  root.position.set(0, 0, -180);
  iron = root;
  scene.add(iron);
  setTimeout(() => $('loading').classList.add('hide'), 600);
}

function controls() {
  const joy = $('joy'), stick = $('stick');
  let active = false, pid = null;

  function move(e) {
    const r = joy.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const max = r.width * 0.38;
    const len = Math.hypot(dx, dy);
    const k = Math.min(1, max / (len || 1));
    steer.x = dx * k / max;
    steer.y = -dy * k / max; // Upward swipe moves forward
    stick.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  }

  joy.addEventListener('pointerdown', e => {
    active = true;
    pid = e.pointerId;
    joy.setPointerCapture(pid);
    move(e);
  });

  joy.addEventListener('pointermove', e => {
    if (active && e.pointerId === pid) move(e);
  });

  const end = e => {
    if (e.pointerId !== pid) return;
    active = false;
    pid = null;
    steer = {x: 0, y: 0};
    stick.style.transform = 'translate(0, 0)';
  };

  joy.addEventListener('pointerup', end);
  joy.addEventListener('pointercancel', end);

  $('run').onclick = () => {
    run = !run;
    $('run').classList.toggle('on', run);
    toast(run ? 'SUPERSONIC SPRINT' : 'TACTICAL WALK');
  };

  $('fly').onclick = () => {
    if (flight) return;
    flight = true;
    boost = false;
    ['fly', 'run'].forEach(id => $(id).style.display = 'none');
    ['land', 'hover', 'boost', 'fire'].forEach(id => $(id).style.display = '');
    toast('REPULSOR THRUSTERS ENGAGED');
    playAnimation('fly');
  };

  $('land').onclick = () => {
    flight = false;
    boost = false;
    hover = false;
    ['land', 'hover', 'boost', 'fire'].forEach(id => $(id).style.display = 'none');
    ['fly', 'run'].forEach(id => $(id).style.display = '');
    toast('LANDING COMPLETE — WALK MODE');
    playAnimation('idle');
  };

  $('hover').onclick = () => {
    hover = !hover;
    $('hover').classList.toggle('on', hover);
    toast(hover ? 'HOVER STABILIZATION' : 'HOVER DISENGAGED');
  };

  $('boost').addEventListener('pointerdown', () => boost = true);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => {
    $('boost').addEventListener(ev, () => boost = false);
  });

  $('fire').onclick = fire;
}

function setupCameraSwipe() {
  const el = renderer.domElement;
  el.style.touchAction = 'none';

  el.addEventListener('pointerdown', e => {
    draggingCamera = true;
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', e => {
    if (!draggingCamera) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
    cameraYaw -= dx * 0.006;
    cameraPitch = clamp(cameraPitch + dy * 0.004, -0.35, 1.15);
  });

  const stop = () => { draggingCamera = false; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

function toast(t) {
  $('toast').textContent = t;
  $('toast').style.opacity = 1;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').style.opacity = 0, 1200);
}

function fire() {
  if (!flight || energy < 8 || performance.now() - shotAt < 220) return;
  shotAt = performance.now();
  energy -= 8;

  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 12, 12),
    new THREE.MeshBasicMaterial({color: 0x55f2ff})
  );
  m.position.copy(iron ? iron.position : new THREE.Vector3());
  m.position.y += 1.4;
  scene.add(m);

  // Fire in character facing direction
  const fireDir = new THREE.Vector3(0, 0, 1).applyQuaternion(iron.quaternion);
  shots.push({m, v: fireDir.multiplyScalar(140), life: 100});
  toast('REPULSOR DISCHARGE');
}

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (mixer) mixer.update(dt);

  if (iron) {
    const isMoving = Math.hypot(steer.x, steer.y) > 0.08;

    if (flight) {
      thrusterLights.forEach(l => l.intensity = THREE.MathUtils.damp(l.intensity, boost ? 4.5 : 2.0, 5, dt));

      const flySpeed = boost ? 90 : (hover ? 12 : 38);
      const verticalSpeed = boost ? 40 : 25;

      if (!hover) {
        iron.position.y = THREE.MathUtils.damp(iron.position.y, clamp(iron.position.y + steer.y * verticalSpeed * dt, 2.5, 400), 4, dt);
      }

      if (isMoving) {
        // Flight movement relative to camera yaw
        const moveAngle = Math.atan2(steer.x, steer.y) + cameraYaw;
        iron.position.x += Math.sin(moveAngle) * flySpeed * dt;
        iron.position.z -= Math.cos(moveAngle) * flySpeed * dt;

        // Smooth flight orientation & banking roll
        const targetRotY = moveAngle;
        const targetBank = -steer.x * 0.45;
        iron.rotation.y = THREE.MathUtils.damp(iron.rotation.y, targetRotY, 6, dt);
        iron.rotation.z = THREE.MathUtils.damp(iron.rotation.z, targetBank, 5, dt);
        iron.rotation.x = THREE.MathUtils.damp(iron.rotation.x, steer.y * 0.25, 4, dt);
      } else {
        iron.rotation.z = THREE.MathUtils.damp(iron.rotation.z, 0, 5, dt);
        iron.rotation.x = THREE.MathUtils.damp(iron.rotation.x, 0, 5, dt);
      }
    } else {
      thrusterLights.forEach(l => l.intensity = THREE.MathUtils.damp(l.intensity, 0, 6, dt));

      const pace = run ? 18.0 : 7.5;

      if (isMoving) {
        // True Third-Person Character Rotation towards input direction relative to Camera
        const moveAngle = Math.atan2(steer.x, steer.y) + cameraYaw;
        const targetQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), moveAngle);
        iron.quaternion.slerp(targetQuat, Math.min(1, dt * 14));

        // Advance in facing direction
        iron.position.x += Math.sin(moveAngle) * pace * dt;
        iron.position.z -= Math.cos(moveAngle) * pace * dt;

        // Play Walk / Run animation state
        playAnimation(run ? 'run' : 'walk');

        // Procedural limb swing if fallback model is active
        if (iron.limbs) {
          const t = clock.elapsedTime * (run ? 14 : 7);
          iron.limbs.forEach(l => {
            l.arm.rotation.x = Math.sin(t + (l.side > 0 ? Math.PI : 0)) * 0.6;
            l.leg.rotation.x = -Math.sin(t + (l.side > 0 ? Math.PI : 0)) * 0.6;
          });
        }
      } else {
        playAnimation('idle');
        if (iron.limbs) {
          iron.limbs.forEach(l => {
            l.arm.rotation.x = THREE.MathUtils.damp(l.arm.rotation.x, 0, 5, dt);
            l.leg.rotation.x = THREE.MathUtils.damp(l.leg.rotation.x, 0, 5, dt);
          });
        }
      }

      // Keep feet firmly planted on pavement
      iron.position.y = THREE.MathUtils.damp(iron.position.y, 0, 10, dt);
    }

    iron.updateMatrixWorld(true);
  }

  // Smooth Third-Person Spring-Arm Follow Camera
  const focus = iron ? iron.position.clone() : new THREE.Vector3(0, 1, 0);
  focus.y += flight ? 1.4 : 1.8;

  const currentCamDist = flight ? (boost ? 14 : 11) : (run ? 8.5 : 7.2);
  const orbitOffset = new THREE.Vector3(
    Math.sin(cameraYaw) * Math.cos(cameraPitch) * currentCamDist,
    Math.sin(cameraPitch) * currentCamDist + 1.2,
    Math.cos(cameraYaw) * Math.cos(cameraPitch) * currentCamDist
  );

  const desiredCamPos = focus.clone().add(orbitOffset);
  camera.position.lerp(desiredCamPos, Math.min(1, dt * 8));
  camera.lookAt(focus);

  // Update Moving Traffic
  for (const c of cars) {
    c.position.z += dt * 18;
    if (c.position.z > 350) c.position.z = -2500;
  }

  // Update Repulsor Projectiles
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.m.position.addScaledVector(s.v, dt);
    if (--s.life <= 0) {
      scene.remove(s.m);
      s.m.geometry.dispose();
      shots.splice(i, 1);
    }
  }

  energy = clamp(energy + (boost ? -dt * 15 : dt * 6), 0, 100);

  $('mode').textContent = flight ? (hover ? 'HOVER' : 'FLIGHT') : (run ? 'SPRINT' : 'WALK');
  $('alt').textContent = flight ? Math.round(iron ? iron.position.y * 3.2 : 0) + ' M' : 'GROUND';
  $('spd').textContent = flight ? Math.round(boost ? 640 : (hover ? 20 : 180)) : Math.round(Math.hypot(steer.x, steer.y) * (run ? 24 : 10));

  renderer.render(scene, camera);
}

init();
