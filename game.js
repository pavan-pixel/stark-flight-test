import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import {FBXLoader} from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/FBXLoader.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const $=id=>document.getElementById(id),clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
let scene,camera,renderer,clock,iron=null,city=[],cars=[],shots=[],lights=[],steer={x:0,y:0},flight=false,run=false,boost=false,hover=false,energy=100,shotAt=0,walkHeading=0;
function loading(t,p){$('loadtext').textContent=t;$('loadbar').style.width=p+'%'}
function mat(color,metalness=.2,roughness=.7){return new THREE.MeshStandardMaterial({color,metalness,roughness})}
function init(){
 scene=new THREE.Scene();scene.background=new THREE.Color(0x111b31);scene.fog=new THREE.FogExp2(0x17243a,.0011);
 camera=new THREE.PerspectiveCamera(62,innerWidth/innerHeight,.1,2200);
 renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.35));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;document.body.prepend(renderer.domElement);
 clock=new THREE.Clock();scene.add(new THREE.HemisphereLight(0x9dbdff,0x121622,1.7));
 const sun=new THREE.DirectionalLight(0xffd5a0,2.6);sun.position.set(-80,140,70);scene.add(sun);
 const sky=new THREE.Mesh(new THREE.SphereGeometry(1500,24,16),new THREE.MeshBasicMaterial({color:0x101b34,side:THREE.BackSide}));scene.add(sky);
 makeCity();loadSuit();controls();addEventListener('resize',resize);animate();
}
function makeCity(){
 const road=new THREE.Mesh(new THREE.PlaneGeometry(76,1800),mat(0x090f19,.1,.95));road.rotation.x=-Math.PI/2;road.position.set(0,-.08,-650);scene.add(road);
 const pavement=mat(0x394655,.15,.9),lane=new THREE.MeshBasicMaterial({color:0x9aa9b7,transparent:true,opacity:.28});
 for(const side of [-1,1]){const sidewalk=new THREE.Mesh(new THREE.BoxGeometry(12,.45,1800),pavement);sidewalk.position.set(side*44,.08,-650);scene.add(sidewalk)}
 for(const x of [-12,-4,4,12]){const stripe=new THREE.Mesh(new THREE.PlaneGeometry(.14,1750),lane);stripe.rotation.x=-Math.PI/2;stripe.position.set(x,.005,-650);scene.add(stripe)}
 const concrete=[0x26394b,0x34485a,0x1d3044,0x455363,0x202e3e].map(c=>mat(c,.35,.72));
 const glass=[0x173b56,0x24516a,0x19334b].map(c=>mat(c,.72,.2));
 const lit=[0xffca7b,0x76dfff,0xa8caff,0xff8d70].map(c=>new THREE.MeshBasicMaterial({color:c}));
 const metal=mat(0x778695,.8,.38);
 // Long, continuous city canyon with inward-facing facades and varied silhouettes.
 for(let z=-35;z>-1450;z-=42){
  for(const side of [-1,1]){
   const w=22+Math.random()*25,d=28+Math.random()*28,h=48+Math.random()*210;
   const x=side*(58+Math.random()*12),g=new THREE.Group();
   const body=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),concrete[Math.floor(Math.random()*concrete.length)]);body.position.y=h/2;g.add(body);
   const inwardX=-side*(w/2+.16);
   const facade=new THREE.Mesh(new THREE.BoxGeometry(.18,h*.94,d*.9),glass[Math.floor(Math.random()*glass.length)]);facade.position.set(inwardX,h/2,0);g.add(facade);
   // Windows sit on the street-facing side, not the end wall.
   for(let floor=0;floor<Math.floor(h/7.5);floor++)for(let col=0;col<Math.floor(d/4);col++){
    if(Math.random()<.17)continue;
    const win=new THREE.Mesh(new THREE.PlaneGeometry(1.7,2.25),lit[Math.floor(Math.random()*lit.length)]);
    win.position.set(inwardX-side*.12,4+floor*7.5,-d*.42+col*3.7);win.rotation.y=side===1?Math.PI/2:-Math.PI/2;g.add(win);
   }
   // Ledges, balcony rails, rooftop structures and occasional fire escapes.
   for(let floor=1;floor<Math.min(9,Math.floor(h/19));floor++){
    const ledge=new THREE.Mesh(new THREE.BoxGeometry(1.0,.28,d*.78),metal);ledge.position.set(inwardX-side*.38,floor*19,0);g.add(ledge);
   }
   if(Math.random()<.55){
    for(let floor=1;floor<Math.min(7,Math.floor(h/22));floor++){
     const balcony=new THREE.Mesh(new THREE.BoxGeometry(1.1,.18,d*.34),metal);balcony.position.set(inwardX-side*.55,floor*22,0);g.add(balcony);
     for(const zoff of [-d*.17,d*.17]){const rail=new THREE.Mesh(new THREE.BoxGeometry(.08,1.0,.08),metal);rail.position.set(inwardX-side*.55,floor*22+.5,zoff);g.add(rail)}
    }
   }
   // Roof plant, tanks and antennas.
   const roofCount=2+Math.floor(Math.random()*4);
   for(let n=0;n<roofCount;n++){const rw=2+Math.random()*5,rh=1.5+Math.random()*5;const unit=new THREE.Mesh(new THREE.BoxGeometry(rw,rh,rw),mat(0x536274,.55,.6));unit.position.set((Math.random()-.5)*w*.6,h+rh/2,(Math.random()-.5)*d*.6);g.add(unit)}
   if(Math.random()<.35){const sign=new THREE.Mesh(new THREE.BoxGeometry(.25,4,d*.45),new THREE.MeshBasicMaterial({color:Math.random()>.5?0x12a9d2:0xd47c52}));sign.position.set(inwardX-side*.35,h*.55,0);g.add(sign)}
   g.position.set(x,0,z);scene.add(g);city.push(g);
  }
 }
 // Streetlights and traffic.
 for(let z=-20;z>-1450;z-=72)for(const side of [-1,1]){
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.12,.2,10,6),metal);pole.position.set(side*37,5,z);scene.add(pole);
  const arm=new THREE.Mesh(new THREE.BoxGeometry(3,.15,.15),metal);arm.position.set(side*35,9.8,z);scene.add(arm);
  const bulb=new THREE.Mesh(new THREE.BoxGeometry(.9,.16,.45),new THREE.MeshBasicMaterial({color:0xffd79b}));bulb.position.set(side*33.7,9.7,z);scene.add(bulb);
 }
 for(let i=0;i<24;i++){
  const c=new THREE.Group(),body=new THREE.Mesh(new THREE.BoxGeometry(2.2,.8,4.7),mat([0x172b43,0x7b2d2c,0x9c9da4,0x17201f][i%4],.65,.3));c.add(body);
  const cabin=new THREE.Mesh(new THREE.BoxGeometry(1.65,.58,2.1),mat(0x183044,.55,.2));cabin.position.y=.55;c.add(cabin);
  for(const x of [-.72,.72])for(const z of [-2.38,2.38]){const lamp=new THREE.Mesh(new THREE.BoxGeometry(.35,.15,.06),new THREE.MeshBasicMaterial({color:z<0?0xffd08a:0xff4138}));lamp.position.set(x,.05,z);c.add(lamp)}
  c.position.set((Math.random()-.5)*25,.55,-Math.random()*1400);scene.add(c);cars.push(c);
 }
 const ground=new THREE.Mesh(new THREE.PlaneGeometry(2200,2200),mat(0x091522,.15,.95));ground.rotation.x=-Math.PI/2;ground.position.set(0,-.35,-700);scene.add(ground);
}
async function loadSuit(){
 loading('EXTRACTING MARK 85 ASSETS',10);
 try{
  const [a,b]=await Promise.all([fetch('./source.zip'),fetch('./textures.zip')]);if(!a.ok||!b.ok)throw Error('Keep source.zip and textures.zip beside index.html');
  const [za,zb]=await Promise.all([JSZip.loadAsync(await a.arrayBuffer()),JSZip.loadAsync(await b.arrayBuffer())]);
  const f=Object.values(za.files).find(x=>!x.dir&&/\.fbx$/i.test(x.name));if(!f)throw Error('FBX not found inside source.zip');
  const modelURL=URL.createObjectURL(await f.async('blob')),textureMap=new Map();
  for(const e of Object.values(zb.files)){if(e.dir||!/ \.(png|jpe?g|tga)$/i.test(e.name.replace(' ','')))continue;textureMap.set(e.name.split('/').pop().split('\\').pop(),URL.createObjectURL(await e.async('blob')))}
  loading('LOADING MARK 85 MODEL',55);
  const manager=new THREE.LoadingManager();manager.setURLModifier(url=>textureMap.get(decodeURIComponent(url.split('/').pop().split('\\').pop()))||url);
  new FBXLoader(manager).load(modelURL,obj=>{
   iron=obj;const box=new THREE.Box3().setFromObject(iron),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),max=Math.max(size.x,size.y,size.z);
   if(!max)throw Error('Invalid model dimensions');iron.position.sub(center);iron.scale.setScalar(3.5/max);iron.rotation.y=Math.PI;
   iron.traverse(o=>{if(o.isMesh){o.frustumCulled=true;o.castShadow=false;if(o.material){for(const m of (Array.isArray(o.material)?o.material:[o.material])){m.metalness=Math.max(m.metalness||0,.5);m.roughness=clamp(m.roughness||.4,.2,.72)}}}});
   scene.add(iron);iron.position.set(0,0,0);URL.revokeObjectURL(modelURL);loading('MARK 85 ONLINE',100);setTimeout(()=>$('loading').classList.add('hide'),500);
  },xhr=>{if(xhr.total)loading('LOADING MARK 85 MODEL',55+Math.round(xhr.loaded/xhr.total*40))},err=>{console.error(err);fallback();});
 }catch(e){console.error(e);fallback()}
}
function fallback(){loading('MODEL ZIP NOT FOUND — TEST SUIT ACTIVE',100);const g=new THREE.Group(),red=mat(0x9d2027,.8,.25),gold=mat(0xc69a4d,.85,.22),glow=new THREE.MeshBasicMaterial({color:0x5feaff});
 const add=(geo,m,p,s=[1,1,1])=>{const o=new THREE.Mesh(geo,m);o.position.set(...p);o.scale.set(...s);g.add(o)};
 add(new THREE.CapsuleGeometry(.36,.9,6,10),red,[0,0,0]);add(new THREE.SphereGeometry(.29,16,12),gold,[0,.78,0]);add(new THREE.BoxGeometry(.36,.35,.14),glow,[0,.12,.36]);
 for(const x of [-1,1]){add(new THREE.CapsuleGeometry(.13,.65,4,8),red,[x*.53,.15,0]);add(new THREE.CapsuleGeometry(.12,.62,4,8),red,[x*.22,-.9,0])}
 g.scale.setScalar(1.5);iron=g;scene.add(iron);setTimeout(()=>$('loading').classList.add('hide'),700);
}
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
 const chase=new THREE.Vector3(iron?iron.position.x*.65:0,flight?iron.position.y+2.8:2.2,(iron?iron.position.z:0)+(flight?(boost?14:10):9));
 camera.position.lerp(chase,Math.min(1,dt*3));
 if(iron){const target=iron.position.clone();target.y+=(flight?0.5:1);target.z-=(flight?7:2.5);camera.lookAt(target)}
 else{camera.lookAt(new THREE.Vector3(0,0,-5))}
 for(const c of cars){c.position.z+=dt*12;if(c.position.z>30)c.position.z=-1400}
 for(let i=shots.length-1;i>=0;i--){const s=shots[i];s.m.position.addScaledVector(s.v,dt*60);if(--s.life<=0){scene.remove(s.m);s.m.geometry.dispose();shots.splice(i,1)}}
 energy=clamp(energy+(boost?-dt*12:dt*4),0,100);
 $('mode').textContent=flight?'FLIGHT':'WALK';$('alt').textContent=flight?Math.round(iron?iron.position.y*20:0)+' M':'GROUND';$('spd').textContent=flight?Math.round(boost?520:220):Math.round(Math.hypot(steer.x,steer.y)*(run?18:8));
 renderer.render(scene,camera);
}
init();
