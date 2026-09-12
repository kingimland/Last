const fs = require('fs');

const indexHtml = fs.readFileSync('Ah-main/game/index.html', 'utf8');
console.log('index.html contains party_:', indexHtml.includes('party_'));
