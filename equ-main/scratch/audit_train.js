const fs = require('fs');

const s = fs.readFileSync('Ah-main/server.js', 'utf8');
const p = fs.readFileSync('Ah-main/game/play.html', 'utf8');

console.log('=== TRAIN IN SERVER ===');
s.split('\n').forEach((l, i) => {
  if (l.includes('train_') || l.includes('trainBoard') || l.includes('trainState')) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n=== TRAIN IN CLIENT ===');
p.split('\n').forEach((l, i) => {
  if (l.includes('train_') || l.includes('trainBoard') || l.includes('trainState')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
