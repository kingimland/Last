const fs = require('fs');

const s = fs.readFileSync('Ah-main/server.js', 'utf8');
s.split('\n').forEach((l, i) => {
  if (l.includes("'players'") || l.includes('"players"') || l.includes('broadcastPlayer')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
