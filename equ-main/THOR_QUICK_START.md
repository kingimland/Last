# 🚀 Thor Cosmetic - Hızlı Başlangıç Kontrol Listesi

## 📋 Adım Adım Uygulama

### ADIM 1: Asset Dosyaları (5 dakika)

```bash
# 1.1 Thor PNG'i doğru konuma kopyala
cp /workspaces/Cengi/thor_ultimate_skin_180x180.png \
   /workspaces/Cengi/Ah-main/game/players/thor.png

# 1.2 Dosya doğru olduğunu kontrol et
ls -lh /workspaces/Cengi/Ah-main/game/players/thor.png
# Beklenen: -rw-r--r-- 1 ... 180x180 (PNG)

# 1.3 Opsiyonel: Diğer cosmetic PNG'lerini oluştur
# (Balta, kılıç, efekt PNG'leri - basit placeholder'lar)
touch /workspaces/Cengi/Ah-main/game/weapons/axe_thunder.png
touch /workspaces/Cengi/Ah-main/game/weapons/sword_thunder.png
```

---

### ADIM 2: Server Kodu (15 dakika)

**Dosya:** `/workspaces/Cengi/Ah-main/server.js`

#### 2.1 Üst bölüme Schema ekle (Satır ~10)

```javascript
// Bul: const express = require('express');
// Sonra ekle:

const COSMETICS_SCHEMA = {
  deriler: 'string',
  profil_avatar: 'string',
  efektler: 'string',
  profil_cerceve: 'string',
  kanatlar: 'string',
  sapkalar: 'string',
  yuz: 'string',
  aksesuarlar: 'string',
  baltalar: 'string',
  kiliclar: 'string',
  izler: 'string'
};

const THOR_COSMETICS = {
  deriler: 'thor',
  profil_avatar: 'thor',
  efektler: 'effect_thunder',
  kanatlar: 'w_none',
  sapkalar: 'h_none',
  yuz: 'f_none',
  aksesuarlar: 'a_none',
  baltalar: 'ba_thunder',
  kiliclar: 'ki_thunder',
  izler: 'iz_thunder'
};
```

#### 2.2 compactState() fonksiyonunu güncelle

**Bul:** `function compactState(state, full = false)`

**Değiştir:**
```javascript
function compactState(state, full = false) {
  const score = (state.xp || 0) + (state.gold || 0) * 2;
  
  const res = {
    x: Math.round((state.x || 0) * 10) / 10,
    y: Math.round((state.y || 0) * 10) / 10,
    a: Math.round(state.angle * 100) / 100,
    hp: state.hp ?? 100,
    mhp: state.maxHp ?? 100,
    w: state.weapon || 1,
    atk: Boolean(state.isAttacking),
    atp: Number(state.attackTimer) || 0,
    atd: Number(state.attackDuration) || 0,
    k: state.kills || 0,
    xp: state.xp || 0,
    g: state.gold || 0,
    sc: score,
    at: state.axeTier || 0,
    st: state.swordTier || 0,
    rk: state.visualRankId ?? Math.min(11, Number(state.rankId) || 0),
    vx: Math.round(state.vx * 10) / 10,
    vy: Math.round(state.vy * 10) / 10,
    sq: state.stateSeq || 0,
    tm: state.stateAt || Date.now(),
    trappedBy: state.trappedBy || null,
  };
  
  if (full) {
    res.n = state.name || 'Oyuncu';
    res.sk = state.skin || 'default';
    res.color = state.color || '#8B5E3A';
    res.team = state.team || '';
    res.clanId = state.clanId || '';
    res.clanTag = state.clanTag || '';
    
    // ← COSMETICS EKLE
    res.acc = state.acc || {
      baltalar: 'ba_none',
      kiliclar: 'ki_none',
      kanatlar: 'w_none',
      sapkalar: 'h_none',
      yuz: 'f_none',
      aksesuarlar: 'a_none',
      izler: 'iz_none'
    };
    
    res.profileCosmetics = state.profileCosmetics || {
      avatarId: 'default',
      effectId: 'effect_none',
      frameId: 'frame_woodland'
    };
  }
  
  return res;
}
```

#### 2.3 socket.on('join') Güncelle

**Bul:** `socket.on('join', (data, callback) => {`

**Ekle (player state oluştururken):**
```javascript
// Cosmetics yükleme
const equippedItems = authUser.equippedItems || {};
const playerSkin = equippedItems.deriler || data.skin || 'default';

const playerAcc = {
  baltalar: equippedItems.baltalar || 'ba_none',
  kiliclar: equippedItems.kiliclar || 'ki_none',
  kanatlar: equippedItems.kanatlar || 'w_none',
  sapkalar: equippedItems.sapkalar || 'h_none',
  yuz: equippedItems.yuz || 'f_none',
  aksesuarlar: equippedItems.aksesuarlar || 'a_none',
  izler: equippedItems.izler || 'iz_none'
};

const profileCosmetics = {
  avatarId: equippedItems.profil_avatar || 'default',
  effectId: equippedItems.efektler || 'effect_none',
  frameId: equippedItems.profil_cerceve || 'frame_woodland'
};

// State'e ekle
const state = {
  // ... diğer alanlar ...
  skin: playerSkin,
  acc: playerAcc,
  profileCosmetics: profileCosmetics
};
```

#### 2.4 Attack Event - Thor Yıldırım

**Bul:** `socket.on('attack', (data) => {`

**Ekle:**
```javascript
// Thor spesifik yıldırım efekti
const player = players.get(socket.id);
if (player.skin === 'thor') {
  const target = players.get(data.targetId);
  if (target) {
    io.emit('thor_lightning', {
      attackerId: socket.id,
      targetId: data.targetId,
      fromX: player.x,
      fromY: player.y,
      toX: target.x,
      toY: target.y,
      timestamp: Date.now()
    });
  }
}
```

---

### ADIM 3: Client Kodu (20 dakika)

**Dosya:** `/workspaces/Cengi/Ah-main/game/play.html`

#### 3.1 Script bölümünün sonuna Lightning Classes ekle

**Bul:** `</script>` etiketi (dosya sonunda)

**Öncesine ekle:**

```javascript
// ============================================
// THOR LIGHTNING EFFECT SYSTEM
// ============================================

const MAX_THORNS = 25;
const MAX_SPARKS = 200;

let thorLightnings = [];
let thorSparks = [];
let thorScorches = [];

class ThorLightning {
  constructor(startX, startY, endX, endY, branchLevel = 0) {
    this.startX = startX;
    this.startY = startY;
    this.targetX = endX;
    this.targetY = endY;
    this.branchLevel = branchLevel;
    this.segments = this._createPath();
    this.alpha = 1.0;
    this.decay = branchLevel === 0 ? 0.015 : 0.03;
    
    if (branchLevel === 0) {
      this._createBranches();
    }
  }

  _createPath() {
    let segments = [];
    let cx = this.startX;
    let cy = this.startY;
    let tv = { x: this.targetX - cx, y: this.targetY - cy };
    let dist = Math.sqrt(tv.x ** 2 + tv.y ** 2);
    let steps = Math.max(5, Math.floor(dist / 15));
    segments.push({ x: cx, y: cy });

    for (let i = 1; i <= steps; i++) {
      let prog = i / steps;
      let ix = this.startX + tv.x * prog;
      let iy = this.startY + tv.y * prog;
      let var_ = i === steps ? 0 : 25;
      let nx = ix + (Math.random() - 0.5) * var_;
      let ny = iy + (Math.random() - 0.5) * var_;
      segments.push({ x: nx, y: ny });
    }
    return segments;
  }

  _createBranches() {
    let nBranches = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < nBranches; i++) {
      if (thorLightnings.length >= MAX_THORNS) break;
      let sIdx = Math.floor(this.segments.length * (0.3 + Math.random() * 0.4));
      if (!this.segments[sIdx]) continue;
      
      let sx = this.segments[sIdx].x;
      let sy = this.segments[sIdx].y;
      let angle = Math.random() * Math.PI * 2;
      let len = 40 + Math.random() * 50;
      let ex = sx + Math.cos(angle) * len;
      let ey = sy + Math.sin(angle) * len;
      
      thorLightnings.push(new ThorLightning(sx, sy, ex, ey, this.branchLevel + 1));
    }
  }

  update() {
    this.alpha -= this.decay;
    return this.alpha > 0;
  }

  draw(ctx) {
    if (this.alpha <= 0) return;

    // Dış glow
    ctx.beginPath();
    ctx.moveTo(this.segments[0].x, this.segments[0].y);
    for (let i = 1; i < this.segments.length; i++) {
      ctx.lineTo(this.segments[i].x, this.segments[i].y);
    }
    ctx.strokeStyle = `rgba(0, 195, 255, ${this.alpha * 0.8})`;
    ctx.lineWidth = this.branchLevel === 0 ? 8 : 4;
    ctx.shadowBlur = 20;
    ctx.shadowColor = "#00c3ff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // İç çekirdek
    ctx.beginPath();
    ctx.moveTo(this.segments[0].x, this.segments[0].y);
    for (let i = 1; i < this.segments.length; i++) {
      ctx.lineTo(this.segments[i].x, this.segments[i].y);
    }
    ctx.strokeStyle = `rgba(255, 255, 255, ${this.alpha})`;
    ctx.lineWidth = this.branchLevel === 0 ? 3 : 1.5;
    ctx.shadowBlur = 0;
    ctx.stroke();
  }
}

class ThorSpark {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    let ang = Math.random() * Math.PI * 2;
    let spd = 2 + Math.random() * 5;
    this.vx = Math.cos(ang) * spd;
    this.vy = Math.sin(ang) * spd;
    this.life = 1.0;
    this.decay = 0.03 + Math.random() * 0.05;
    this.size = 2 + Math.random() * 2;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.life -= this.decay;
    return this.life > 0;
  }

  draw(ctx) {
    ctx.fillStyle = `rgba(150, 220, 255, ${this.life})`;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#00c3ff";
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

class ThorScorch {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.size = 15 + Math.random() * 15;
    this.life = 1.0;
  }

  update() {
    this.life -= 0.005;
    return this.life > 0;
  }

  draw(ctx) {
    ctx.fillStyle = `rgba(0, 0, 0, ${this.life * 0.6})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function spawnThorLightning(targetX, targetY, sourcePlayer) {
  if (thorLightnings.length >= MAX_THORNS) return;

  const angleToTarget = Math.atan2(
    targetY - sourcePlayer.y,
    targetX - sourcePlayer.x
  );
  
  const startX = sourcePlayer.x + Math.cos(angleToTarget) * sourcePlayer.radius;
  const startY = sourcePlayer.y + Math.sin(angleToTarget) * sourcePlayer.radius;

  thorLightnings.push(new ThorLightning(startX, startY, targetX, targetY, 0));

  if (thorScorches.length < 15) {
    thorScorches.push(new ThorScorch(targetX, targetY));
  }

  let numSparks = 5 + Math.floor(Math.random() * 5);
  for (let i = 0; i < numSparks; i++) {
    if (thorSparks.length >= MAX_SPARKS) break;
    thorSparks.push(new ThorSpark(targetX, targetY));
  }
}

function drawThorEffects(ctx, globalTime, myPlayer) {
  // Yanık izleri
  for (let i = thorScorches.length - 1; i >= 0; i--) {
    if (!thorScorches[i].update()) {
      thorScorches.splice(i, 1);
    } else {
      thorScorches[i].draw(ctx);
    }
  }

  // Şimşekler
  for (let i = thorLightnings.length - 1; i >= 0; i--) {
    if (!thorLightnings[i].update()) {
      thorLightnings.splice(i, 1);
    } else {
      thorLightnings[i].draw(ctx);
    }
  }

  // Kıvılcımlar
  for (let i = thorSparks.length - 1; i >= 0; i--) {
    if (!thorSparks[i].update()) {
      thorSparks.splice(i, 1);
    } else {
      thorSparks[i].draw(ctx);
    }
  }

  // Otomatik fırtına
  if (_playerSkin === 'thor' && Math.random() < 0.04) {
    let rDist = 90 + Math.random() * 210;
    let rAngle = Math.random() * Math.PI * 2;
    let tx = myPlayer.x + Math.cos(rAngle) * rDist;
    let ty = myPlayer.y + Math.sin(rAngle) * rDist;
    spawnThorLightning(tx, ty, myPlayer);
  }
}

// Socket event'i: Thor yıldırım saldırısı
_socket.on('thor_lightning', ({ attackerId, x, y }) => {
  const attacker = _otherPlayers.get(attackerId);
  if (attacker && attacker.skin === 'thor') {
    spawnThorLightning(x, y, attacker);
  }
});
```

#### 3.2 Main Game Loop'ta render fonksiyonunu çağır

**Bul:** `function animate()` veya `function gameLoop()`

**İçinde, sunucu state'ini render ettikten sonra ekle:**

```javascript
// Thor efektleri render et
drawThorEffects(ctx, globalTime, _myPlayer);
```

#### 3.3 Socket.io welcome handler'ında cosmetics al

**Bul:** `_socket.on('welcome', ...)`

**Cosmetics alanını ekle:**
```javascript
// Oyuncu verilerinden cosmetics yükle
if (data.players) {
  Object.entries(data.players).forEach(([playerId, state]) => {
    const player = {
      // ... diğer alanlar ...
      skin: state.sk || 'default',
      acc: state.acc || {},
      profileCosmetics: state.profileCosmetics || {}
    };
    _otherPlayers.set(playerId, player);
  });
}
```

---

### ADIM 4: Test (10 dakika)

```javascript
// Browser console'da test et
// 1. Local ortamda başlat
cd /workspaces/Cengi/Ah-main
npm start

// 2. http://localhost:3000 aç
// 3. Browser console açıp şu komutları çalıştır:

// Thor efektlerini test et
_playerSkin = 'thor';
spawnThorLightning(500, 500, _myPlayer);

// Otomatik efektler açık mı?
console.log('Thor Lightnings:', thorLightnings.length);
console.log('Thor Sparks:', thorSparks.length);
console.log('Thor Scorches:', thorScorches.length);

// Cosmetics yüklü mü?
console.log('Player Accessories:', _myPlayer.acc);
```

---

### ADIM 5: Database Migration (5 dakika)

```sql
-- SQLite komut satırında
-- sqlite3 /path/to/database.db

ALTER TABLE users ADD COLUMN equippedItems_new TEXT;

UPDATE users 
SET equippedItems_new = json_object(
  'deriler', 'default',
  'kanatlar', 'w_none',
  'sapkalar', 'h_none',
  'yuz', 'f_none',
  'aksesuarlar', 'a_none',
  'baltalar', 'ba_none',
  'kiliclar', 'ki_none',
  'izler', 'iz_none',
  'profil_avatar', 'default',
  'efektler', 'effect_none',
  'profil_cerceve', 'frame_woodland'
) 
WHERE equippedItems_new IS NULL;

ALTER TABLE users DROP COLUMN equippedItems;
ALTER TABLE users RENAME COLUMN equippedItems_new TO equippedItems;
```

---

## ✅ KONTROL LİSTESİ

### Pre-Implementation
- [ ] thor_ultimate_skin_180x180.png dosyası var mı?
- [ ] Backup: git commit attınız mı?
- [ ] Database backup aldınız mı?

### Implementation
- [ ] Asset PNG kopyalandı
- [ ] Server.js COSMETICS_SCHEMA eklendi
- [ ] Server.js compactState() güncellendi
- [ ] Server.js join handler güncellendi
- [ ] Server.js attack handler güncellendi
- [ ] play.html Lightning classes eklendi
- [ ] play.html drawThorEffects() çağrıldı
- [ ] play.html socket events güncellendi

### Testing
- [ ] Local ortamda başlıyor
- [ ] Thor skin console'da yüklü
- [ ] Efektler render ediliyor
- [ ] FPS 60+ kaldı
- [ ] Tüm oyunculara görünüyor

### Deployment
- [ ] Staging ortamda test
- [ ] Production deploy
- [ ] Database migration çalıştırıldı
- [ ] Monitoring aktif

---

## 🐛 Hızlı Debugging

```javascript
// Sorun: Efektler görünmüyor
console.log('thorLightnings.length:', thorLightnings.length);
console.log('_playerSkin:', _playerSkin);

// Sorun: PNG yüklenmedi
console.log('playerSpriteMap:', _PLAYER_SPRITES.get('players/thor.png'));

// Sorun: Server cosmetics görmüyor
// Server logs'ta ara:
grep "thorLightning" server.log

// Sorun: FPS düşüyor
// Limit kontrol et:
if (thorLightnings.length >= MAX_THORNS) return; // MAX_THORNS = 25
```

---

## 📚 Referans Dosyalar

Detaylı rehberler:
- `THOR_COSMETIC_INTEGRATION.md` - Sistem özeti
- `THOR_LIGHTNING_SOURCE_CODE.md` - Kaynak kod kopya-yapıştır
- `THOR_SERVER_INTEGRATION.md` - Sunucu mimarisi

