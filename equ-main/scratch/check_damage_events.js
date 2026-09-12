const fs = require('fs');

const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');
const server = fs.readFileSync('Ah-main/server.js', 'utf8');

console.log('=== CLIENT DAMAGE LISTENERS ===');
play.split('\n').forEach((l, i) => {
  if (l.includes("socket.on('pvp_hit'") || l.includes("socket.on('player_take_damage'")) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n=== SERVER DAMAGE EMITTERS ===');
server.split('\n').forEach((l, i) => {
  if (l.includes("emit('pvp_hit'") || l.includes("emit('player_take_damage'")) {
    console.log((i+1) + ': ' + l.trim());
  }
});
