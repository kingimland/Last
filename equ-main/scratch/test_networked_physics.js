const assert = require('assert');
const NP = require('../Ah-main/game/networkPhysics.js');

console.log('=== TEST 1: Penetration Resolution (Zero Clipping & Mass Weighting) ===');

// 1A. Player vs Static Wall (Circle vs Circle, wA = 1, wB = 0)
{
  const player = { x: 50, y: 0 };
  const wall = { x: 0, y: 0 };
  const pRad = 34, wRad = 44;
  const col = NP.resolveCircleCircle(player, pRad, 1.0, wall, wRad, 0.0);
  assert(col && col.collided, 'Should collide');
  assert.strictEqual(col.depth, (pRad + wRad) - 50); // 78 - 50 = 28
  assert.strictEqual(player.x, 78, 'Player should be pushed out by 100% of depth');
  assert.strictEqual(wall.x, 0, 'Static wall should not move');
  const dist = Math.hypot(player.x - wall.x, player.y - wall.y);
  assert.strictEqual(dist, pRad + wRad, 'Zero penetration achieved');
  console.log('✔ 1A: Player vs Static Wall passed (Zero penetration: dist = ' + dist + ')');
}

// 1B. Dynamic Player vs Dynamic Player (Circle vs Circle, wA = 1, wB = 1)
{
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 50, y: 0 };
  const pRad = 34; // minDist = 68
  const col = NP.resolveCircleCircle(p1, pRad, 1.0, p2, pRad, 1.0);
  assert(col && col.collided, 'Should collide');
  assert.strictEqual(col.depth, 18);
  assert.strictEqual(p1.x, -9, 'P1 should be pushed back by 50% (9px)');
  assert.strictEqual(p2.x, 59, 'P2 should be pushed forward by 50% (9px)');
  const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  assert.strictEqual(dist, 68, 'Symmetric separation preserves exact distance');
  console.log('✔ 1B: Player vs Player passed (Symmetrical separation: dist = ' + dist + ')');
}

// 1C. Player vs Static Box Building (Circle vs Box AABB)
{
  const player = { x: 80, y: 0 };
  const building = { x: 0, y: 0, width: 100, height: 100, isStatic: true }; // half-width = 50
  const pRad = 34; // right edge = 50, minimum player.x = 84
  const col = NP.resolveCircleBox(player, pRad, 1.0, building);
  assert(col && col.collided, 'Should collide');
  assert.strictEqual(player.x, 84, 'Player pushed exactly to right edge + radius');
  assert.strictEqual(building.x, 0, 'Building did not move');
  console.log('✔ 1C: Player vs Static Box passed (Player pushed to ' + player.x + ')');
}

console.log('\n=== TEST 2: Velocity Projection & Smooth Sliding ===');

// 2A. Player walking directly into obstacle: normal component canceled
{
  const vel = { vx: 0, vy: -15 }; // moving straight up
  const normal = { nx: 0, ny: 1 }; // ceiling pointing down
  const slid = NP.projectVelocitySlide(vel, normal.nx, normal.ny, 0.0);
  assert(slid, 'Should project velocity');
  assert.strictEqual(vel.vx, 0);
  assert.strictEqual(vel.vy, 0, 'Direct normal velocity stopped');
  console.log('✔ 2A: Direct collision velocity halted without stutter');
}

// 2B. Player walking at 45-degree angle into vertical wall: slides vertically like butter
{
  const vel = { vx: 10, vy: 10 }; // moving down-right
  const normal = { nx: -1, ny: 0 }; // vertical wall facing left
  const slid = NP.projectVelocitySlide(vel, normal.nx, normal.ny, 0.0);
  assert(slid, 'Should project velocity');
  assert.strictEqual(vel.vx, 0, 'Wall-facing velocity eliminated');
  assert.strictEqual(vel.vy, 10, 'Tangent sliding velocity 100% preserved');
  console.log('✔ 2B: Diagonal movement against vertical wall slides smoothly at vy = ' + vel.vy);
}

// 2C. Player sliding along diagonal slope with friction
{
  const vel = { vx: 10, vy: 0 };
  const invSqrt2 = 1 / Math.sqrt(2);
  const slid = NP.projectVelocitySlide(vel, -invSqrt2, invSqrt2, 0.1);
  assert(slid);
  assert(vel.vx > 0 && vel.vy > 0, 'Velocity deflected along surface tangent');
  console.log('✔ 2C: Slope sliding with friction passed: vx = ' + vel.vx.toFixed(2) + ', vy = ' + vel.vy.toFixed(2));
}

console.log('\n=== TEST 3: Smooth Server Reconciliation ===');

// 3A. Mode A: Error Offset Exponential Decay (Zero Visual Snap)
{
  const reconciler = new NP.SmoothReconciler({ mode: 'error_decay', decayRate: 20.0 });
  const sim = { x: 200, y: 150 };
  
  // Server sends correction: authoritative pos is (180, 150)
  reconciler.onServerPacket(sim, 180, 150);
  
  // At the moment of packet arrival:
  assert.strictEqual(sim.x, 180, 'Simulation coordinate updated to server ground truth');
  const renderPosAtArrival = reconciler.getRenderPos(sim);
  assert.strictEqual(renderPosAtArrival.x, 200, 'RENDER POSITION MUST NOT JUMP (0 PIXEL SNAP)');
  assert.strictEqual(renderPosAtArrival.y, 150);
  
  // Subsequent frames: smooth exponential decay
  for (let f = 1; f <= 5; f++) {
    reconciler.update(sim, 0.0166); // 60fps frame
    const rPos = reconciler.getRenderPos(sim);
    assert(rPos.x < 200 && rPos.x >= 180, 'Render pos glides smoothly towards 180');
  }
  
  // After 200ms (~12 frames): error decays to near zero
  for (let f = 0; f < 10; f++) reconciler.update(sim, 0.0166);
  const finalRPos = reconciler.getRenderPos(sim);
  assert(Math.abs(finalRPos.x - 180) < 0.2, 'Error fully decayed to server position');
  console.log('✔ 3A: Mode A (Zero Snap & Exponential Decay) fully verified');
}

// 3B. Mode B: Target Lerp Mode (15% per frame)
{
  const reconciler = new NP.SmoothReconciler({ mode: 'target_lerp', lerpFactor: 0.15 });
  const sim = { x: 100, y: 100 };
  reconciler.onServerPacket(sim, 200, 100);
  
  assert.strictEqual(sim.x, 100, 'Position does not jump immediately in lerp mode');
  reconciler.update(sim, 0.0166);
  assert(sim.x > 100 && sim.x < 130, 'Sim moves ~15% towards target: ' + sim.x);
  console.log('✔ 3B: Mode B (Target Lerp 10-20%) verified: step 1 pos = ' + sim.x.toFixed(2));
}

console.log('\n========================================');
console.log('ALL NETWORKED PHYSICS TESTS PASSED 100%!');
console.log('========================================');
