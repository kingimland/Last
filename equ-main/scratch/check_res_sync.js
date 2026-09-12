const fs = require('fs');

const s = fs.readFileSync('Ah-main/server.js', 'utf8');
const p = fs.readFileSync('Ah-main/game/play.html', 'utf8');

console.log('=== RES ON SERVER ===');
s.split('\n').forEach((l, i) => {
  if (l.includes('res_hit') || l.includes('res_sync') || l.includes('res_respawn')) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n=== RES ON CLIENT ===');
p.split('\n').forEach((l, i) => {
  if (l.includes('res_hit') || l.includes('res_sync') || l.includes('res_respawn')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
