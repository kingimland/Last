const fs = require('fs');

const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');
const server = fs.readFileSync('Ah-main/server.js', 'utf8');

console.log('--- Client: _mobWebCooldowns & _mobVisibilityAt & _pvpPredictTime ---');
play.split('\n').forEach((l, i) => {
  if (l.includes('_mobWebCooldowns') || l.includes('_mobVisibilityAt') || l.includes('_pvpPredictTime')) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n--- Server: trapPushCooldowns ---');
server.split('\n').forEach((l, i) => {
  if (l.includes('trapPushCooldowns')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
