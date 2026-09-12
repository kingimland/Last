const fs = require('fs');

const server = fs.readFileSync('Ah-main/server.js', 'utf8');
const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');

console.log('=== CLIENT STATE EMISSION ===');
play.split('\n').forEach((l, i) => {
  if (l.includes(".emit('state'") || l.includes('emitState') || (l.includes("emit('state") && i > 15000)) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n=== SERVER STATE BROADCAST INTERVALS ===');
server.split('\n').forEach((l, i) => {
  if (l.includes('setInterval') && (l.includes('players') || l.includes('emit') || l.includes('broadcast'))) {
    console.log((i+1) + ': ' + l.trim());
  }
});
