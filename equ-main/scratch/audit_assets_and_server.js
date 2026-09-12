const fs = require('fs');
const path = require('path');

console.log('=== CHECKING ASSETS / ASSET 404s ===');

const clientHtml = fs.readFileSync('Ah-main/game/play.html', 'utf8');
const indexHtml = fs.readFileSync('Ah-main/game/index.html', 'utf8');

// Find all image / audio asset paths referenced in play.html
const assetRegex = /(?:src|href|url)\s*[:=]\s*['"]([^'"]+\.(?:png|jpg|jpeg|webp|svg|mp3|wav|ogg|json|ico))['"]/gi;
const referencedAssets = new Set();
let m;
while ((m = assetRegex.exec(clientHtml)) !== null) {
  referencedAssets.add(m[1]);
}
while ((m = assetRegex.exec(indexHtml)) !== null) {
  referencedAssets.add(m[1]);
}

// Also check string literals like 'asset/...' or 'players/...'
const stringAssetRegex = /['"]((?:asset|players|items|audio|sfx|icons)\/[^'"]+\.[a-zA-Z0-9]+)['"]/g;
while ((m = stringAssetRegex.exec(clientHtml)) !== null) {
  referencedAssets.add(m[1]);
}

const gameDir = path.resolve('Ah-main/game');
const missingAssets = [];
const foundAssets = [];

for (const assetPath of referencedAssets) {
  // Skip external urls
  if (assetPath.startsWith('http://') || assetPath.startsWith('https://') || assetPath.startsWith('//') || assetPath.startsWith('data:')) {
    continue;
  }
  const cleanPath = assetPath.replace(/^\//, '').split('?')[0].split('#')[0];
  const fullPath = path.join(gameDir, cleanPath);
  if (!fs.existsSync(fullPath)) {
    missingAssets.push(cleanPath);
  } else {
    foundAssets.push(cleanPath);
  }
}

console.log('Total referenced local assets:', referencedAssets.size);
console.log('Found assets:', foundAssets.length);
console.log('Missing assets (404 risks):', missingAssets.length);
if (missingAssets.length > 0) {
  console.log('MISSING:', missingAssets);
}

console.log('\n=== CHECKING SERVER.JS CRITICAL PATHS ===');
const serverSrc = fs.readFileSync('Ah-main/server.js', 'utf8');

// Check for unhandled socket errors or potential NaN/null crashes
const potentialNaN = [];
const lines = serverSrc.split('\n');
lines.forEach((l, idx) => {
  if (l.includes('JSON.parse(') && !l.includes('try') && !lines[idx-1]?.includes('try')) {
    potentialNaN.push('Line ' + (idx+1) + ': unhandled JSON.parse: ' + l.trim());
  }
});
console.log('Potential unhandled JSON.parse crashes:', potentialNaN.length);
potentialNaN.forEach(p => console.log('  ' + p));
