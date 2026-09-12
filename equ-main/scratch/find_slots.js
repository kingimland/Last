const fs = require('fs');
const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');

console.log('=== INVENTORY SLOTS IN HTML ===');
play.split('\n').forEach((l, i) => {
  if (l.includes('inv-slot') && l.includes('slot-')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
