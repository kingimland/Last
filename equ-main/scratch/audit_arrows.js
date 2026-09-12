const fs = require('fs');

const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');
const server = fs.readFileSync('Ah-main/server.js', 'utf8');

console.log('=== ARROW IN CLIENT ===');
play.split('\n').forEach((l, i) => {
  if (l.includes('fireBowArrow') || l.includes('arrows.push') || l.includes('arrow_hit')) {
    console.log((i+1) + ': ' + l.trim());
  }
});

console.log('\n=== ARROW IN SERVER ===');
server.split('\n').forEach((l, i) => {
  if (l.includes('arrow_hit') || l.includes('arrow')) {
    console.log((i+1) + ': ' + l.trim());
  }
});
