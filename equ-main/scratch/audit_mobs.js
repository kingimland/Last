const fs = require('fs');

const s = fs.readFileSync('Ah-main/server.js', 'utf8');
const p = fs.readFileSync('Ah-main/game/play.html', 'utf8');

console.log('=== MOB EVENTS IN SERVER ===');
s.split('\n').forEach((l, i) => {
  if (l.includes('mob_') && (l.includes('emit') || l.includes('socket.on'))) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n=== MOB EVENTS IN CLIENT ===');
p.split('\n').forEach((l, i) => {
  if (l.includes('mob_') && (l.includes('emit') || l.includes('socket.on'))) {
    console.log((i+1) + ': ' + l.trim());
  }
});
