const fs = require('fs');
const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');
console.log(play.split('\n').slice(16090, 16125).join('\n'));
