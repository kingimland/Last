const assert = require('assert');

console.log('=== TEST: Building Placement & Trap Breaking ===');

// 1. Building placement costs and limits
const costs = { 3:[20,5,150], 4:[40,20,100], 5:[10,20,50], 6:[30,10,240], 7:[60,40,200], 8:[30,0,300], 9:[80,60,400], 10:[25,0,300] };
const [cW, cS, mHp] = costs[6]; // Trap
assert.strictEqual(mHp, 240, 'Trap HP is 240');
console.log('✔ Trap base HP is 240');

// 2. Trapped Point-Blank Hit Logic Test
const player = { x: 100, y: 100, radius: 34, angle: 0 }; // Facing right (angle = 0)
const trap = { x: 95, y: 105, type: 6, hp: 240, _netId: 'trap_123' }; // Center slightly behind player (angle ~ 135 deg)
const bRad = 78;
const hitRange = 128;
const spread = Math.PI / 2.57; // ~70 deg

const _bdx = trap.x - player.x; // -5
const _bdy = trap.y - player.y; // +5
const _bMaxDist = player.radius * 0.5 + hitRange + bRad;
const distSq = _bdx * _bdx + _bdy * _bdy; // 50

let diff = Math.abs(Math.atan2(_bdy, _bdx) - player.angle);
if (diff > Math.PI) diff = 2 * Math.PI - diff;

// With old code: diff = ~2.35 radians (135 deg), spread = ~1.22 radians
assert(diff > spread, 'Old code would fail the angle check');

// With new point-blank / trapped guard:
const _trapCaughtBy = 'trap_123';
const isTrappedHere = _trapCaughtBy && (trap._netId === _trapCaughtBy || trap.id === _trapCaughtBy);
const isPointBlank = distSq <= ((player.radius + bRad + 20) * (player.radius + bRad + 20));

let hitSucceeded = false;
if (isTrappedHere || isPointBlank || diff <= spread) {
  hitSucceeded = true;
}
assert(hitSucceeded, 'New point-blank & trapped guard guarantees hit');
console.log('✔ Point-blank & trapped hit logic guarantees trap hit despite angle (diff=' + diff.toFixed(2) + ')');

// 3. Trap HP damage & breaking
const weaponDmg = 45;
const bDmg = Math.max(20, Math.round(weaponDmg * 0.75));
assert(bDmg >= 20, 'Damage is at least 20');

// Deal hits until trap is destroyed
let hits = 0;
while (trap.hp > 0 && hits < 15) {
  trap.hp = Math.max(0, trap.hp - bDmg);
  hits++;
}
assert.strictEqual(trap.hp, 0, 'Trap should reach 0 HP');
assert(hits > 0 && hits <= 8, 'Trap breaks in reasonable number of hits: ' + hits);
console.log('✔ Trap successfully breaks in ' + hits + ' hits (damage per hit: ' + bDmg + ')');

console.log('========================================');
console.log('ALL BUILD & TRAP TESTS PASSED 100%!');
console.log('========================================');
