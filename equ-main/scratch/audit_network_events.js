const fs = require('fs');

const serverSrc = fs.readFileSync('Ah-main/server.js', 'utf8');
const clientSrc = fs.readFileSync('Ah-main/game/play.html', 'utf8');

// Find all socket.emit, io.emit, relayToOthers on server
const serverEmits = new Set();
const serverEmitRegex = /(?:socket\.emit|io\.emit|relayToOthers\([^,]+,)\s*\(\s*['"]([^'"]+)['"]/g;
let m;
while ((m = serverEmitRegex.exec(serverSrc)) !== null) {
  serverEmits.add(m[1]);
}

// Find all socket.on on server
const serverOns = new Set();
const serverOnRegex = /socket\.on\s*\(\s*['"]([^'"]+)['"]/g;
while ((m = serverOnRegex.exec(serverSrc)) !== null) {
  serverOns.add(m[1]);
}

// Find all client emits
const clientEmits = new Set();
const clientEmitRegex = /(?:_socket|socket)\.emit\s*\(\s*['"]([^'"]+)['"]/g;
while ((m = clientEmitRegex.exec(clientSrc)) !== null) {
  clientEmits.add(m[1]);
}

// Find all client ons
const clientOns = new Set();
const clientOnRegex = /(?:_socket|socket)\.on\s*\(\s*['"]([^'"]+)['"]/g;
while ((m = clientOnRegex.exec(clientSrc)) !== null) {
  clientOns.add(m[1]);
}

console.log('=== CLIENT EMITS NOT HANDLED BY SERVER ===');
for (const e of clientEmits) {
  if (!serverOns.has(e)) {
    console.log('Client emits but server has no listener for:', e);
  }
}

console.log('\n=== SERVER EMITS NOT HANDLED BY CLIENT ===');
for (const e of serverEmits) {
  if (!clientOns.has(e)) {
    console.log('Server emits but client has no listener for:', e);
  }
}

console.log('\n=== ALL SERVER LISTENERS (' + serverOns.size + ') ===');
console.log([...serverOns].sort().join(', '));

console.log('\n=== ALL CLIENT LISTENERS (' + clientOns.size + ') ===');
console.log([...clientOns].sort().join(', '));
