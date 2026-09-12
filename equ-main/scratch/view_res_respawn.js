const fs = require('fs');
const p = fs.readFileSync('Ah-main/game/play.html', 'utf8');
console.log(p.split('\n').slice(6335, 6365).join('\n'));
