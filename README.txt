PROJECT STARK — MARK 85 WEB GAME

Live build:
https://pavan-pixel.github.io/stark-flight-test/

CONTROLS
- Left virtual stick: move / steer.
- Drag open screen area: orbit camera.
- Pinch: camera zoom.
- FLY: controlled vertical takeoff.
- UP / DOWN: altitude control.
- HOVER: low-speed stabilisation.
- BOOST: high-speed flight (uses energy).
- LAND: controlled descent.
- REPULSOR: fire.
- PUNCH / KICK: melee.

ASSET ARCHIVES
The ZIP archives listed in game.js AssetManager.mountZips() are runtime dependencies.
Keep those archives in the repository root unless the loader is changed and the
replacement assets have been verified. The NYC FBX world is loaded from
stark-nyc-world-optimized.zip. The Mark 85 boot image is stark-boot.webp.

MOBILE NOTES
The game is designed for landscape mobile browsers. Touch controls use Pointer
Events; the joystick and action buttons own their touch input while open canvas
space is reserved for camera drag.

DEPLOYMENT
GitHub Pages serves index.html and game.js from the repository root.
After changing game.js, bump its query-string version in index.html to avoid
stale browser cache.

KNOWN VALIDATION LIMITATION
Always test flight, touch camera, joystick, NYC load and frame rate in iPhone
Safari after publishing. Desktop syntax checks do not prove mobile runtime.
