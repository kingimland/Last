const fs = require('fs');
const s = fs.readFileSync('Ah-main/server.js', 'utf8');

s.split('\n').forEach((l, i) => {
  if (l.includes("socket.on('disconnect'") || (l.includes('disconnect') && i > 2700)) {
    console.log(s.split('\n').slice(i, i + 40).join('\n'));
  }
});
