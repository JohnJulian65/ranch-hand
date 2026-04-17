// Renders public/icon.svg to the PWA PNG icons at the sizes Android,
// Chrome, and iOS expect. Run with:  node scripts/generate-icons.js
// Requires sharp — install with `npm install --no-save sharp` first.
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const svg = fs.readFileSync(path.join(PUBLIC_DIR, 'icon.svg'));

const targets = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
];

(async () => {
  for (const { name, size } of targets) {
    await sharp(svg)
      .resize(size, size)
      .png()
      .toFile(path.join(PUBLIC_DIR, name));
    console.log(`wrote public/${name} (${size}x${size})`);
  }
})();
