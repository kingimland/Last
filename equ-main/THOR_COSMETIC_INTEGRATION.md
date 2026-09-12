# 🌩️ Thor Cosmetic Entegrasyonu - Detaylı Rehber

## 📊 Sistem Özeti

**Thor Derisi:**
- **PNG Asset:** `thor_ultimate_skin_180x180.png`
- **Animasyon:** Dinamik şimşek efektleri (Lightning class)
- **İçerik:** Çekirdek, dallar, kıvılcımlar, yanık izleri
- **Performans:** Max 25 lightning + 200 sparks (FPS güvenli)

---

## 1️⃣ DOSYA YAPISI

### Adım 1: PNG Dosyasını Kopyala

```bash
# Thor skin PNG'i players dizinine ekle
cp /workspaces/Cengi/thor_ultimate_skin_180x180.png \
   /workspaces/Cengi/Ah-main/game/players/thor.png

# Boyutu kontrol et (180x180px olmalı)
identify /workspaces/Cengi/Ah-main/game/players/thor.png
```

---

## 2️⃣ COSMETICS VERİTABANI YAPISI

### Server tarafı (`server.js` - `equippedItems`):

```javascript
user.equippedItems = {
  deriler: "thor",                    // ← ANA CİLT
  profil_avatar: "thor",              // Leaderboard avatarı
  efektler: "effect_thunder",         // ← YILDIRIM EFEKTI
  kanatlar: "w_none",                 // Kanat yok
  sapkalar: "h_none",                 // Şapka yok
  yuz: "f_none",                      // Yüz aksesuarı yok
  aksesuarlar: "a_none",              // Aksesuar yok
  baltalar: "ba_thunder",             // ← YILDIRIM BALTASI
  kiliclar: "ki_thunder",             // ← YILDIRIM KILIÇI
  izler: "iz_thunder"                 // ← YILDIRIM İZİ
}
```

---

## 3️⃣ CLIENT-SIDE LIGHTNING ANIMATION SISTEMI

### Temel Lightning Class (play.html'e eklenecek)

```javascript
// ============================================
// THOR LIGHTNING EFFECT SYSTEM
// ============================================

class ThorLightning {
  constructor(startX, startY, endX, endY, branchLevel = 0) {
    this.startX = startX;
    this.startY = startY;
    this.targetX = endX;
    this.targetY = endY;
    this.branchLevel = branchLevel;
    
    // Şimşek yolu oluştur (zikzak)
    this.segments = this._createPath();
    
    // Fade animasyonu
    this.alpha = 1.0;
    this.decay = branchLevel === 0 ? 0.015 : 0.03;
    
    // Dallanma (yalnızca ana şimşekler)
    if (branchLevel === 0) {
      this._createBranches();
    }
  }

  _createPath() {
    let segments = [];
    let cx = this.startX;
    let cy = this.startY;
    let targetVector = { 
      x: this.targetX - cx, 
      y: this.targetY - cy 
    };
    let distance = Math.sqrt(
      targetVector.x ** 2 + targetVector.y ** 2
    );
    
    // Mesafeye göre segment sayısı
    let numSteps = Math.max(5, Math.floor(distance / 15));
    segments.push({ x: cx, y: cy });

    for (let i = 1; i <= numSteps; i++) {
      let progress = i / numSteps;
      let idealX = this.startX + targetVector.x * progress;
      let idealY = this.startY + targetVector.y * progress;
      
      // Rastgele sapma (zikzak efekti)
      let variance = 25;
      if (i === numSteps) variance = 0; // Son nokta tam hedef
      
      let nx = idealX + (Math.random() - 0.5) * variance;
      let ny = idealY + (Math.random() - 0.5) * variance;
      
      segments.push({ x: nx, y: ny });
    }
    return segments;
  }

  _createBranches() {
    // 1-2 rastgele dal
    let numBranches = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < numBranches; i++) {
      if (thorLightningList.length >= 25) break; // MAX_LIGHTNINGS
      
      // Segmentlerin %30-%70'inden dal çıkar
      let splitIndex = Math.floor(
        this.segments.length * (0.3 + Math.random() * 0.4)
      );
      if (!this.segments[splitIndex]) continue;

      let spX = this.segments[splitIndex].x;
      let spY = this.segments[splitIndex].y;
      
      // Rastgele yöne ve uzunluğa dal
      let angle = Math.random() * Math.PI * 2;
      let len = 40 + Math.random() * 50;
      let ex = spX + Math.cos(angle) * len;
      let ey = spY + Math.sin(angle) * len;
      
      thorLightningList.push(
        new ThorLightning(spX, spY, ex, ey, this.branchLevel + 1)
      );
    }
  }

  update() {
    this.alpha -= this.decay;
    return this.alpha > 0;
  }

  draw(ctx) {
    if (this.alpha <= 0) return;

    // Dış parlama (mavi glow)
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

    // İç çekirdek (beyaz)
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
    let angle = Math.random() * Math.PI * 2;
    let speed = 2 + Math.random() * 5;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
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

class ThorScorchMark {
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

// ============================================
// GLOBAL LISTELERI
// ============================================
let thorLightningList = [];
let thorSparkList = [];
let thorScorchMarkList = [];

// ============================================
// YILDIRIM ÇAKTIRMA FONKSİYONU
// ============================================
function spawnThorLightning(targetX, targetY, sourcePlayer) {
  if (thorLightningList.length >= 25) return;

  const char = sourcePlayer;
  
  // Karakterin merkezinden hedefe açısını bul
  let angleToTarget = Math.atan2(
    targetY - char.y, 
    targetX - char.x
  );
  
  // Karakterin yarıçapından başlat (kenarından çıksın)
  let startX = char.x + Math.cos(angleToTarget) * char.radius;
  let startY = char.y + Math.sin(angleToTarget) * char.radius;

  // Ana şimşek
  thorLightningList.push(
    new ThorLightning(startX, startY, targetX, targetY, 0)
  );

  // Hedefte yanık izi
  if (thorScorchMarkList.length < 15) {
    thorScorchMarkList.push(new ThorScorchMark(targetX, targetY));
  }

  // Hedefte kıvılcımlar
  let numSparks = 5 + Math.floor(Math.random() * 5);
  for (let i = 0; i < numSparks; i++) {
    if (thorSparkList.length >= 200) break;
    thorSparkList.push(new ThorSpark(targetX, targetY));
  }
}

// ============================================
// RENDER LÖPÜSÜne eklenecek (game loop)
// ============================================
function drawThorEffects(ctx, globalTime) {
  // Yanık izleri
  for (let i = thorScorchMarkList.length - 1; i >= 0; i--) {
    if (!thorScorchMarkList[i].update()) {
      thorScorchMarkList.splice(i, 1);
    } else {
      thorScorchMarkList[i].draw(ctx);
    }
  }

  // Şimşekler
  for (let i = thorLightningList.length - 1; i >= 0; i--) {
    if (!thorLightningList[i].update()) {
      thorLightningList.splice(i, 1);
    } else {
      thorLightningList[i].draw(ctx);
    }
  }

  // Kıvılcımlar
  for (let i = thorSparkList.length - 1; i >= 0; i--) {
    if (!thorSparkList[i].update()) {
      thorSparkList.splice(i, 1);
    } else {
      thorSparkList[i].draw(ctx);
    }
  }

  // Otomatik şimşek fırtınası (Thor eğer aktifse)
  if (_playerSkin === 'thor' && Math.random() < 0.04) {
    let rDist = 90 + Math.random() * 210;
    let rAngle = Math.random() * Math.PI * 2;
    let tx = _myPlayer.x + Math.cos(rAngle) * rDist;
    let ty = _myPlayer.y + Math.sin(rAngle) * rDist;
    spawnThorLightning(tx, ty, _myPlayer);
  }
}
```

---

## 4️⃣ SERVER-SIDE COSMETICS SYNC

### Network Paket İntegrasyonu (`server.js`)

```javascript
// compactState() fonksiyonuna ekle
function compactState(state, full = false) {
  const res = {
    x: Math.round((state.x || 0) * 10) / 10,
    y: Math.round((state.y || 0) * 10) / 10,
    a: Math.round(state.angle * 100) / 100,
    hp: state.hp ?? 100,
    mhp: state.maxHp ?? 100,
    w: state.weapon || 1,
    sk: state.skin || 'default',
    // ... diğer alanlar ...
  };
  
  if (full) {
    res.n = state.name || 'Oyuncu';
    res.acc = state.acc || {};
    res.profileCosmetics = state.profileCosmetics || null;
  }
  
  return res;
}

// Player join handler'da
socket.on('join', (data, callback) => {
  const authUser = sessions.get(data.token);
  
  const state = {
    name: data.name || 'Oyuncu',
    skin: authUser?.equippedItems?.deriler || data.skin || 'default',
    
    // ← THOR COSMETICS
    acc: {
      baltalar: authUser?.equippedItems?.baltalar || 'ba_none',
      kiliclar: authUser?.equippedItems?.kiliclar || 'ki_none',
      kanatlar: authUser?.equippedItems?.kanatlar || 'w_none',
      izler: authUser?.equippedItems?.izler || 'iz_none'
    },
    
    profileCosmetics: authUser?.equippedItems ? {
      avatarId: authUser.equippedItems.profil_avatar || 'default',
      effectId: authUser.equippedItems.efektler || 'effect_none',
      frameId: authUser.equippedItems.profil_cerceve || 'frame_woodland'
    } : null,
    
    x: data.x || 0,
    y: data.y || 0,
    // ... diğer player state ...
  };
  
  // Diğer oyunculara ilan et
  socket.broadcast.emit('player_join', {
    id: socket.id,
    state: compactState(state, true)
  });
});
```

---

## 5️⃣ CLIENT-SIDE RENDERING ENTEGRASYONU

### play.html'de Oyuncu Çizim Fonksiyonu

```javascript
// play.html satır 12743 civarında
function drawRemotePlayer(ctx, player, playerAcc) {
  // Karakter görüntüsü
  const playerImage = _playerSprite(player.skin);
  if (playerImage) {
    _drawCenteredSprite(ctx, playerImage, player.radius * 3.6);
  } else {
    drawSkinBody(ctx, player.radius, player.skin, globalTime, false);
  }

  // Göz overlay (kız skins hariç)
  if (!player.skin?.startsWith('kiz_')) {
    drawSkinEyesOverlay(ctx, player.radius, player.skin, false);
  }

  // ← THOR YILDIRIM AURA (Optional)
  if (player.skin === 'thor') {
    drawThorAura(ctx, player.radius, globalTime);
  }

  // Aksesuar katmanları
  if (playerAcc?.yuz && playerAcc.yuz !== 'f_none') {
    drawPlayerFace(ctx, playerAcc.yuz);
  }

  if (playerAcc?.sapkalar && playerAcc.sapkalar !== 'h_none') {
    ctx.save();
    ctx.rotate(-player.angle);
    drawPlayerHat(ctx, playerAcc.sapkalar, globalTime);
    ctx.restore();
  }

  // Kanatlar
  if (playerAcc?.kanatlar && playerAcc.kanatlar !== 'w_none') {
    drawPlayerWings(ctx, playerAcc.kanatlar, globalTime);
  }
}

// ← YENİ: Thor Aura Efekti
function drawThorAura(ctx, radius, globalTime) {
  ctx.save();
  
  // Pulse animasyonu
  const pulse = 0.7 + Math.sin(globalTime * 0.005) * 0.3;
  
  // Dış glow
  ctx.globalAlpha = pulse * 0.3;
  ctx.fillStyle = '#00c3ff';
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
  ctx.fill();
  
  // İç parlama
  ctx.globalAlpha = pulse * 0.5;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.8, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.restore();
}
```

---

## 6️⃣ ATTACK ANIMATION İNTEGRASYONU

### Silah Saldırısında Yıldırım

```javascript
// Server tarafı: Player attack event
socket.on('attack', (data) => {
  const player = players.get(socket.id);
  const target = data.targetId ? players.get(data.targetId) : null;
  
  if (player.skin === 'thor' && target) {
    // Hedefe yıldırım efekti
    socket.broadcast.emit('thor_lightning_strike', {
      attackerId: socket.id,
      targetId: target.id,
      x: target.x,
      y: target.y,
      timestamp: Date.now()
    });
  }
  
  // Normal attack logic devam et
  player.isAttacking = true;
  // ...
});

// Client tarafı: İçgelen yıldırım efekti
_socket.on('thor_lightning_strike', ({ attackerId, x, y }) => {
  const attacker = _otherPlayers.get(attackerId);
  if (attacker && attacker.skin === 'thor') {
    spawnThorLightning(x, y, attacker);
  }
});
```

---

## 7️⃣ PERFORMANCE OPTIMIZASYONLARI

### 1. **Object Pooling (Önerilen)**

```javascript
class ThorEffectPool {
  constructor(size = 100) {
    this.pool = [];
    this.active = [];
    
    for (let i = 0; i < size; i++) {
      this.pool.push(new ThorSpark(0, 0));
    }
  }
  
  get(x, y) {
    if (this.pool.length > 0) {
      const spark = this.pool.pop();
      spark.x = x;
      spark.y = y;
      this.active.push(spark);
      return spark;
    }
    return null;
  }
  
  release(spark) {
    const idx = this.active.indexOf(spark);
    if (idx > -1) {
      this.active.splice(idx, 1);
      this.pool.push(spark);
    }
  }
}
```

### 2. **Limit Enforcing**

```javascript
const MAX_THORNS = 25;      // Ana şimşekler
const MAX_SPARKS = 200;     // Kıvılcımlar
const MAX_SCORCH = 15;      // Yanık izleri

function spawnThorLightning(targetX, targetY, sourcePlayer) {
  if (thorLightningList.length >= MAX_THORNS) return;
  // ... spawn logic
}
```

### 3. **Render Optimization**

```javascript
// Shadow blur'ü dikkatli kullan
function drawThorEffects(ctx, globalTime) {
  // Shadow'u kontrol et (performans için)
  let useGlow = thorLightningList.length < 10;
  
  for (let i = 0; i < thorLightningList.length; i++) {
    const light = thorLightningList[i];
    if (useGlow) {
      light.draw(ctx);  // Glow ile
    } else {
      light.drawBasic(ctx);  // Glow'suz (hızlı)
    }
  }
}
```

---

## 8️⃣ COSMETICS SHOP İNTEGRASYONU

### Shop veritabanı (`shop.json` veya `config.js`)

```javascript
const COSMETICS_SHOP = {
  deriler: {
    thor: {
      name: 'Thor - Yıldırım Tanrısı',
      price: 5000,
      description: 'Çekici şimşek efektleri ile yıldırım güçlerini ele geçir!',
      rarity: 'EPIC',
      image: 'players/thor.png'
    }
  },
  baltalar: {
    ba_thunder: {
      name: 'Yıldırım Baltası',
      price: 2000,
      rarity: 'RARE',
      image: 'weapons/axe_thunder.png'
    }
  },
  kiliclar: {
    ki_thunder: {
      name: 'Yıldırım Kılıcı',
      price: 2000,
      rarity: 'RARE',
      image: 'weapons/sword_thunder.png'
    }
  },
  izler: {
    iz_thunder: {
      name: 'Yıldırım İzi',
      price: 1500,
      rarity: 'RARE',
      image: 'effects/trail_thunder.png'
    }
  }
};
```

---

## 9️⃣ TEST KONTROL LİSTESİ

- [ ] Thor PNG (180x180) oyuncu derisi listesine eklendi
- [ ] Lightning class play.html'e entegre edildi
- [ ] Server equippedItems modeli Thor'u içeriyor
- [ ] Network paket cosmetics alanını taşıyor
- [ ] FPS 60 korunuyor (25 lightning limit test)
- [ ] Tüm oyunculara efektler görünüyor
- [ ] Yaprak izleri yerle etkileşiyor
- [ ] Otomatik fırtına aktif (Thor özür)
- [ ] Saldırı yıldırımı tüm sunucuda senkron
- [ ] Mobile performansı iyi

---

## 🔟 DEPLOYMENT CHECKLIST

```bash
# 1. PNG'yi kopyala
cp thor_ultimate_skin_180x180.png Ah-main/game/players/thor.png

# 2. play.html'i düzenle (Lightning classes + render)
# 3. server.js'yi düzenle (cosmetics sync)
# 4. Database migration (existing users için)
# 5. Staging ortamda test et
# 6. Production'a deploy et
```

---

## 📚 Referans Dosyalar

| Dosya | Amaç |
|-------|------|
| `/workspaces/Cengi/thor.html` | Kaynak Lightning kodu (reference) |
| `/workspaces/Cengi/Ah-main/game/play.html` | Client render engine |
| `/workspaces/Cengi/Ah-main/server.js` | Server state manager |
| `/workspaces/Cengi/Ah-main/game/players/thor.png` | Asset dosyası |

