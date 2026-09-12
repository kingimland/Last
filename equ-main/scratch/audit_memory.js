const fs = require('fs');

const play = fs.readFileSync('Ah-main/game/play.html', 'utf8');
const server = fs.readFileSync('Ah-main/server.js', 'utf8');

console.log('=== 1. MEMORY LEAK CHECK: UNBOUNDED MAPS & ARRAYS ===');

// Check maps in client
const clientMapRegex = /(?:const|let|var)\s+(_?[a-zA-Z0-9]+)\s*=\s*new\s+(?:Map|Set)\(\)/g;
let m;
const clientMaps = [];
while ((m = clientMapRegex.exec(play)) !== null) {
  clientMaps.push(m[1]);
}
console.log('Client Maps/Sets found:', clientMaps);

for (const mapName of clientMaps) {
  // Check if mapName has .clear() or .delete()
  const hasDelete = play.includes(mapName + '.delete(');
  const hasClear = play.includes(mapName + '.clear(');
  const hasLimit = play.includes(mapName + '.size >') || play.includes(mapName + '.size >=') || play.includes(mapName + '.size >=');
  console.log(`  ${mapName}: delete=${hasDelete}, clear=${hasClear}, bounded=${hasLimit}`);
}

// Check server maps
console.log('\n=== SERVER MAPS/SETS ===');
const serverMapRegex = /(?:const|let|var)\s+([a-zA-Z0-9]+)\s*=\s*new\s+(?:Map|Set)\(\)/g;
const serverMaps = [];
while ((m = serverMapRegex.exec(server)) !== null) {
  serverMaps.push(m[1]);
}
console.log('Server Maps/Sets found:', serverMaps);

for (const mapName of serverMaps) {
  const hasDelete = server.includes(mapName + '.delete(');
  const hasClear = server.includes(mapName + '.clear(');
  const hasLimit = server.includes(mapName + '.size >') || server.includes(mapName + '.size >=');
  console.log(`  ${mapName}: delete=${hasDelete}, clear=${hasClear}, bounded=${hasLimit}`);
}
