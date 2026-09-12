const fs = require('fs');

const s = fs.readFileSync('Ah-main/server.js', 'utf8');
s.split('\n').forEach((l, i) => {
  if (l.includes('res_respawn') || l.includes('resources') || l.includes('respawnResource')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
