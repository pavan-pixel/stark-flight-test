PROJECT STARK — SYNTAX FIX

Replace index.html and game.js in the repository root with these two files.
Keep source.zip and textures.zip in the repository root.
Commit both replacements, wait for GitHub Pages to publish, then reload:
https://pavan-pixel.github.io/stark-flight-test/

This corrects the camera lookAt() syntax error that prevented game.js from parsing.
The loading screen also displays startup errors instead of staying silently stuck.
