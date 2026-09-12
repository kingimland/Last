const fs = require('fs');

const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');
const server = fs.readFileSync('Ah-main/server.js', 'utf8');

console.log('=== PARTY ON SERVER ===');
server.split('\n').forEach((l, i) => {
  if (l.includes('party_')) console.log((i+1) + ': ' + l.trim());
});

console.log('\n=== PARTY ON CLIENT ===');
play.split('\n').forEach((l, i) => {
  if (l.includes('party_')) console.log((i+1) + ': ' + l.trim());
});
