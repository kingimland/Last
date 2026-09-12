const fs = require('fs');
const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');

console.log('=== socket.on("players") in play.html ===');
play.split('\n').forEach((l, i) => {
  if (l.includes("socket.on('players'") || l.includes('socket.on("players"')) {
    console.log(play.split('\n').slice(i, i + 35).join('\n'));
  }
});
