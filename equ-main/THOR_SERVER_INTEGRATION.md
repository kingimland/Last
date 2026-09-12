# Thor Cosmetic - Sunucu Entegrasyonu Rehberi

## 📡 Ağ Mimarisi

```
┌─────────────────────────────────────────────────────────────┐
│                      THOR COSMETIC FLOW                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  CLIENT 1 (Thor Skin)  ──────→ SERVER ←─────  CLIENT 2       │
│  - Yıldırım efektleri   Socket.io    Oyuncu                  │
│  - Local render      compactState()   bilgisi                │
│                                        alıyor                 │
│                                                               │
│  ↓ Server Yayını (Broadcast)                                 │
│                                                               │
│  CLIENT 2 ←───── Thor oyuncusu bilgilerini render ediyor     │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## 1️⃣ SERVER.JS DEĞİŞİKLİKLERİ

### A. Cosmetics Data Model

Dosya: `/workspaces/Cengi/Ah-main/server.js`

```javascript
// Satır 1: Üstte equippedItems şeması ekle
const COSMETICS_SCHEMA = {
  deriler: 'string',           // 'thor', 'wolf', 'penguin', vb
  profil_avatar: 'string',     // Leaderboard avatarı
  efektler: 'string',          // Profil efekti
  profil_cerceve: 'string',    // Profil çerçevesi
  kanatlar: 'string',          // Kanat
  sapkalar: 'string',          // Şapka
  yuz: 'string',               // Yüz aksesuarı
  aksesuarlar: 'string',       // Gövde aksesuarı
  baltalar: 'string',          // Balta skin
  kiliclar: 'string',          // Kılıç skin
  izler: 'string'              // Hareket izi
};

// Thor özel cosmetics paketi
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

### B. Player State Şeması

```javascript
// Player state objekti
const playerState = {
  id: socket.id,
  name: 'PlayerName',
  skin: 'thor',
  
  // ← COSMETICS
  acc: {
    baltalar: 'ba_thunder',
    kiliclar: 'ki_thunder',
    kanatlar: 'w_none',
    izler: 'iz_thunder',
    sapkalar: 'h_none',
    yuz: 'f_none',
    aksesuarlar: 'a_none'
  },
  
  // Profil cosmetics (Leaderboard)
  profileCosmetics: {
    avatarId: 'thor',
    effectId: 'effect_thunder',
    frameId: 'frame_woodland'
  },
  
  // Oyun state
  x: 0,
  y: 0,
  angle: 0,
  hp: 100,
  maxHp: 100,
  weapon: 1,
  isAttacking: false,
  kills: 0,
  xp: 0,
  gold: 0,
  
  // Senkronizasyon
  stateSeq: 0,
  stateAt: Date.now()
};
```

### C. Join Handler - Cosmetics ile

Konum: `server.js` - `socket.on('join', ...)`

```javascript
socket.on('join', (data, callback) => {
  // Kimlik doğrulama
  const token = data.token || data.authToken;
  const authUser = sessions.get(token);
  
  if (!authUser) {
    callback({ error: 'Kimlik doğrulaması başarısız' });
    return;
  }

  // Oyuncu adı
  const playerName = (data.name || '').substring(0, 20).trim() 
    || `Oyuncu_${Math.random().toString(36).substr(2, 5)}`;

  // ← COSMETICS YÜKLEME
  const equippedItems = authUser.equippedItems || {};
  const playerSkin = equippedItems.deriler || data.skin || 'default';
  
  // Aksesuar bilgilerini al
  const playerAcc = {
    baltalar: equippedItems.baltalar || 'ba_none',
    kiliclar: equippedItems.kiliclar || 'ki_none',
    kanatlar: equippedItems.kanatlar || 'w_none',
    sapkalar: equippedItems.sapkalar || 'h_none',
    yuz: equippedItems.yuz || 'f_none',
    aksesuarlar: equippedItems.aksesuarlar || 'a_none',
    izler: equippedItems.izler || 'iz_none'
  };

  // Profil cosmetics
  const profileCosmetics = {
    avatarId: equippedItems.profil_avatar || 'default',
    effectId: equippedItems.efektler || 'effect_none',
    frameId: equippedItems.profil_cerceve || 'frame_woodland'
  };

  // Player state oluştur
  const state = {
    name: playerName,
    skin: playerSkin,
    acc: playerAcc,
    profileCosmetics: profileCosmetics,
    color: data.color || '#8B5E3A',
    x: data.x || 0,
    y: data.y || 0,
    angle: 0,
    hp: 100,
    maxHp: 100,
    weapon: 1,
    isAttacking: false,
    kills: 0,
    xp: authUser.xp || 0,
    gold: 0,
    stateSeq: 0,
    stateAt: Date.now()
  };

  // Sunucuya oyuncuyu ekle
  const playerId = socket.id;
  players.set(playerId, state);

  // ← WELCOME paketini gönder (cosmetics ile)
  const otherPlayersData = {};
  for (const [pid, pstate] of players) {
    if (pid !== playerId) {
      otherPlayersData[pid] = compactState(pstate, true);
    }
  }

  socket.emit('welcome', {
    id: playerId,
    players: otherPlayersData,
    buildings: {},
    worldSeed: Math.random(),
    mobs: [],
    airdrops: [],
    bountyId: null,
    isHost: players.size === 1
  });

  // ← YENİ OYUNCU DUYURUSU (cosmetics ile)
  socket.broadcast.emit('player_join', {
    id: playerId,
    state: compactState(state, true)
  });

  // Callback ile başarılı sonuç
  callback && callback({ success: true });
});
```

### D. State Compact Fonksiyonu (KRITIK)

Konum: `server.js` - `compactState()` fonksiyonu

```javascript
/**
 * Oyuncu state'ini ağ için sıkıştır
 * @param {object} state - Oyuncu state
 * @param {boolean} full - True ise cosmetics ile gönder
 * @returns {object} Sıkıştırılmış state
 */
function compactState(state, full = false) {
  const score = (state.xp || 0) + (state.gold || 0) * 2;
  
  // Temel state (tick update - 30Hz)
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
  
  // FULL paket (join/welcome) - cosmetics eklenir
  if (full) {
    res.n = state.name || 'Oyuncu';
    res.sk = state.skin || 'default';
    res.color = state.color || '#8B5E3A';
    res.team = state.team || '';
    res.clanId = state.clanId || '';
    res.clanTag = state.clanTag || '';
    
    // ← COSMETICS ALANLARI
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

### E. Tick Update Loop

Konum: `server.js` - Ana game loop

```javascript
// Her 30ms'de tüm oyuncuları yayınla
setInterval(() => {
  const statesByPlayer = {};
  
  for (const [playerId, state] of players) {
    // ← Cosmetics OLMADAN sıkıştırılmış state (bandwidth tasarrufu)
    statesByPlayer[playerId] = compactState(state, false);
  }
  
  io.emit('players', statesByPlayer);
}, 30);
```

### F. Attack Event - Thor Yıldırım

```javascript
socket.on('attack', (data) => {
  const player = players.get(socket.id);
  if (!player) return;

  player.isAttacking = true;
  player.attackTimer = 0;
  player.attackDuration = 300; // ms

  // ← THOR SPESIFIK: Hedefte yıldırım efekti
  if (player.skin === 'thor') {
    const targetId = data.targetId;
    const target = players.get(targetId);
    
    if (target) {
      // Yıldırım efekti socket event'i
      io.emit('thor_lightning', {
        attackerId: socket.id,
        targetId: targetId,
        fromX: player.x,
        fromY: player.y,
        toX: target.x,
        toY: target.y,
        timestamp: Date.now()
      });
    }
  }

  // Normal attack logic
  player.lastAttack = Date.now();
});
```

---

## 2️⃣ COSMETICS SHOP API

### Shop Endpoint - Equip Item

```javascript
// PUT /api/shop/equip
app.put('/api/shop/equip', authenticate, (req, res) => {
  const { category, item } = req.body;
  const user = req.user;
  
  // Validasyon
  if (!category || !item) {
    return res.status(400).json({ 
      error: 'category ve item gerekli' 
    });
  }

  // ← COSMETICS KATEGORILERI
  const validCategories = [
    'deriler',
    'kanatlar',
    'sapkalar',
    'yuz',
    'aksesuarlar',
    'baltalar',
    'kiliclar',
    'izler',
    'profil_avatar',
    'efektler',
    'profil_cerceve'
  ];

  if (!validCategories.includes(category)) {
    return res.status(400).json({ 
      error: 'Geçersiz kategori' 
    });
  }

  // ← THOR COSMETICS KONTROLÜ
  if (category === 'deriler' && item === 'thor') {
    // Thor derisi - premium/özel
    if (!user.premiumItems || !user.premiumItems.includes('thor')) {
      return res.status(403).json({ 
        error: 'Thor derisi satın almalısınız' 
      });
    }
  }

  // Equip et
  if (!user.equippedItems) {
    user.equippedItems = {};
  }

  user.equippedItems[category] = item;
  
  // Veritabanını güncelle
  updateUserDB(user.id, {
    equippedItems: user.equippedItems
  });

  res.json({
    success: true,
    equippedItems: user.equippedItems
  });
});

// GET /api/shop/cosmetics
app.get('/api/shop/cosmetics', (req, res) => {
  const cosmetics = {
    deriler: {
      default: { name: 'Varsayılan', rarity: 'COMMON' },
      wolf: { name: 'Kurt', rarity: 'COMMON' },
      frog: { name: 'Kurbağa', rarity: 'COMMON' },
      penguin: { name: 'Penguen', rarity: 'COMMON' },
      // ← THOR COSMETIC
      thor: { 
        name: 'Thor - Yıldırım Tanrısı', 
        rarity: 'EPIC',
        description: 'Çekici şimşek efektleri ile yıldırım güçlerini ele geçir!',
        price: 5000
      }
    },
    baltalar: {
      ba_none: { name: 'Yok', rarity: 'COMMON' },
      ba_thunder: {  // ← THOR BALTASI
        name: 'Yıldırım Baltası',
        rarity: 'RARE',
        price: 2000
      }
    },
    kiliclar: {
      ki_none: { name: 'Yok', rarity: 'COMMON' },
      ki_thunder: {  // ← THOR KILIÇI
        name: 'Yıldırım Kılıcı',
        rarity: 'RARE',
        price: 2000
      }
    },
    izler: {
      iz_none: { name: 'Yok', rarity: 'COMMON' },
      iz_thunder: {  // ← THOR İZİ
        name: 'Yıldırım İzi',
        rarity: 'RARE',
        price: 1500
      }
    }
  };

  res.json(cosmetics);
});
```

---

## 3️⃣ VERITABANI MİGRASYONU

### SQLite Migration Script

```sql
-- Mevcut equippedItems column'ı JSON'a dönüştür
ALTER TABLE users ADD COLUMN equippedItems_new TEXT;

-- Verileri kopyala (varsa)
UPDATE users 
SET equippedItems_new = equippedItems 
WHERE equippedItems IS NOT NULL;

-- Yeni sütun için default değer
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

-- Eski sütunu sil
ALTER TABLE users DROP COLUMN equippedItems;

-- Yeni sütunu yeniden adlandır
ALTER TABLE users RENAME COLUMN equippedItems_new TO equippedItems;
```

---

## 4️⃣ PAKET BOYUT ANALİZİ

### Bandwidth Hesaplaması

```
┌─────────────────────────────────────────────────────────────┐
│           PAKET BOYUT ANALİZİ (Baytlar)                      │
├────────────────────┬──────────────┬─────────────────────────┤
│ Paket Türü         │ Boyut        │ Gön. Sıklığı            │
├────────────────────┼──────────────┼─────────────────────────┤
│ Tick (minimal)     │ ~80 bytes    │ 30Hz (33ms)             │
│ Welcome (full)     │ ~350 bytes   │ Join (nadir)            │
│ Player join        │ ~350 bytes   │ New player              │
│ Attack            │ ~50 bytes    │ Variable                │
│ Thor Lightning    │ ~40 bytes    │ Variable (Thor player) │
├────────────────────┼──────────────┼─────────────────────────┤
│ TOPLAM (1 oyuncu)  │ 2.4 Kb       │ 30 saniye               │
│ 10 oyuncu          │ 24 Kb        │ 30 saniye               │
└────────────────────┴──────────────┴─────────────────────────┘

Hesaplama:
  - 1 oyuncu tick: 80 bytes * 30 FPS = 2.4 Kb/saniye
  - 10 oyuncu: 2.4 * 10 = 24 Kb/saniye
  - Cosmetics: Sadece JOIN'de 270 byte ekstra
```

---

## 5️⃣ DEBUGGING & LOGGING

```javascript
// Logger helper
function debugThorCosmetic(msg, data) {
  if (process.env.DEBUG_THOR) {
    console.log(`[THOR COSMETIC] ${msg}`, data);
  }
}

// Join'de log
socket.on('join', (data, callback) => {
  debugThorCosmetic('Player join', {
    playerId: socket.id,
    skin: playerSkin,
    cosmetics: playerAcc
  });
  // ...
});

// Attack'te log
socket.on('attack', (data) => {
  const player = players.get(socket.id);
  if (player.skin === 'thor') {
    debugThorCosmetic('Thor lightning attack', {
      from: { x: player.x, y: player.y },
      to: { x: data.targetX, y: data.targetY }
    });
  }
  // ...
});
```

Environment variable:
```bash
DEBUG_THOR=1 npm start
```

---

## 6️⃣ PRODUCTION DEPLOYMENT

### Checklist

- [ ] Database migration çalıştırıldı
- [ ] Server code cosmetics ile güncellendiğdi
- [ ] Socket events tanımlandı
- [ ] Thor PNG dosyası `/game/players/` dizininde
- [ ] Shop API cosmetics döndürüyor
- [ ] Welcome paketi cosmetics içeriyor
- [ ] Tick paketleri minimal tutuluyor
- [ ] Logging aktif (DEBUG_THOR)
- [ ] Staging ortamda test edildi

### Deployment Command

```bash
# Staging
DEBUG_THOR=1 NODE_ENV=staging npm start

# Production
NODE_ENV=production npm start
```

