PROJECT STARK — FLIGHT TEST 01
Mobile browser prototype using the user-supplied Mark 85 FBX asset.

CONTROLS
- Touch joystick: steer left/right and climb/dive.
- BOOST: increase forward flight speed.
- HOVER: hold altitude / reduce forward travel.
- FIRE: launch repulsor projectiles.
- Keyboard fallback: WASD or arrows, Space=boost, F=fire, H=hover.

RUNNING
This is a static web project using Three.js r160 and its FBXLoader from jsDelivr CDN.
It must be served over HTTP(S); opening index.html directly as file:// will not work reliably.
For GitHub Pages: upload the contents of this ZIP to the root of a repository, enable Pages from the main branch/root, and open the resulting HTTPS URL on iPhone Safari.

ASSET
source/Og.fbx is the user's uploaded Mark 85 rigged FBX. textures/ contains the supplied textures, resized to 1024px for mobile loading. Original texture filenames are retained for FBX path resolution.
The model is loaded at runtime. If FBX loading fails, a simple placeholder armor proxy is shown.

LIMITATIONS
This is Flight Test 01, not a finished game. Flight steering, boost, hover, and repulsor projectiles are implemented as a playable prototype. There are no enemies, collision/damage systems, missions, saved progression, native iOS packaging, or validated game-grade animation retargeting yet. The uploaded FBX's Mixamo rig is not converted to another skeleton.

CREDITS / RIGHTS
Model supplied by the user from the Sketchfab listing: Iron-Man Mark 85 | Rigged, by 9A Films / Nihar Arora.
Check the creator's current license and attribution requirements before redistribution. Marvel/Iron Man are third-party intellectual property; this is a private fan prototype, not an official product.
