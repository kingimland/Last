# Thor Animasyon Kod Kaynakları

## 📖 İçindekiler

1. [Lightning Class](#lightning-class)
2. [Spark & Scorch Mark Classes](#spark--scorch-mark-classes)
3. [Spawn ve Interaction Fonksiyonları](#spawn-ve-interaction-fonksiyonları)
4. [Game Loop Integration](#game-loop-integration)
5. [Kopya/Yapıştırabilir Kod Blokları](#kopya-yapıştırabilir-kod-blokları)

---

## Lightning Class

```javascript
class Lightning {
    constructor(startX, startY, endX, endY, branchLevel = 0) {
        this.startX = startX;
        this.startY = startY;
        this.targetX = endX;
        this.targetY = endY;
        
        // Şimşek yolu oluşturma (daha zikzaklı)
        this.segments = this.createPath();
        
        this.alpha = 1;
        // Çekirdek şimşekler kalın, dallar daha ince ve kısa ömürlü
        this.branchLevel = branchLevel;
        this.decay = this.branchLevel === 0 ? 0.015 : 0.03; 
        
        // Sadece ana şimşekler (0) dallanma yapabilir (Kasma önlemi)
        if (this.branchLevel === 0 && lightnings.length < MAX_LIGHTNINGS) {
            this.createBranches();
        }
    }

    createPath() {
        let segments = [];
        let cx = this.startX;
        let cy = this.startY;
        let targetVector = { x: this.targetX - cx, y: this.targetY - cy };
        let distance = Math.sqrt(targetVector.x ** 2 + targetVector.y ** 2);
        
        // Mesafeye göre zikzak sayısı
        let numSteps = Math.max(5, Math.floor(distance / 15)); 
        
        segments.push({ x: cx, y: cy });

        for (let i = 1; i <= numSteps; i++) {
            let progress = i / numSteps;
            let idealX = this.startX + targetVector.x * progress;
            let idealY = this.startY + targetVector.y * progress;
            
            // Rastgele sapma (daha sert zikzaklar)
            let variance = 25; 
            if(i === numSteps) variance = 0; // Son adım tam hedefe gitsin

            let nx = idealX + (Math.random() - 0.5) * variance;
            let ny = idealY + (Math.random() - 0.5) * variance;
            
            segments.push({ x: nx, y: ny });
        }
        return segments;
    }

    createBranches() {
        // Şimşek yolunun ortalarından 1 veya 2 küçük dal çıkar
        let numBranches = Math.floor(Math.random() * 2) + 1;
        for(let i=0; i<numBranches; i++) {
            if (lightnings.length >= MAX_LIGHTNINGS) break;
            
            // Segmentlerin %30'u ile %70'i arasından bir yerden çık
            let splitIndex = Math.floor(this.segments.length * (0.3 + Math.random() * 0.4));
            if (!this.segments[splitIndex]) continue;

            let spX = this.segments[splitIndex].x;
            let spY = this.segments[splitIndex].y;
            
            // Dallar daha kısa bir mesafeye rastgele gider
            let angle = Math.random() * Math.PI * 2;
            let len = 40 + Math.random() * 50;
            let ex = spX + Math.cos(angle) * len;
            let ey = spY + Math.sin(angle) * len;
            
            lightnings.push(new Lightning(spX, spY, ex, ey, this.branchLevel + 1));
        }
    }

    update() {
        this.alpha -= this.decay;
        return this.alpha > 0;
    }

    draw(ctx) {
        if (this.alpha <= 0) return;
        
        // Dış parlama (Glow)
        ctx.beginPath();
        ctx.moveTo(this.segments[0].x, this.segments[0].y);
        for (let i = 1; i < this.segments.length; i++) {
            ctx.lineTo(this.segments[i].x, this.segments[i].y);
        }
        ctx.strokeStyle = `rgba(0, 195, 255, ${this.alpha * 0.8})`; // Mavi parlama
        ctx.lineWidth = this.branchLevel === 0 ? 8 : 4;
        ctx.shadowBlur = 20;
        ctx.shadowColor = "#00c3ff";
        ctx.stroke();

        // İç çekirdek (Core - Beyaz)
        ctx.beginPath();
        ctx.moveTo(this.segments[0].x, this.segments[0].y);
        for (let i = 1; i < this.segments.length; i++) {
            ctx.lineTo(this.segments[i].x, this.segments[i].y);
        }
        ctx.strokeStyle = `rgba(255, 255, 255, ${this.alpha})`;
        ctx.lineWidth = this.branchLevel === 0 ? 3 : 1.5;
        ctx.shadowBlur = 0; // İç çekirdekte blur yok, keskin kalsın
        ctx.stroke();
    }
}
```

---

## Spark & Scorch Mark Classes

```javascript
// KIVILCIM (SPARK) SINIFI
class Spark {
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
        ctx.shadowBlur = 0; // Diğer çizimleri etkilemesin
    }
}

// YANIK İZİ (SCORCH MARK) SINIFI
class ScorchMark {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.size = 15 + Math.random() * 15;
        this.life = 1.0;
    }
    update() {
        this.life -= 0.005; // Yavaşça silinir
        return this.life > 0;
    }
    draw(ctx) {
        ctx.fillStyle = `rgba(0, 0, 0, ${this.life * 0.6})`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
    }
}
```

---

## Spawn ve Interaction Fonksiyonları

```javascript
// ŞİMŞEK ÇAKTIRMA FONKSİYONU
function spawnLightning(targetX, targetY) {
    if (lightnings.length >= MAX_LIGHTNINGS) return;

    // KRİTİK NOKTA: YILDIRIM KARAKTERİN DERİSİNDEN ÇIKSIN
    // Karakterin merkezinden hedefe doğru olan açıyı bul
    let angleToTarget = Math.atan2(targetY - char.y, targetX - char.x);
    
    // Karakterin yarıçapı kadar o açıda ileri git (Böylece tam kenardan başlar)
    let startX = char.x + Math.cos(angleToTarget) * char.radius;
    let startY = char.y + Math.sin(angleToTarget) * char.radius;

    // Ana şimşeği oluştur
    lightnings.push(new Lightning(startX, startY, targetX, targetY, 0));

    // Hedefte yanık izi oluştur (Eğer çok yoksa)
    if (scorchMarks.length < 15) {
         scorchMarks.push(new ScorchMark(targetX, targetY));
    }

    // Hedefte kıvılcımlar patlat (Limit kontrolü)
    let numSparks = 5 + Math.floor(Math.random() * 5);
    for(let i=0; i<numSparks; i++) {
        if (sparks.length >= MAX_SPARKS) break;
        sparks.push(new Spark(targetX, targetY));
    }
}

// ETKİLEŞİMLER - Ekrana tıklandığında
canvas.addEventListener('pointerdown', (e) => {
    spawnLightning(e.clientX, e.clientY);
    
    // Karakter tıklandığı yere baksın (Klasik io mekaniği)
    char.angle = Math.atan2(e.clientY - char.y, e.clientX - char.x);
});

// Fare hareket ettiğinde karakter oraya baksın
canvas.addEventListener('pointermove', (e) => {
    char.angle = Math.atan2(e.clientY - char.y, e.clientX - char.x);
});

// Rastgele Şimşek Fırtınası Butonu
document.getElementById('btnStorm').addEventListener('click', (e) => {
    e.stopPropagation();
    
    // Etrafa ard arda rastgele 4 şimşek çaktır
    let count = 0;
    let stormInterval = setInterval(() => {
        if (count >= 4) {
            clearInterval(stormInterval);
            return;
        }
        // Karakterin etrafında rastgele bir hedef belirle
        let rDist = 100 + Math.random() * 200;
        let rAngle = Math.random() * Math.PI * 2;
        let tx = char.x + Math.cos(rAngle) * rDist;
        let ty = char.y + Math.sin(rAngle) * rDist;
        
        spawnLightning(tx, ty);
        count++;
    }, 100);
});
```

---

## Game Loop Integration

```javascript
// OYUN DÖNGÜSÜ (GAME LOOP)
function animate() {
    requestAnimationFrame(animate);

    // Zemin rengi
    ctx.fillStyle = '#1a202c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1. Zemindeki Yanık İzlerini Çiz
    for (let i = scorchMarks.length - 1; i >= 0; i--) {
        if (!scorchMarks[i].update()) {
            fastRemove(scorchMarks, i);
        } else {
            scorchMarks[i].draw(ctx);
        }
    }

    // 2. Karakteri Çiz
    char.x = canvas.width / 2; // Ortada tut
    char.y = canvas.height / 2;

    ctx.save();
    ctx.translate(char.x, char.y);
    ctx.rotate(char.angle);
    
    if (skinLoaded) {
        ctx.drawImage(thorSkin, -90, -90, 180, 180);
    } else {
        ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
        ctx.beginPath();
        ctx.arc(0, 0, char.radius, 0, Math.PI*2);
        ctx.fill();
    }
    
    ctx.restore();

    // 3. Şimşekleri Çiz ve Güncelle
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = lightnings.length - 1; i >= 0; i--) {
        if (!lightnings[i].update()) {
            fastRemove(lightnings, i);
        } else {
            lightnings[i].draw(ctx);
        }
    }

    // 4. Kıvılcımları Çiz
    for (let i = sparks.length - 1; i >= 0; i--) {
        if (!sparks[i].update()) {
            fastRemove(sparks, i);
        } else {
            sparks[i].draw(ctx);
        }
    }

    // OTOMATİK ŞİMŞEK SİSTEMİ
    // Saniyede ortalama 2-3 kere (her frame'de %4 ihtimalle) etrafa şimşek çakar
    if (Math.random() < 0.04) {
        // Karakterden 90px ile 300px arası uzaklıkta rastgele bir hedef seç
        let rDist = 90 + Math.random() * 210; 
        let rAngle = Math.random() * Math.PI * 2;
        let tx = char.x + Math.cos(rAngle) * rDist;
        let ty = char.y + Math.sin(rAngle) * rDist;
        
        spawnLightning(tx, ty);
    }
}

// Döngüyü başlat
animate();
```

---

## Kopya/Yapıştırabilir Kod Blokları

### A. İnitiyalizasyon (Script başında)

```javascript
// --- GÜVENLİK (KASMA ÖNLEYİCİ) LİMİTLER ---
const MAX_LIGHTNINGS = 25; // Aynı anda ekranda olabilecek maksimum şimşek (dallanmalar dahil)
const MAX_SPARKS = 200;    // Maksimum kıvılcım (particle)

let lightnings = [];
let sparks = [];
let scorchMarks = []; // Zemindeki yanık izleri

// --- YARDIMCI FONKSİYONLAR ---
// Optimizasyonlu dizi silme (O(1)) - Splice'tan daha hızlıdır
function fastRemove(array, index) {
    array[index] = array[array.length - 1];
    array.pop();
}
```

### B. Karakter Tanımı

```javascript
// Karakterin özellikleri
const char = {
    x: canvas.width / 2,
    y: canvas.height / 2,
    radius: 65, // Karakterin yarıçapı (Hitbox) - Yıldırımlar buradan çıkacak
    angle: 0
};
```

### C. Canvas Context Setup

```javascript
// Render için optimizasyon
ctx.lineCap = "round";
ctx.lineJoin = "round";
```

### D. İleri Performans (Opsiyonel - O(1) dizi deletesi)

```javascript
// Splice yerine fastRemove kullan
if (!lightnings[i].update()) {
    fastRemove(lightnings, i);  // ← Splice yerine bunu kullan!
} else {
    lightnings[i].draw(ctx);
}
```

---

## Parametre Aklı

| Parametre | Varsayılan | Açıklama |
|-----------|-----------|----------|
| `MAX_LIGHTNINGS` | 25 | Maksimum şimşek sayısı (FPS güvenliği) |
| `MAX_SPARKS` | 200 | Maksimum kıvılcım sayısı |
| `variance` | 25 | Şimşek zikzağının sapma miktarı |
| `numSteps` | distance/15 | Her şimşek kaç segmente bölünecek |
| `branchLevel` | 0 | Dalın derinlik seviyesi (0=ana) |
| `decay` | 0.015 / 0.03 | Fade animasyon hızı |
| `shadowBlur` | 20 / 0 | Glow efektinin bulanıklığı |

---

## Renk Paleti

```javascript
// Mavi/Elektrik
"#00c3ff"           // Glow rengi
"rgba(0, 195, 255, ...)"  // Mavi şimşek

// Beyaz/Çekirdek
"#ffffff"           // İç çekirdek
"rgba(255, 255, 255, ...)"  // Beyaz kısım

// Gölge
"rgba(150, 220, 255, ...)"  // Kıvılcım rengi

// Yanık İzi
"rgba(0, 0, 0, ...)"  // Siyah/Koyu izi
```

---

## Performance İpuçları

1. **Limiting**: Şimşek sayısını 25, kıvılcımı 200'de tut
2. **Fast Remove**: `splice` yerine `fastRemove()` kullan
3. **Shadow Blur**: Çok blur ağır olur, sınırlı kullan
4. **Auto Spawn**: %4 olasılık (60 FPS'de ~2-3 saniyede 1)
5. **Object Pooling**: Gerçek oyunda pool pattern kullan

