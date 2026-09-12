const fs = require('fs');
const s = fs.readFileSync('Ah-main/server.js', 'utf8');
console.log(s.split('\n').slice(1955, 1995).join('\n'));
