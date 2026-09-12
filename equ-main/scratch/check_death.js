const fs = require('fs');
const s = fs.readFileSync('Ah-main/server.js', 'utf8');

s.split('\n').forEach((l, i) => {
  if (l.includes('function onPlayerDeath')) {
    console.log(s.split('\n').slice(i, i + 25).join('\n'));
  }
});
