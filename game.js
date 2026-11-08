import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import {FBXLoader} from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/FBXLoader.js';
import {GLTFLoader} from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
let scene,camera,renderer,clock,iron=null,city=[],cars=[],shots=[],steer={x:0,y:0},flight=false,run=false,boost=false,hover=false,energy=100,shotAt=0;
let cameraYaw=0,cameraPitch=.16,cameraDistance=10,draggingCamera=false,lastPointer={x:0,y:0};
function loading(t,p){$('loadtext').textContent=t;$('loadbar').style.width=p+'%'}
function mat(color,metalness=.2,roughness=.7){return new THREE.MeshStandardMaterial({color,metalness,roughness})}
function init(){
 scene=new THREE.Scene();scene.background=new THREE.Color(0x8da9c2);scene.fog=new THREE.FogExp2(0x9aafc2,.00055);
 camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.1,3000);
 renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;document.body.prepend(renderer.domElement);
 clock=new THREE.Clock();scene.add(new THREE.HemisphereLight(0xc8e5ff,0x39404b,2.0));
 const sun=new THREE.DirectionalLight(0xffe0b4,2.4);sun.position.set(-100,180,80);scene.add(sun);
 const sky=new THREE.Mesh(new THREE.SphereGeometry(2200,24,16),new THREE.MeshBasicMaterial({color:0x8da9c2,side:THREE.BackSide}));scene.add(sky);
 try{makeCity();loadSuit();controls();setupCameraSwipe();addEventListener('resize',resize);animate()}catch(err){console.error('STARK INIT FAILED',err);loading('STARTUP ERROR: '+(err.message||err),100)}
}
function makeCity(){
 const road=new THREE.Mesh(new THREE.PlaneGeometry(54,2400),mat(0x171e27,.05,.95));road.rotation.x=-Math.PI/2;road.position.set(0,-.08,-1050);scene.add(road);
 const pavement=mat(0x68727b,.08,.9),lane=new THREE.MeshBasicMaterial({color:0xe6e9ec,transparent:true,opacity:.35});
 const metal=mat(0x778695,.8,.38);
 for(const side of [-1,1]){
  const sidewalk=new THREE.Mesh(new THREE.BoxGeometry(8,.35,2400),pavement);sidewalk.position.set(side*31,.04,-1050);scene.add(sidewalk);
 }
 for(const x of [-10,-3,3,10]){const stripe=new THREE.Mesh(new THREE.PlaneGeometry(.16,2350),lane);stripe.rotation.x=-Math.PI/2;stripe.position.set(x,.005,-1050);scene.add(stripe)}
 // Downtown GLTF models are loaded from the four uploaded archive parts.
 loadCityModels();
 // Street furniture and traffic occupy the street-level corridor.
 for(let z=-18;z>-2100;z-=58)for(const side of [-1,1]){
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.1,.16,8,7),metal);pole.position.set(side*29,4,z);scene.add(pole);
  const arm=new THREE.Mesh(new THREE.BoxGeometry(2.4,.13,.13),metal);arm.position.set(side*28,7.8,z);scene.add(arm);
  const bulb=new THREE.Mesh(new THREE.BoxGeometry(.65,.13,.35),new THREE.MeshBasicMaterial({color:0xffe3ad}));bulb.position.set(side*27,7.7,z);scene.add(bulb);
 }
 for(let i=0;i<28;i++){
  const c=new THREE.Group(),body=new THREE.Mesh(new THREE.BoxGeometry(2,.72,4.2),mat([0x172b43,0x7b2d2c,0x9c9da4,0x17201f][i%4],.55,.32));c.add(body);
  const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.5,.5,1.9),mat(0x183044,.45,.25));cabin.position.y=.48;c.add(cabin);
  c.position.set((Math.random()-.5)*19,.5,-Math.random()*2200);scene.add(c);cars.push(c);
 }
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(2800,2800),mat(0x56636b,.05,.98));ground.rotation.x=-Math.PI/2;ground.position.set(0,-.4,-1050);scene.add(ground);
}
async function loadCityModels(){
 try{
  loading('DOWNLOADING CITY ASSET PARTS',18);
  const partNames=['stark-city-part-1.zip','stark-city-part-2.zip','stark-city-part-3.zip','stark-city-part-4.zip'];
  const archives=await Promise.all(partNames.map(async name=>{
   const r=await fetch('./'+name+'?v=stark-city-parts-05');if(!r.ok)throw Error(name+' missing');
   return JSZip.loadAsync(await r.arrayBuffer());
  }));
  const files=new Map(),urls=new Map();
  for(const archive of archives)for(const f of Object.values(archive.files)){
   if(f.dir||!f.name.startsWith('city/'))continue;
   const base=f.name.split('/').pop(),bytes=await f.async('uint8array');files.set(f.name,bytes);
   if(!base.endsWith('.gltf'))urls.set(base,URL.createObjectURL(new Blob([bytes])));
  }
  const manager=new THREE.LoadingManager();
  manager.setURLModifier(url=>urls.get(decodeURIComponent(url.split('/').pop().split('?')[0]))||url);
  const loader=new GLTFLoader(manager);
  const loadModel=async name=>new Promise((resolve,reject)=>{
   const bytes=files.get('city/'+name+'.gltf');if(!bytes){reject(Error('Missing '+name));return}
   loader.parse(new TextDecoder().decode(bytes),'',g=>resolve(g.scene),reject);
  });
  loading('BUILDING DOWNTOWN CITY',35);
  const [large,medium,small,crosswalk]=await Promise.all([
   loadModel('Building_Large_2'),loadModel('Building_Medium_2_001'),
   loadModel('Building_Small_1'),loadModel('Decal_Crosswalk')
  ]);
  const templates=[large,medium,small];
  // Place the actual models close enough to the road and inside the camera's view.
  for(let i=0;i<30;i++){
   const side=i%2===0?-1:1,block=Math.floor(i/2),z=-30-block*78;
   const template=templates[(block*5+(side>0?1:0))%templates.length];
   const model=template.clone(true);
   const rawBox=new THREE.Box3().setFromObject(model),rawSize=rawBox.getSize(new THREE.Vector3());
   const targetHeight=[52,43,38][templates.indexOf(template)];
   model.scale.setScalar(targetHeight/Math.max(1,rawSize.y));
   const bounds=new THREE.Box3().setFromObject(model),center=bounds.getCenter(new THREE.Vector3());
   model.position.set(side*43-center.x,-bounds.min.y,z-center.z);
   model.rotation.y=side<0?0:Math.PI;
   model.traverse(o=>{if(o.isMesh){o.castShadow=false;o.receiveShadow=true}});
   scene.add(model);city.push(model);
  }
  for(let z=-75;z>-2200;z-=156){const mark=crosswalk.clone(true);mark.scale.setScalar(4);mark.position.set(0,.025,z);scene.add(mark)}
  for(const u of urls.values())URL.revokeObjectURL(u);
  loading('DOWNTOWN CITY READY',45);
 }catch(err){console.error('City asset loading failed:',err);loading('CITY ASSET ERROR: '+err.message,30)}
}
async function loadSuit(){
 loading('EXTRACTING MARK 85 ASSETS',10);
 try{
  const [a,b]=await Promise.all([fetch('./source.zip'),fetch('./textures.zip')]);if(!a.ok||!b.ok)throw Error('Keep source.zip and textures.zip beside index.html');
  const [za,zb]=await Promise.all([JSZip.loadAsync(await a.arrayBuffer()),JSZip.loadAsync(await b.arrayBuffer())]);
  const f=Object.values(za.files).find(x=>!x.dir&&/\.fbx$/i.test(x.name));if(!f)throw Error('FBX not found inside source.zip');
  const modelURL=URL.createObjectURL(await f.async('blob')),textureMap=new Map();
  for(const e of Object.values(zb.files)){if(e.dir||!/\.(png|jpe?g|tga)$/i.test(e.name))continue;textureMap.set(e.name.split('/').pop().split('\\').pop(),URL.createObjectURL(await e.async('blob')))}
  loading('LOADING MARK 85 MODEL',55);
  const manager=new THREE.LoadingManager();manager.setURLModifier(url=>textureMap.get(decodeURIComponent(url.split('/').pop().split('\\').pop()))||url);
  new FBXLoader(manager).load(modelURL,obj=>{
   iron=obj;const box=new THREE.Box3().setFromObject(iron),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),max=Math.max(size.x,size.y,size.z);
   if(!max)throw Error('Invalid model dimensions');iron.position.sub(center);iron.scale.setScalar(3.5/max);iron.rotation.y=Math.PI;
   iron.traverse(o=>{if(o.isMesh){o.frustumCulled=true;o.castShadow=false;if(o.material){for(const m of (Array.isArray(o.material)?o.material:[o.material])){m.metalness=Math.max(m.metalness||0,.5);m.roughness=clamp(m.roughness||.4,.2,.72)}}}});
   scene.add(iron);iron.position.set(0,0,0);URL.revokeObjectURL(modelURL);loading('MARK 85 ONLINE',100);setTimeout(()=>$('loading').classList.add('hide'),600);
  },xhr=>{if(xhr.total)loading('LOADING MARK 85 MODEL',55+Math.round(xhr.loaded/xhr.total*40))},err=>{console.error(err);fallback();});
 }catch(e){console.error(e);fallback()}
}
function fallback(){loading('MODEL ZIP NOT FOUND — TEST SUIT ACTIVE',100);const g=new THREE.Group(),red=mat(0x9d2027,.8,.25),gold=mat(0xc69a4d,.85,.22),glow=new THREE.MeshBasicMaterial({color:0x5feaff});const add=(geo,m,p,s=[1,1,1])=>{const o=new THREE.Mesh(geo,m);o.position.set(...p);o.scale.set(...s);g.add(o)};add(new THREE.CapsuleGeometry(.36,.9,6,10),red,[0,0,0]);add(new THREE.SphereGeometry(.29,16,12),gold,[0,.78,0]);add(new THREE.BoxGeometry(.36,.35,.14),glow,[0,.12,.36]);for(const x of [-1,1]){add(new THREE.CapsuleGeometry(.13,.65,4,8),red,[x*.53,.15,0]);add(new THREE.CapsuleGeometry(.12,.62,4,8),red,[x*.22,-.9,0])}g.scale.setScalar(1.5);iron=g;scene.add(iron);setTimeout(()=>$('loading').classList.add('hide'),700)}
function controls(){
 const joy=$('joy'),stick=$('stick');let active=false,pid=null;
 function move(e){const r=joy.getBoundingClientRect(),dx=e.clientX-(r.left+r.width/2),dy=e.clientY-(r.top+r.height/2),max=r.width*.34,len=Math.hypot(dx,dy),k=Math.min(1,max/(len||1));steer.x=dx*k/max;steer.y=-dy*k/max;stick.style.transform=`translate(${dx*k}px,${dy*k}px)`}
 joy.addEventListener('pointerdown',e=>{active=true;pid=e.pointerId;joy.setPointerCapture(pid);move(e)});joy.addEventListener('pointermove',e=>{if(active&&e.pointerId===pid)move(e)});
 const end=e=>{if(e.pointerId!==pid)return;active=false;pid=null;steer={x:0,y:0};stick.style.transform='translate(0,0)'};
 joy.addEventListener('pointerup',end);joy.addEventListener('pointercancel',end);
 $('run').onclick=()=>{run=!run;$('run').classList.toggle('on',run);toast(run?'RUN MODE':'WALK MODE')};
 $('fly').onclick=()=>{if(flight)return;flight=true;boost=false;['fly','run'].forEach(id=>$(id).style.display='none');['land','hover','boost','fire'].forEach(id=>$(id).style.display='');toast('TAKEOFF — THRUSTERS ENGAGED')};
 $('land').onclick=()=>{flight=false;boost=false;hover=false;['land','hover','boost','fire'].forEach(id=>$(id).style.display='none');['fly','run'].forEach(id=>$(id).style.display='');toast('LANDING COMPLETE — WALK MODE')};
 $('hover').onclick=()=>{hover=!hover;$('hover').classList.toggle('on',hover);toast(hover?'HOVER ENGAGED':'HOVER OFF')};
 $('boost').addEventListener('pointerdown',()=>boost=true);['pointerup','pointercancel','pointerleave'].forEach(ev=>$('boost').addEventListener(ev,()=>boost=false));
 $('fire').onclick=fire;
}
function setupCameraSwipe(){
 const el=renderer.domElement;el.style.touchAction='none';
 el.addEventListener('pointerdown',e=>{draggingCamera=true;lastPointer.x=e.clientX;lastPointer.y=e.clientY;el.setPointerCapture(e.pointerId)});
 el.addEventListener('pointermove',e=>{if(!draggingCamera)return;const dx=e.clientX-lastPointer.x,dy=e.clientY-lastPointer.y;lastPointer.x=e.clientX;lastPointer.y=e.clientY;cameraYaw-=dx*.006;cameraPitch=clamp(cameraPitch+dy*.004,-.25,.9)});
 const stop=()=>{draggingCamera=false};el.addEventListener('pointerup',stop);el.addEventListener('pointercancel',stop);
}
function toast(t){$('toast').textContent=t;$('toast').style.opacity=1;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').style.opacity=0,1100)}
function fire(){if(!flight||energy<5||performance.now()-shotAt<250)return;shotAt=performance.now();energy-=5;const m=new THREE.Mesh(new THREE.SphereGeometry(.12,8,8),new THREE.MeshBasicMaterial({color:0x75eaff}));m.position.copy(iron?iron.position:new THREE.Vector3());scene.add(m);shots.push({m,v:new THREE.Vector3(steer.x*.12,steer.y*.12,-1).normalize().multiplyScalar(5),life:80});toast('REPULSOR FIRED')}
function resize(){camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)}
function animate(){
 requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.04);
 if(iron){
  if(flight){
   if(!hover)iron.position.y=THREE.MathUtils.damp(iron.position.y,2.5+steer.y*5,3,dt);else iron.position.y=THREE.MathUtils.damp(iron.position.y,3,2,dt);
   iron.position.x=THREE.MathUtils.damp(iron.position.x,clamp(iron.position.x+steer.x*12*dt,-30,30),4,dt);
   iron.rotation.z=THREE.MathUtils.damp(iron.rotation.z,-steer.x*.28,4,dt);iron.rotation.x=THREE.MathUtils.damp(iron.rotation.x,steer.y*.12,3,dt);
  }else{
   const pace=run?10:4.5;iron.position.x=clamp(iron.position.x+steer.x*pace*dt,-30,30);iron.position.z-=steer.y*pace*dt;
   iron.position.y=THREE.MathUtils.damp(iron.position.y,0,6,dt);iron.rotation.y=THREE.MathUtils.damp(iron.rotation.y,steer.x*.22,4,dt);
  }
  iron.updateMatrixWorld(true);
 }
 const focus=iron?iron.position:new THREE.Vector3(0,1,0);
 const orbitOffset=new THREE.Vector3(Math.sin(cameraYaw)*cameraDistance,Math.sin(cameraPitch)*cameraDistance+2.1,Math.cos(cameraYaw)*cameraDistance);
 const desired=focus.clone().add(orbitOffset);
 camera.position.lerp(desired,Math.min(1,dt*5));
 const look=focus.clone();look.y+=1.15;camera.lookAt(look);
 for(const c of cars){c.position.z+=dt*12;if(c.position.z>30)c.position.z=-2200}
 for(let i=shots.length-1;i>=0;i--){const s=shots[i];s.m.position.addScaledVector(s.v,dt*60);if(--s.life<=0){scene.remove(s.m);s.m.geometry.dispose();shots.splice(i,1)}}
 energy=clamp(energy+(boost?-dt*12:dt*4),0,100);
 $('mode').textContent=flight?'FLIGHT':'WALK';$('alt').textContent=flight?Math.round(iron?iron.position.y*20:0)+' M':'GROUND';$('spd').textContent=flight?Math.round(boost?520:220):Math.round(Math.hypot(steer.x,steer.y)*(run?18:8));
 renderer.render(scene,camera);
}
init();
