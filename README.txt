PROJECT STARK — SEPARATE SCRIPT PACKAGE

Upload BOTH files to the repository root:
- index.html
- game.js

Replace the existing index.html and add/replace game.js.
Keep source.zip and textures.zip in the repository root too.

Why this structure:
- index.html contains page layout, UI, CSS, and the import map.
- game.js contains the Three.js game logic and module imports.
- Browser errors can be isolated more easily.
- Do not rename game.js or move it into a subfolder unless the script path in index.html is changed.

After commit, wait for GitHub Pages to publish and reload the game.
