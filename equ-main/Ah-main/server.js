const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');
const NetworkPhysics = require('./game/networkPhysics.js');

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const root = path.join(__dirname, 'game');
const players = new Map();
const buildings = new Map();
const rooms = new Map();
const BUILDING_CELL_SIZE = 180;
let buildingGrid = new Map();
function rebuildBuildingGrid() {
  const nextGrid = new Map();
  for (const building of buildings.values()) {
    const key = `${Math.floor((Number(building.x) || 0) / BUILDING_CELL_SIZE)},${Math.floor((Number(building.y) || 0) / BUILDING_CELL_SIZE)}`;
    const bucket = nextGrid.get(key);
    if (bucket) bucket.push(building);
    else nextGrid.set(key, [building]);
  }
  buildingGrid = nextGrid;
}
function nearbyBuildings(x, y, radius) {
  const minX = Math.floor((x - radius) / BUILDING_CELL_SIZE);
  const maxX = Math.floor((x + radius) / BUILDING_CELL_SIZE);
  const minY = Math.floor((y - radius) / BUILDING_CELL_SIZE);
  const maxY = Math.floor((y + radius) / BUILDING_CELL_SIZE);
  const nearby = [];
  for (let cellX = minX; cellX <= maxX; cellX++) {
    for (let cellY = minY; cellY <= maxY; cellY++) {
      const bucket = buildingGrid.get(`${cellX},${cellY}`);
      if (bucket) nearby.push(...bucket);
    }
  }
  return nearby;
}
const parties = new Map();
const clans = new Map();
const clanJoinRequests = new Map();
const sessions = new Map();
const ownerSessions = new Map();
const ownerSessionTtl = 12 * 60 * 60 * 1000;
const ownerAuditLog = [];
const adminConfig = {
  maintenance: false,
  pvpEnabled: true,
  xpRate: 1,
  mobSpawnMultiplier: 1,
  resourceRespawnMultiplier: 1,
  announcement: ''
};
function getOwnerCredentials() {
  loadDotEnv(path.join(__dirname, '.env'));
  const username = String(process.env.OWNER_USERNAME || 'owner').trim().toLowerCase();
  const password = String(process.env.OWNER_PASSWORD || 'admin').trim();
  return { username, password };
}
function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
function ownerTokenFor(username) {
  return crypto.createHmac('sha256', authSecret).update(`owner:${username}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`).digest('hex');
}
function getOwnerSession(request) {
  const header = String(request.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = ownerSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) ownerSessions.delete(token);
    return null;
  }
  session.lastSeenAt = Date.now();
  return session;
}
function ownerAudit(action, meta = {}) {
  ownerAuditLog.unshift({ action, at: Date.now(), ...meta });
  if (ownerAuditLog.length > 100) ownerAuditLog.length = 100;
  if (sqliteDb) {
    try {
      sqliteDb.prepare('INSERT INTO game_state (state_key, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at').run('owner_audit', JSON.stringify(ownerAuditLog), Date.now());
    } catch (_) {}
  }
}
function ownerRequired(request, response) {
  const session = getOwnerSession(request);
  if (!session) {
    sendJson(response, 401, { error: 'Owner oturumu gerekli.' });
    return null;
  }
  return session;
}
function pvpAllowed() {
  return adminConfig.pvpEnabled !== false;
}
const reconnectSessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [guestId, session] of reconnectSessions) {
    if (session.savedAt < cutoff) reconnectSessions.delete(guestId);
  }
}, 30000).unref();
const mobs = new Map();
const mobHitCooldowns = new Map();
const trapPushCooldowns = new Map();
setInterval(() => {
  const now = Date.now();
  if (trapPushCooldowns.size > 150) {
    for (const [key, time] of trapPushCooldowns) {
      if (now - time > 10000) trapPushCooldowns.delete(key);
    }
  }
  if (mobHitCooldowns.size > 300) {
    for (const [key, time] of mobHitCooldowns) {
      if (now - time > 15000) mobHitCooldowns.delete(key);
    }
  }
}, 30000);
const authRateLimits = new Map();
const AUTH_LIMITS = {
  login: { max: 12, windowMs: 10 * 60 * 1000 },
  register: { max: 5, windowMs: 60 * 60 * 1000 },
  profile_state: { max: 12, windowMs: 60 * 1000 },
  profile_xp: { max: 2, windowMs: 30 * 1000 },
  shop_buy: { max: 10, windowMs: 60 * 1000 }
};
const MAX_ACCOUNT_XP = 25_000_000;
const MAX_ACCOUNT_COINS = 50_000_000;
const MAX_ACCOUNT_SCORE = 25_000_000;

function clampNumber(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function normalizeWorldCoord(value, fallback = 0, limit = 7200) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(-limit, Math.min(limit, numeric));
}

function normalizePlayerSnapshot(player) {
  if (!player || typeof player !== 'object') return null;
  player.x = normalizeWorldCoord(player.x, 0);
  player.y = normalizeWorldCoord(player.y, 0);
  player.angle = Number.isFinite(Number(player.angle)) ? Number(player.angle) : 0;
  player.hp = clampNumber(player.hp, player.maxHp ?? 250, 0, player.maxHp ?? 250);
  player.maxHp = clampNumber(player.maxHp, 250, 1, 5000);
  player.gold = clampNumber(player.gold, 0, 0, MAX_ACCOUNT_COINS);
  player.xp = clampNumber(player.xp, 0, 0, MAX_ACCOUNT_XP);
  player.score = clampNumber(player.score, 0, 0, MAX_ACCOUNT_SCORE);
  player.sc = player.score;
  player.wood = clampNumber(player.wood, 0, 0, 2_000_000);
  player.stone = clampNumber(player.stone, 0, 0, 2_000_000);
  player.apples = clampNumber(player.apples, 0, 0, 10000);
  return player;
}

function sanitizeOwnedItems(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  const seen = new Set();
  const items = [];
  for (const item of rawValue.slice(0, 200)) {
    const next = String(item || '').trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    items.push(next);
  }
  return items;
}

const SOCKET_EVENT_LIMITS = {
  state: [45, 1000], swing: [25, 1000], pvp_hit: [25, 1000], arrow_hit: [12, 1000],
  spike_hit: [15, 1000], airdrop_hit: [15, 1000], trap_touch: [20, 1000],
  trap_owner_push: [30, 1000], res_hit: [20, 1000], mob_hit_req: [15, 1000],
  place_building: [6, 1000], build_hp_update: [12, 1000], build_tier_update: [6, 1000],
  chat: [3, 2000], quick_chat: [6, 2000], eat_apple: [4, 2000]
};

function socketEventRateLimited(socket, eventName) {
  const limit = SOCKET_EVENT_LIMITS[eventName];
  if (!limit) return false;
  const now = Date.now();
  const [max, windowMs] = limit;
  const rates = socket.data.rateLimits || (socket.data.rateLimits = new Map());
  const current = rates.get(eventName);
  if (!current || now - current.startedAt >= windowMs) {
    rates.set(eventName, { startedAt: now, count: 1 });
    return false;
  }
  current.count++;
  return current.count > max;
}
function requestClientKey(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || request.socket.remoteAddress || 'unknown';
}
function authRateLimited(request, action) {
  const policy = AUTH_LIMITS[action];
  if (!policy) return false;
  const key = `${action}:${requestClientKey(request)}`;
  const now = Date.now();
  const entry = authRateLimits.get(key);
  if (!entry || now - entry.startedAt >= policy.windowMs) {
    authRateLimits.set(key, { startedAt: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > policy.max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of authRateLimits) {
    const action = key.split(':', 1)[0];
    if (!AUTH_LIMITS[action] || now - entry.startedAt >= AUTH_LIMITS[action].windowMs) authRateLimits.delete(key);
  }
}, 15 * 60 * 1000).unref();
const MOB_TYPES = [
  { shape: 'wolf', color: '#6b4932', outline: '#28170d', eyes: '#ffcc66', typeName: '🐺 Kurt', radius: 46, hp: 300, dmg: 28, speed: 18, wanderSpeed: 10, xpReward: 80, goldReward: 22 },
  { shape: 'scorpion', color: '#4a2818', outline: '#1a0d06', eyes: '#ff4400', typeName: '🦂 Akrep', radius: 52, hp: 520, dmg: 46, speed: 15, wanderSpeed: 9, xpReward: 150, goldReward: 38 },
  { shape: 'bear', color: '#4a2f1b', outline: '#1a1008', eyes: '#ffaa00', typeName: '🐻 Ayı', radius: 65, hp: 950, dmg: 72, speed: 14, wanderSpeed: 8, xpReward: 320, goldReward: 82 },
  { shape: 'spider', color: '#2a1a38', outline: '#0f0814', eyes: '#ff1100', typeName: '🕷️ Örümcek', radius: 48, hp: 380, dmg: 34, speed: 17, wanderSpeed: 9, xpReward: 100, goldReward: 28 },
];
const databaseFile = process.env.DATABASE_FILE || path.join(__dirname, 'forestbrawl.db');
let sqliteDb = null;
let databaseLastError = null;
try {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  sqliteDb = new DatabaseSync(databaseFile);
  sqliteDb.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS game_state (state_key TEXT PRIMARY KEY, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  console.log(`[Database] SQLite ready: ${databaseFile}`);
} catch (error) {
  databaseLastError = error.message;
  console.warn(`[Database] SQLite unavailable; starting with empty in-memory state: ${error.message}`);
}
function loadAdminConfig() {
  if (!sqliteDb) return;
  try {
    const row = sqliteDb.prepare('SELECT state_json FROM game_state WHERE state_key = ?').get('admin_config');
    if (!row) return;
    const saved = JSON.parse(row.state_json);
    for (const key of Object.keys(adminConfig)) {
      if (saved[key] !== undefined) adminConfig[key] = saved[key];
    }
  } catch (error) {
    console.warn(`[Database] Admin config read failed: ${error.message}`);
  }
}
function loadOwnerAudit() {
  if (!sqliteDb) return;
  try {
    const row = sqliteDb.prepare('SELECT state_json FROM game_state WHERE state_key = ?').get('owner_audit');
    if (!row) return;
    const saved = JSON.parse(row.state_json);
    if (Array.isArray(saved)) ownerAuditLog.push(...saved.slice(0, 100));
  } catch (_) {}
}
function saveAdminConfig() {
  if (!sqliteDb) return false;
  try {
    sqliteDb.prepare('INSERT INTO game_state (state_key, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at').run('admin_config', JSON.stringify(adminConfig), Date.now());
    return true;
  } catch (error) {
    console.warn(`[Database] Admin config write failed: ${error.message}`);
    return false;
  }
}
loadAdminConfig();
loadOwnerAudit();
const bannedList = new Set();
function loadBannedList() {
  if (!sqliteDb) return;
  try {
    const row = sqliteDb.prepare('SELECT state_json FROM game_state WHERE state_key = ?').get('banned_list');
    if (!row) return;
    const saved = JSON.parse(row.state_json);
    if (Array.isArray(saved)) saved.forEach(item => bannedList.add(String(item)));
  } catch (_) {}
}
function saveBannedList() {
  if (!sqliteDb) return false;
  try {
    sqliteDb.prepare('INSERT INTO game_state (state_key, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at').run('banned_list', JSON.stringify([...bannedList]), Date.now());
    return true;
  } catch (_) { return false; }
}
loadBannedList();
function isClientBanned(clientKey, username) {
  if (clientKey && bannedList.has(clientKey)) return true;
  if (username && bannedList.has(usernameKey(username))) return true;
  return false;
}
const authSecret = process.env.AUTH_SECRET || crypto.createHash('sha256').update(`forestbrawl:${path.resolve(databaseFile)}`).digest('hex');
if (!process.env.AUTH_SECRET) console.warn('[Security] AUTH_SECRET is not set; using a stable development secret. Set AUTH_SECRET in production.');
function normalizeAllowedOrigin(origin) {
  return String(origin || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/^https?:\/\//, '')
    .toLowerCase();
}
const configuredAllowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => normalizeAllowedOrigin(origin))
  .filter(Boolean);
const defaultAllowedOrigins = [
  'https://forestbrawl.fun',
  'https://www.forestbrawl.fun',
  'https://titotu.io',
  'https://www.titotu.io',
  'https://titotu.ru',
  'https://www.titotu.ru',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://0.0.0.0:3000',
  'http://localhost',
  'http://127.0.0.1',
  'http://0.0.0.0',
];
const allowedOrigins = new Set([
  ...configuredAllowedOrigins,
  ...defaultAllowedOrigins.map(normalizeAllowedOrigin),
].filter(Boolean));
const allowedOriginHostnames = new Set([...allowedOrigins].map(origin => {
  if (origin.startsWith('http://')) return origin.replace(/^http:\/\//, '');
  if (origin.startsWith('https://')) return origin.replace(/^https:\/\//, '');
  return origin;
}));
function isAllowedOrigin(origin) {
  if (!origin) return true;
  const normalized = normalizeAllowedOrigin(origin);
  if (allowedOrigins.has(normalized)) return true;
  const hostname = normalized.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  return allowedOriginHostnames.has(hostname);
}
const worldSeed = 0x4F524553;
let nextMobId = 1;
const airdrops = new Map();
let nextAirdropId = 1;
const BOUNTY_EVENT_ENABLED = false;
let currentBountyId = null;
let lastAirdropSpawn = 0;
setInterval(rebuildBuildingGrid, 250);

const QUESTS_LIST = [
  { id: 'q_wolf_100', title: 'Kurt Sürüsünün Sonu', desc: 'Ormanda 100 vahşi kurt avla', icon: '🐺', key: 'wolves', target: 100, rewardCoins: 1800, rewardXp: 1600 },
  { id: 'q_bear_40', title: 'Ayıların Efendisi', desc: '40 orman ayısını savaşta alt et', icon: '🐻', key: 'bears', target: 40, rewardCoins: 3200, rewardXp: 3000 },
  { id: 'q_scorpion_60', title: 'Çölün Zehir Ustası', desc: 'Çölde 60 akrebi yok et', icon: '🦂', key: 'scorpions', target: 60, rewardCoins: 2800, rewardXp: 2600 },
  { id: 'q_spider_60', title: 'Mağara Temizliği', desc: '60 zehirli örümceği ortadan kaldır', icon: '🕷️', key: 'spiders', target: 60, rewardCoins: 2800, rewardXp: 2600 },
  { id: 'q_pvp_kill_25', title: 'Arena Celladı', desc: '25 düşman oyuncuyu PvP’de katlet', icon: '⚔️', key: 'kills', target: 25, rewardCoins: 5000, rewardXp: 4500 },
  { id: 'q_bounty_king_3', title: 'Altın Kralların Sonu', desc: '3 kez hüküm süren ödül kralını indir', icon: '👑', key: 'kingKills', target: 3, rewardCoins: 6500, rewardXp: 6000 },
  { id: 'q_airdrop_10', title: 'Airdrop Avcısı', desc: '10 yüksek değerli airdrop sandığı aç', icon: '📦', key: 'airdrops', target: 10, rewardCoins: 4200, rewardXp: 4000 },
  { id: 'q_build_100', title: 'Orman Kalesi', desc: '100 savunma yapısı inşa et', icon: '🪵', key: 'buildings', target: 100, rewardCoins: 3500, rewardXp: 3200 },
  { id: 'q_gold_10000', title: 'Ormanın Hazinedarı', desc: 'Kaynaklardan toplam 10.000 altın çıkar', icon: '🪙', key: 'gold', target: 10000, rewardCoins: 6000, rewardXp: 5500 }
];

const DAILY_QUEST_POOL = [
  { id: 'daily_wood_250', title: 'Genç Oduncu', desc: '250 odun topla', icon: '🪵', key: 'wood', target: 250, rewardCoins: 180, rewardXp: 120, difficulty: 'easy' },
  { id: 'daily_stone_150', title: 'Taşın İlk Sırrı', desc: '150 taş topla', icon: '🪨', key: 'stone', target: 150, rewardCoins: 180, rewardXp: 120, difficulty: 'easy' },
  { id: 'daily_gold_100', title: 'Parlayan Damar', desc: '100 altın çıkar', icon: '🪙', key: 'gold', target: 100, rewardCoins: 220, rewardXp: 150, difficulty: 'easy' },
  { id: 'daily_survive_4', title: 'İlk Nöbet', desc: 'Toplam 4 dakika hayatta kal', icon: '⏱️', key: 'time', target: 4, rewardCoins: 220, rewardXp: 160, difficulty: 'easy' },
  { id: 'daily_build_8', title: 'Siper Kur', desc: '8 yapı inşa et', icon: '🧱', key: 'buildings', target: 8, rewardCoins: 240, rewardXp: 180, difficulty: 'easy' },
  { id: 'daily_kills_3', title: 'İlk Av', desc: '3 düşman oyuncuyu alt et', icon: '⚔️', key: 'kills', target: 3, rewardCoins: 260, rewardXp: 200, difficulty: 'easy' },
  { id: 'daily_wood_900', title: 'Orman Maratonu', desc: '900 odun topla', icon: '🌲', key: 'wood', target: 900, rewardCoins: 650, rewardXp: 500, difficulty: 'medium' },
  { id: 'daily_stone_700', title: 'Kaya Ustası', desc: '700 taş topla', icon: '⛏️', key: 'stone', target: 700, rewardCoins: 700, rewardXp: 560, difficulty: 'medium' },
  { id: 'daily_gold_500', title: 'Altın Damarı', desc: '500 altın çıkar', icon: '💰', key: 'gold', target: 500, rewardCoins: 850, rewardXp: 700, difficulty: 'medium' },
  { id: 'daily_survive_12', title: 'Uzun Nöbet', desc: 'Toplam 12 dakika hayatta kal', icon: '⌛', key: 'time', target: 12, rewardCoins: 800, rewardXp: 720, difficulty: 'medium' },
  { id: 'daily_build_30', title: 'Kale Mühendisi', desc: '30 yapı inşa et', icon: '🏗️', key: 'buildings', target: 30, rewardCoins: 900, rewardXp: 760, difficulty: 'medium' },
  { id: 'daily_kills_12', title: 'Arena Takibi', desc: '12 düşman oyuncuyu alt et', icon: '🗡️', key: 'kills', target: 12, rewardCoins: 1100, rewardXp: 900, difficulty: 'medium' },
  { id: 'daily_wolves_35', title: 'Kurt Sürücüsü', desc: '35 vahşi kurt avla', icon: '🐺', key: 'wolves', target: 35, rewardCoins: 760, rewardXp: 620, difficulty: 'medium' },
  { id: 'daily_airdrop_2', title: 'Gökyüzü Payı', desc: '2 airdrop sandığı aç', icon: '📦', key: 'airdrops', target: 2, rewardCoins: 950, rewardXp: 800, difficulty: 'medium' },
  { id: 'daily_bears_12', title: 'Ayı Avcısı', desc: '12 orman ayısını alt et', icon: '🐻', key: 'bears', target: 12, rewardCoins: 1000, rewardXp: 850, difficulty: 'medium' },
  { id: 'daily_kills_35', title: 'Kızıl Arena', desc: '35 düşman oyuncuyu alt et', icon: '🩸', key: 'kills', target: 35, rewardCoins: 2600, rewardXp: 2200, difficulty: 'hard' },
  { id: 'daily_kills_60', title: 'Avcıların Avcısı', desc: '60 düşman oyuncuyu alt et', icon: '☠️', key: 'kills', target: 60, rewardCoins: 4300, rewardXp: 3600, difficulty: 'hard' },
  { id: 'daily_kills_100', title: 'Arena Fırtınası', desc: '100 düşman oyuncuyu alt et', icon: '🔥', key: 'kills', target: 100, rewardCoins: 7200, rewardXp: 6000, difficulty: 'hard' },
  { id: 'daily_survive_30', title: 'Karanlık Nöbet', desc: 'Toplam 30 dakika hayatta kal', icon: '🌙', key: 'time', target: 30, rewardCoins: 3000, rewardXp: 2800, difficulty: 'hard' },
  { id: 'daily_wood_3000', title: 'Orman Yutan', desc: '3.000 odun topla', icon: '🌳', key: 'wood', target: 3000, rewardCoins: 2800, rewardXp: 2500, difficulty: 'hard' },
  { id: 'daily_stone_2500', title: 'Dağ Söken', desc: '2.500 taş topla', icon: '⛰️', key: 'stone', target: 2500, rewardCoins: 3000, rewardXp: 2700, difficulty: 'hard' },
  { id: 'daily_gold_2000', title: 'Hazine Lordu', desc: '2.000 altın çıkar', icon: '👑', key: 'gold', target: 2000, rewardCoins: 3800, rewardXp: 3300, difficulty: 'hard' },
  { id: 'daily_build_100', title: 'Sınır Kalesi', desc: '100 yapı inşa et', icon: '🏰', key: 'buildings', target: 100, rewardCoins: 3200, rewardXp: 2900, difficulty: 'hard' },
  { id: 'daily_wolves_120', title: 'Sürülerin Sonu', desc: '120 vahşi kurt avla', icon: '🐺', key: 'wolves', target: 120, rewardCoins: 2400, rewardXp: 2100, difficulty: 'hard' },
  { id: 'daily_bears_45', title: 'Ayıların Kâbusu', desc: '45 orman ayısını alt et', icon: '🐻', key: 'bears', target: 45, rewardCoins: 3600, rewardXp: 3200, difficulty: 'hard' },
  { id: 'daily_scorpions_70', title: 'Zehir Tahtı', desc: '70 akrebi yok et', icon: '🦂', key: 'scorpions', target: 70, rewardCoins: 3400, rewardXp: 3000, difficulty: 'hard' },
  { id: 'daily_spiders_80', title: 'Mağara Fatihi', desc: '80 zehirli örümceği yok et', icon: '🕷️', key: 'spiders', target: 80, rewardCoins: 3500, rewardXp: 3100, difficulty: 'hard' },
  { id: 'daily_airdrop_6', title: 'Düşen Krallık', desc: '6 airdrop sandığı aç', icon: '📦', key: 'airdrops', target: 6, rewardCoins: 4200, rewardXp: 3800, difficulty: 'hard' },
  { id: 'daily_king_5', title: 'Taht Avcısı', desc: '5 ödül kralını alt et', icon: '♛', key: 'kingKills', target: 5, rewardCoins: 5000, rewardXp: 4500, difficulty: 'hard' },
  { id: 'daily_build_180', title: 'Orman İmparatorluğu', desc: '180 yapı inşa et', icon: '🛡️', key: 'buildings', target: 180, rewardCoins: 5600, rewardXp: 5000, difficulty: 'hard' }
];

const ULTRA_QUESTS = [
  { id: 'ultra_kills_500', title: 'Savaş Tanrısı', desc: '500 düşman oyuncuyu PvP’de alt et', icon: '⚔️', key: 'kills', target: 500, rewardCoins: 30000, rewardXp: 24000, difficulty: 'ultra' },
  { id: 'ultra_time_600', title: 'Sonsuz Nöbet', desc: 'Toplam 10 saat hayatta kal', icon: '⌛', key: 'time', target: 600, rewardCoins: 24000, rewardXp: 20000, difficulty: 'ultra' },
  { id: 'ultra_gold_100000', title: 'Altın İmparatorluğu', desc: 'Kaynaklardan toplam 100.000 altın çıkar', icon: '💰', key: 'gold', target: 100000, rewardCoins: 35000, rewardXp: 28000, difficulty: 'ultra' },
  { id: 'ultra_buildings_1000', title: 'Büyük Orman Kalesi', desc: '1.000 savunma yapısı inşa et', icon: '🏰', key: 'buildings', target: 1000, rewardCoins: 28000, rewardXp: 22000, difficulty: 'ultra' },
  { id: 'ultra_airdrops_50', title: 'Gökyüzünün Efendisi', desc: '50 airdrop sandığı aç', icon: '📦', key: 'airdrops', target: 50, rewardCoins: 26000, rewardXp: 21000, difficulty: 'ultra' },
  { id: 'ultra_king_25', title: 'Kralların Kralı', desc: '25 ödül kralını alt et', icon: '👑', key: 'kingKills', target: 25, rewardCoins: 32000, rewardXp: 26000, difficulty: 'ultra' },
  { id: 'ultra_wolves_1000', title: 'Sürülerin Hükümdarı', desc: '1.000 vahşi kurt avla', icon: '🐺', key: 'wolves', target: 1000, rewardCoins: 22000, rewardXp: 18000, difficulty: 'ultra' },
  { id: 'ultra_spiders_500', title: 'Derinliklerin Fatihi', desc: '500 zehirli örümceği yok et', icon: '🕷️', key: 'spiders', target: 500, rewardCoins: 20000, rewardXp: 16000, difficulty: 'ultra' }
];

const DAILY_REWARDS = [25, 40, 60, 90, 130, 180, 250];
const MATCH_XP_RATE = 0.04;
const QUEST_XP_RATE = 0.2;
const LEVEL_REWARD_BASE_COINS = 25;
const LEVEL_REWARD_STEP_COINS = 5;
const XP_RESET_VERSION = 3;
const COIN_RESET_VERSION = 1;

const CHEST_CONFIG = {
  wood_chest: { cost: 1500, rewards: ['penguin', 'frog', 'croc', 'fox', 'panda', 'rabbit', 'skin_desert', 'skin_emerald', 'skin_reef', 'skin_steam', 'skin_blossom', 'robot'] },
  gold_chest: { cost: 4000, rewards: ['dragon', 'phoenix', 'skin_aurora', 'skin_storm', 'skin_sapphire', 'skin_ruby', 'skin_frostwolf', 'skin_cyber', 'yeti', 'robot', 'ninja', 'kiz_orman'] },
  rare_chest: { cost: 9000, rewards: ['dragon', 'phoenix', 'kiz_ates', 'kiz_buz', 'skin_void', 'skin_moon', 'skin_amethyst', 'skin_icefire', 'skin_reef', 'skin_shadow', 'skin_thunder', 'yeti', 'robot', 'shark'] },
  ame_chest: { cost: 18000, rewards: ['kiz_ates', 'kiz_buz', 'kiz_samurai', 'skin_magma', 'skin_solar', 'skin_icefire', 'skin_thunder', 'skin_chroma', 'skin_void', 'kiz_karanlik', 'phoenix', 'dragon'] }
};
const cosmeticCatalog = [];
const COSMETIC_TYPES = new Set(['skin', 'axe', 'sword']);
const COSMETIC_RARITIES = new Set(['common', 'rare', 'epic', 'legendary', 'mythic']);
function loadCosmeticCatalog() {
  if (!sqliteDb) return;
  try {
    const row = sqliteDb.prepare('SELECT state_json FROM game_state WHERE state_key = ?').get('cosmetic_catalog');
    if (!row) return;
    const saved = JSON.parse(row.state_json);
    if (Array.isArray(saved)) cosmeticCatalog.push(...saved.filter(item => item && item.id && COSMETIC_TYPES.has(item.type)));
  } catch (_) {}
}
function saveCosmeticCatalog() {
  if (!sqliteDb) return false;
  try {
    sqliteDb.prepare('INSERT INTO game_state (state_key, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at').run('cosmetic_catalog', JSON.stringify(cosmeticCatalog), Date.now());
    return true;
  } catch (_) { return false; }
}
function publicCosmetic(item) {
  return { id: item.id, type: item.type, name: item.name, rarity: item.rarity, color: item.color, asset: item.asset, price: item.price, chests: [...(item.chests || [])], createdAt: item.createdAt };
}
loadCosmeticCatalog();
const CHEST_LEGENDARY_REWARDS = new Set([
  'dragon', 'phoenix', 'kiz_ates', 'kiz_buz', 'kiz_samurai', 'kiz_orman', 'kiz_karanlik',
  'skin_magma', 'skin_solar', 'skin_void', 'skin_cyber', 'skin_icefire', 'skin_thunder', 'skin_chroma'
]);

function chestRewardWeight(rewardId) {
  if (CHEST_LEGENDARY_REWARDS.has(rewardId)) return 0.05;
  if (String(rewardId).startsWith('skin_')) return 0.22;
  return 1;
}

function chooseChestReward(rewards) {
  const totalWeight = rewards.reduce((sum, rewardId) => sum + chestRewardWeight(rewardId), 0);
  let roll = Math.random() * totalWeight;
  for (const rewardId of rewards) {
    roll -= chestRewardWeight(rewardId);
    if (roll <= 0) return rewardId;
  }
  return rewards[rewards.length - 1];
}

const RANKS = Array.from({ length: 100 }, (_, index) => index === 0 ? 0 : Math.round(500 * Math.pow(index, 2.05)));
const RANK_NAMES = ['Tohum', 'Taş', 'Köylü', 'Acemi', 'Savaşçı', 'Muhafız', 'Ateş Efendisi', 'Kristal', 'Fırtına', 'Gece Hanı', 'Efsane', 'Tanrısal'];

function rankInfo(xp) {
  let rankId = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i]) rankId = i;
    else break;
  }
  const currentMin = RANKS[rankId];
  const isMaxRank = rankId >= RANKS.length - 1;
  const nextMin = isMaxRank ? currentMin : RANKS[rankId + 1];
  const xpProgress = isMaxRank ? 1 : Math.max(0, Math.min(1, (xp - currentMin) / (nextMin - currentMin)));
  const xpToNextRank = isMaxRank ? 0 : Math.max(0, nextMin - xp);
  return {
    rankId,
    visualRankId: Math.min(11, Math.floor((rankId / Math.max(1, RANKS.length - 1)) * 12)),
    level: rankId + 1,
    name: RANK_NAMES[rankId % RANK_NAMES.length],
    minXP: currentMin,
    nextMinXP: nextMin,
    xpProgress: Math.round(xpProgress * 100) / 100,
    xpToNextRank
  };
}

function dailyQuestDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dailyRewardState(user, timestamp = Date.now()) {
  const current = user.dailyReward && typeof user.dailyReward === 'object' ? user.dailyReward : {};
  const day = Number(current.day);
  const today = dailyQuestDayKey(timestamp);
  const claimedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(current.claimedDate || '')) ? String(current.claimedDate) : '';
  const isNewDay = Boolean(claimedDate && claimedDate !== today);
  const currentDay = Number.isInteger(day) ? Math.max(1, Math.min(7, day)) : 1;
  const nextDay = isNewDay ? (currentDay >= 7 ? 1 : currentDay + 1) : currentDay;
  return {
    day: nextDay,
    claimedDate: isNewDay ? '' : claimedDate
  };
}

function dailyQuestExpiry(timestamp = Date.now()) {
  const nextDay = new Date(timestamp);
  nextDay.setUTCHours(24, 0, 0, 0);
  return nextDay.getTime();
}

function buildDailyQuestSnapshot(identity, timestamp = Date.now()) {
  const dayKey = dailyQuestDayKey(timestamp);
  const seed = crypto.createHash('sha256').update(`${identity}:${dayKey}`).digest('hex');
  const orderPool = pool => pool.slice().sort((a, b) => {
    const aHash = crypto.createHash('sha256').update(`${seed}:${a.id}`).digest('hex');
    const bHash = crypto.createHash('sha256').update(`${seed}:${b.id}`).digest('hex');
    return aHash.localeCompare(bHash);
  });
  const selected = [
    ...orderPool(DAILY_QUEST_POOL.filter(quest => quest.difficulty === 'easy')).slice(0, 3),
    ...orderPool(DAILY_QUEST_POOL.filter(quest => quest.difficulty === 'medium')).slice(0, 3),
    ...orderPool(DAILY_QUEST_POOL.filter(quest => quest.difficulty === 'hard')).slice(0, 4)
  ];
  return {
    dayKey,
    expiresAt: dailyQuestExpiry(timestamp),
    tasks: selected.map(quest => ({ ...quest, progress: 0, claimed: false }))
  };
}

function ensureDailyQuests(user, identity = 'guest') {
  const today = dailyQuestDayKey();
  if (!user.dailyQuests || user.dailyQuests.dayKey !== today || !Array.isArray(user.dailyQuests.tasks) || user.dailyQuests.tasks.length !== 10) {
    user.dailyQuests = buildDailyQuestSnapshot(identity);
  }
  return user.dailyQuests;
}

function ensureUltraQuests(user) {
  if (!user.ultraQuests || !Array.isArray(user.ultraQuests.tasks) || user.ultraQuests.tasks.length !== ULTRA_QUESTS.length) {
    const previous = new Map((user.ultraQuests?.tasks || []).map(task => [task.id, task]));
    user.ultraQuests = {
      tasks: ULTRA_QUESTS.map(quest => ({
        ...quest,
        progress: Math.min(quest.target, Number(previous.get(quest.id)?.progress || 0)),
        claimed: Boolean(previous.get(quest.id)?.claimed)
      }))
    };
  }
  return user.ultraQuests;
}

function applyDailyQuestProgress(user, deltas = {}) {
  const normalizedDeltas = {};
  for (const [key, rawValue] of Object.entries(deltas || {})) {
    const delta = Math.min(1000000, Math.max(0, Number(rawValue) || 0));
    if (delta > 0) normalizedDeltas[key] = delta;
  }
  user.questProgress = { ...(user.questProgress || {}) };
  for (const [key, delta] of Object.entries(normalizedDeltas)) {
    user.questProgress[key] = Math.max(0, Number(user.questProgress[key]) || 0) + delta;
  }
  const daily = ensureDailyQuests(user, usernameKey(user.username));
  for (const task of daily.tasks) {
    const delta = normalizedDeltas[task.key] || 0;
    if (delta > 0) task.progress = Math.min(task.target, Number(task.progress || 0) + delta);
  }
  const ultra = ensureUltraQuests(user);
  for (const task of ultra.tasks) {
    const delta = normalizedDeltas[task.key] || 0;
    if (delta > 0) task.progress = Math.min(task.target, Number(task.progress || 0) + delta);
  }
  return daily;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

let accountData = { users: {}, clans: {}, leaderboard: {}, recentDeaths: [], nextId: 1 };

function readSqliteSnapshot() {
  if (!sqliteDb) return null;
  try {
    const row = sqliteDb.prepare('SELECT state_json FROM game_state WHERE state_key = ?').get('account');
    return row ? JSON.parse(row.state_json) : null;
  } catch (error) {
    databaseLastError = error.message;
    console.warn(`[Database] SQLite read failed: ${error.message}`);
    return null;
  }
}

function writeSqliteSnapshot(snapshot) {
  if (!sqliteDb) return false;
  try {
    sqliteDb.prepare('INSERT INTO game_state (state_key, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at').run('account', JSON.stringify(snapshot), Date.now());
    databaseLastError = null;
    return true;
  } catch (error) {
    databaseLastError = error.message;
    console.warn(`[Database] SQLite write failed: ${error.message}`);
    return false;
  }
}

const BASILISK_USERNAME_KEY = 'basilisk';
function canUseThor(user) {
  return Boolean(user && usernameKey(user.username) === BASILISK_USERNAME_KEY);
}

function ownedItemsForUser(user, items) {
  const ownedItems = Array.isArray(items) ? [...new Set(items.map(String))] : [];
  return canUseThor(user) ? ownedItems : ownedItems.filter(itemId => itemId !== 'thor');
}

function equippedItemsForUser(user, items) {
  const equippedItems = items && typeof items === 'object' ? { ...items } : {};
  if (!canUseThor(user)) {
    if (equippedItems.deriler === 'thor') equippedItems.deriler = 'wolf';
    if (equippedItems.profil_avatar === 'thor') equippedItems.profil_avatar = 'wolf';
  }
  return equippedItems;
}

function loadAccountData() {
  const parsed = readSqliteSnapshot();
  if (parsed && typeof parsed === 'object') {
    const rawUsers = parsed.users || {};
    const cleanUsers = {};
    for (const [k, u] of Object.entries(rawUsers)) {
      if (u && typeof u === 'object' && u.username && (u.hash || u.password)) {
        const uKey = String(u.username).trim().toLowerCase();
        const loadedUser = {
          id: u.id || 1,
          username: u.username,
          email: u.email || '',
          salt: u.salt || '',
          hash: u.hash || '',
          rankId: rankInfo(Number(u.xp || 0)).rankId,
          xp: Math.max(0, Number(u.xp || 0)),
          coins: Math.max(0, Number(u.coins ?? u.gold ?? 0)),
          gold: Math.max(0, Number(u.coins ?? u.gold ?? 0)),
          kills: Math.max(0, Number(u.kills || 0)),
          deaths: Math.max(0, Number(u.deaths || 0)),
          games: Math.max(0, Number(u.gamesPlayed || u.games || 0)),
          gamesPlayed: Math.max(0, Number(u.gamesPlayed || u.games || 0)),
          score: Math.max(0, Number(u.score || 0)),
          bestScore: Math.max(0, Number(u.bestScore || u.score || 0)),
          timePlayed: Math.max(0, Number(u.timePlayed || 0)),
          ownedItems: [],
          equippedItems: {},
          questProgress: (u.questProgress && typeof u.questProgress === 'object') ? { ...u.questProgress } : {},
          claimedQuests: Array.isArray(u.claimedQuests) ? [...new Set(u.claimedQuests)] : [],
          dailyQuests: (u.dailyQuests && typeof u.dailyQuests === 'object') ? u.dailyQuests : null,
          ultraQuests: (u.ultraQuests && typeof u.ultraQuests === 'object') ? u.ultraQuests : null,
          dailyReward: (u.dailyReward && typeof u.dailyReward === 'object') ? u.dailyReward : null,
          claimedLevelRewards: Array.isArray(u.claimedLevelRewards) ? [...new Set(u.claimedLevelRewards.map(Number).filter(Number.isInteger))] : [],
          settings: (u.settings && typeof u.settings === 'object') ? { ...u.settings } : {},
          createdAt: u.createdAt || Date.now(),
          lastLoginAt: u.lastLoginAt || Date.now(),
          lastMatchAt: u.lastMatchAt || u.lastLoginAt || u.createdAt || Date.now()
        };
        loadedUser.ownedItems = ownedItemsForUser(loadedUser, u.ownedItems);
        loadedUser.equippedItems = equippedItemsForUser(loadedUser, u.equippedItems);
        cleanUsers[uKey] = loadedUser;
      }
    }
    accountData = {
      users: cleanUsers,
      clans: parsed.clans || {},
      leaderboard: parsed.leaderboard || {},
      recentDeaths: Array.isArray(parsed.recentDeaths) ? parsed.recentDeaths : [],
      nextId: Math.max(parsed.nextId || 1, Object.keys(cleanUsers).length + 1),
      xpResetVersion: Number(parsed.xpResetVersion || 0),
      coinResetVersion: Number(parsed.coinResetVersion || 0)
    };
    console.log(`[Database] Loaded ${Object.keys(cleanUsers).length} users and ${Object.keys(accountData.clans).length} clans.`);
  } else {
    console.log('[Database] Starting with fresh database.');
    accountData = { users: {}, clans: {}, leaderboard: {}, recentDeaths: [], nextId: 1, coinResetVersion: 0 };
  }

  if (Object.keys(accountData.users || {}).length === 0) {
    const ownerCreds = getOwnerCredentials();
    const username = ownerCreds.username || 'owner';
    const password = ownerCreds.password || 'admin';
    const seed = hashPassword(password);
    const key = usernameKey(username);
    accountData.users = {
      [key]: {
        id: 1,
        username,
        email: 'owner@forestbrawl.local',
        salt: seed.salt,
        hash: seed.hash,
        rankId: rankInfo(0).rankId,
        xp: 0,
        coins: 0,
        gold: 0,
        kills: 0,
        deaths: 0,
        games: 0,
        gamesPlayed: 0,
        score: 0,
        bestScore: 0,
        timePlayed: 0,
        ownedItems: [],
        equippedItems: {},
        questProgress: {},
        claimedQuests: [],
        dailyQuests: null,
        ultraQuests: null,
        dailyReward: { day: 1, claimedDate: '' },
        claimedLevelRewards: [],
        settings: {},
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
        lastMatchAt: Date.now(),
      }
    };
    accountData.nextId = 2;
    accountData.leaderboard = accountData.leaderboard || {};
    accountData.recentDeaths = Array.isArray(accountData.recentDeaths) ? accountData.recentDeaths : [];
    console.warn('[Database] Account snapshot missing; created environment-owner recovery account in account data.');
    writeSqliteSnapshot(accountData);
  }

  // Progress is never reset on startup. Version markers are retained only for
  // backwards compatibility with older snapshots; migrations must be additive.
  accountData.xpResetVersion = Math.max(Number(accountData.xpResetVersion) || 0, XP_RESET_VERSION);
  accountData.coinResetVersion = Math.max(Number(accountData.coinResetVersion) || 0, COIN_RESET_VERSION);
  writeSqliteSnapshot(accountData);
}

loadAccountData();

function ensureOwnerAccountMatchesEnvironment() {
  const ownerCreds = getOwnerCredentials();
  const username = String(ownerCreds.username || 'owner').trim();
  const password = String(ownerCreds.password || 'admin').trim();
  if (!username || !password) {
    console.warn('[Owner] OWNER_USERNAME and OWNER_PASSWORD must be configured in the environment.');
    return;
  }

  const userKey = usernameKey(username);
  const seeded = hashPassword(password);
  const existing = accountData.users?.[userKey] || Object.values(accountData.users || {}).find(user => usernameKey(user.username) === userKey);

  if (existing) {
    existing.username = username;
    existing.email = existing.email || 'owner@forestbrawl.local';
    existing.salt = seeded.salt;
    existing.hash = seeded.hash;
    existing.lastLoginAt = existing.lastLoginAt || Date.now();
    existing.lastMatchAt = existing.lastMatchAt || Date.now();
    console.log(`[Owner] Synced owner account ${username} from environment credentials.`);
  } else {
    const id = Math.max(1, Number(accountData.nextId) || 1);
    const user = {
      id,
      username,
      email: 'owner@forestbrawl.local',
      salt: seeded.salt,
      hash: seeded.hash,
      rankId: rankInfo(0).rankId,
      xp: 0,
      coins: 0,
      gold: 0,
      kills: 0,
      deaths: 0,
      games: 0,
      gamesPlayed: 0,
      score: 0,
      bestScore: 0,
      timePlayed: 0,
      ownedItems: [],
      equippedItems: {},
      questProgress: {},
      claimedQuests: [],
      dailyQuests: null,
      ultraQuests: null,
      dailyReward: { day: 1, claimedDate: '' },
      claimedLevelRewards: [],
      settings: {},
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      lastMatchAt: Date.now(),
    };
    accountData.users[userKey] = user;
    accountData.nextId = id + 1;
    console.warn(`[Owner] Created owner account ${username} from environment credentials.`);
  }

  writeSqliteSnapshot(accountData);
}

ensureOwnerAccountMatchesEnvironment();
for (const clan of Object.values(accountData.clans || {})) clans.set(clan.id, clan);

let _saveTimeout = null;
let _saveInFlight = null;
let _saveQueued = false;

function flushSqliteSnapshot() {
  if (!sqliteDb) return false;
  try {
    accountData.users = { ...(accountData.users || {}) };
    accountData.clans = Object.fromEntries(clans);
    writeSqliteSnapshot(accountData);
    sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return true;
  } catch (error) {
    console.warn('[Database] SQLite flush failed:', error && error.message ? error.message : error);
    return false;
  }
}

function saveAccountData(immediate = false) {
  const doSave = async () => {
    if (_saveInFlight) {
      _saveQueued = true;
      return _saveInFlight;
    }
    try {
      _saveInFlight = Promise.resolve();
      accountData.users = { ...(accountData.users || {}) };
      accountData.clans = Object.fromEntries(clans);
      writeSqliteSnapshot(accountData);
      await _saveInFlight;
    } catch (error) {
      console.warn('Could not save account data:', error.message);
    } finally {
      _saveInFlight = null;
      if (_saveQueued) {
        _saveQueued = false;
        void doSave();
      }
    }
  };

  if (immediate) {
    if (_saveTimeout) { clearTimeout(_saveTimeout); _saveTimeout = null; }
    return doSave();
  } else {
    if (!_saveTimeout) {
      _saveTimeout = setTimeout(() => {
        _saveTimeout = null;
        doSave();
      }, 250);
    }
  }
}

async function gracefulShutdown(signalName = 'SIGTERM') {
  console.log(`[Server] ${signalName} received, forcing snapshot to SQLite.`);
  try {
    await saveAccountData(true);
    flushSqliteSnapshot();
  } catch (error) {
    console.warn(`[Server] Shutdown snapshot failed: ${error && error.message ? error.message : error}`);
  } finally {
    try {
      if (sqliteDb) sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (_) {}
    process.exit(0);
  }
}

function syncLivePlayerProgress(player) {
  const user = player?._authUser;
  if (!user || !user.username) return false;
  const score = Math.max(0, Number(player.score) || 0);
  const gold = Math.max(0, Number(player.gold) || 0);
  const kills = Math.max(0, Number(player.kills) || 0);
  const previous = `${user.score}|${user.gold}|${user.kills}|${user.bestScore}`;
  user.score = Math.max(Number(user.score) || 0, score);
  user.bestScore = Math.max(Number(user.bestScore) || 0, user.score);
  user.gold = Math.max(Number(user.gold) || 0, gold);
  user.coins = user.gold;
  user.kills = Math.max(Number(user.kills) || 0, kills);
  user.rankId = rankInfo(Number(user.xp) || 0).rankId;
  const current = `${user.score}|${user.gold}|${user.kills}|${user.bestScore}`;
  return previous !== current;
}

function syncAllLivePlayerProgress() {
  let changed = false;
  for (const player of players.values()) changed = syncLivePlayerProgress(player) || changed;
  if (changed) saveAccountData();
}

// Auto-save every 20 seconds and flush on process exit
setInterval(() => {
  syncAllLivePlayerProgress();
  saveAccountData(true);
}, 20000);

process.on('SIGHUP', () => { void gracefulShutdown('SIGHUP'); });
process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('exit', () => {
  try {
    if (sqliteDb) {
      accountData.users = { ...(accountData.users || {}) };
      accountData.clans = Object.fromEntries(clans);
      writeSqliteSnapshot(accountData);
      sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
  } catch (_) {}
});
process.on('beforeExit', () => {
  try {
    if (sqliteDb) {
      accountData.users = { ...(accountData.users || {}) };
      accountData.clans = Object.fromEntries(clans);
      writeSqliteSnapshot(accountData);
      sqliteDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    }
  } catch (_) {}
});

function publicUser(user) {
  const rInfo = rankInfo(user.xp || 0);
  return {
    id: user.id,
    username: user.username,
    email: user.email || '',
    rankId: rInfo.rankId,
    rankName: rInfo.name,
    rankIcon: rInfo.icon,
    nextRankName: rInfo.rankId < RANKS.length - 1 ? RANK_NAMES[(rInfo.rankId + 1) % RANK_NAMES.length] : null,
    nextRankIcon: rInfo.nextIcon,
    level: rInfo.level,
    score: user.score || 0,
    bestScore: user.bestScore || user.score || 0,
    kills: user.kills || 0,
    deaths: user.deaths || 0,
    games: user.games || user.gamesPlayed || 0,
    gamesPlayed: user.gamesPlayed || user.games || 0,
    timePlayed: user.timePlayed || 0,
    xp: user.xp || 0,
    xpProgress: rInfo.xpProgress,
    xpToNextRank: rInfo.xpToNextRank,
    ownedItems: ownedItemsForUser(user, user.ownedItems),
    equippedItems: equippedItemsForUser(user, user.equippedItems),
    settings: user.settings || {},
    coins: user.coins ?? 0,
    gold: user.coins ?? 0,
    questProgress: user.questProgress || {},
    claimedQuests: user.claimedQuests || [],
    ultraQuests: user.ultraQuests || null,
    claimedLevelRewards: user.claimedLevelRewards || [],
    dailyReward: dailyRewardState(user),
    profileCosmetics: {
      avatarId: equippedItemsForUser(user, user.equippedItems).profil_avatar || 'wolf',
      skinId: equippedItemsForUser(user, user.equippedItems).deriler || 'wolf',
      effectId: user.equippedItems?.profil_efekt || user.equippedItems?.efektler || 'effect_none',
      frameId: user.equippedItems?.profil_cerceve || 'frame_woodland'
    },
    quests: QUESTS_LIST
  };
}

function profileResponse(user) {
  const rank = rankInfo(user.xp || 0);
  const nextRank = rank.rankId < RANKS.length - 1 ? { id: rank.rankId + 1, name: RANK_NAMES[rank.rankId + 1], minXP: rank.nextMinXP } : null;
  return {
    user: publicUser(user),
    rank,
    nextRank,
    level: rank.level,
    xp: user.xp || 0,
    xpProgress: rank.xpProgress,
    xpToNextRank: rank.xpToNextRank,
    currentRankIcon: rank.icon,
    nextRankIcon: rank.nextIcon,
    nextRankName: rank.rankId < RANKS.length - 1 ? RANK_NAMES[(rank.rankId + 1) % RANK_NAMES.length] : null
  };
}

function usernameKey(username) { return String(username || '').trim().toLocaleLowerCase('tr-TR'); }
function loginIdentifier(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function findUserForLogin(identifier) {
  const normalized = loginIdentifier(identifier);
  return Object.values(accountData.users).find(user => loginIdentifier(user.username) === normalized || (user.email && loginIdentifier(user.email) === normalized)) || null;
}

function createToken(user) {
  const payload = {
    u: user.username,
    id: user.id,
    iat: Date.now()
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url');
  const token = `${encoded}.${signature}`;
  sessions.set(token, usernameKey(user.username));
  return token;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const directUsername = sessions.get(token);
  if (directUsername && accountData.users[directUsername]) {
    return accountData.users[directUsername];
  }
  if (!token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  try {
    const expectedSig = crypto.createHmac('sha256', authSecret).update(encoded).digest('base64url');
    if (signature.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }
    const decodedStr = Buffer.from(encoded, 'base64url').toString('utf8');
    let username = '';
    if (decodedStr.startsWith('{')) {
      const parsed = JSON.parse(decodedStr);
      username = parsed.u;
    } else {
      username = decodedStr;
    }
    const key = usernameKey(username);
    const user = accountData.users[key];
    if (user) {
      sessions.set(token, key);
      return user;
    }
  } catch (e) {
    return null;
  }
  return null;
}

function getAuthUser(request) {
  const header = request.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (header || '');
  return verifyToken(token);
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => { body += chunk; if (body.length > 100000) reject(new Error('payload too large')); });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('invalid json')); } });
    request.on('error', reject);
  });
}

function recordDeathScore(name, score, gold, kills, timeAlive, userObj, updateUser = true) {
  const cleanName = String(name || 'forestbrawl').trim().slice(0, 20) || 'forestbrawl';
  const numScore = Math.max(0, Number(score) || 0);
  const numGold = Math.max(0, Number(gold) || 0);
  const numKills = Math.max(0, Number(kills) || 0);
  const numTime = Math.max(0, Number(timeAlive) || 0);
  const now = Date.now();

  const user = userObj || null;
  if (user && user.username && updateUser) {
    user.gold = Math.max(user.gold || 0, numGold);
    user.coins = Math.max(user.coins || 0, numGold);
    user.score = Math.max(user.score || 0, numScore);
    user.bestScore = Math.max(user.bestScore || 0, user.score, numScore);
    user.kills = (user.kills || 0) + numKills;
    user.deaths = (user.deaths || 0) + 1;
    user.gamesPlayed = (user.gamesPlayed || user.games || 0) + 1;
    user.games = user.gamesPlayed;
    user.timePlayed = (user.timePlayed || 0) + numTime;
    user.lastMatchAt = now;
    const runXp = Math.max(0, Math.round((numKills * 60 + Math.min(numTime * 2, 600) + (numScore > 0 ? Math.floor(Math.sqrt(numScore) * 8) : 0)) * MATCH_XP_RATE));
    user.xp = (user.xp || 0) + runXp;
    user.rankId = rankInfo(user.xp).rankId;
    saveAccountData(true);
  }

  if (!accountData.leaderboard) accountData.leaderboard = {};
  const leadKey = user ? usernameKey(user.username) : usernameKey(cleanName);
  const prev = accountData.leaderboard[leadKey];
  const userXp = user ? (user.xp || 0) : (prev ? (prev.xp || 0) : 0);
  const rInfo = rankInfo(userXp);

  const highestScore = prev ? Math.max(prev.score || 0, numScore) : numScore;
  const highestGold = prev ? Math.max(prev.gold || 0, numGold) : numGold;
  const highestKills = prev ? Math.max(prev.kills || 0, numKills) : numKills;

  accountData.leaderboard[leadKey] = {
    name: user ? user.username : cleanName,
    xp: userXp,
    score: highestScore,
    gold: highestGold,
    kills: highestKills,
    rankId: rInfo.rankId,
    rankName: rInfo.name,
    lastScore: numScore,
    lastGold: numGold,
    lastKills: numKills,
    lastTimeAlive: numTime,
    lastDate: now,
    lastMatchAt: now,
    profileCosmetics: {
      avatarId: user?.equippedItems?.profil_avatar || 'wolf',
        skinId: user?.equippedItems?.deriler || 'wolf',
      effectId: user?.equippedItems?.profil_efekt || user?.equippedItems?.efektler || 'effect_none',
      frameId: user?.equippedItems?.profil_cerceve || 'frame_woodland'
    },
    isRegistered: !!(user && user.hash)
  };

  if (!Array.isArray(accountData.recentDeaths)) accountData.recentDeaths = [];
  accountData.recentDeaths.unshift({
    name: user ? user.username : cleanName,
    score: numScore,
    gold: numGold,
    kills: numKills,
    rankId: rInfo.rankId,
    rankName: rInfo.name,
    timeAlive: numTime,
    date: now,
    lastMatchAt: now,
    profileCosmetics: {
      avatarId: user?.equippedItems?.profil_avatar || 'wolf',
      skinId: user?.equippedItems?.deriler || 'wolf',
      effectId: user?.equippedItems?.profil_efekt || user?.equippedItems?.efektler || 'effect_none',
      frameId: user?.equippedItems?.profil_cerceve || 'frame_woodland'
    },
    isRegistered: !!(user && user.hash)
  });
  if (accountData.recentDeaths.length > 50) {
    accountData.recentDeaths.length = 50;
  }

  saveAccountData();
}

function persistPlayerScore(player) {
  if (!player || !player.name) return;
  recordDeathScore(player.name, player.score || player.gold, player.gold, player.kills, 0, player._authUser, false);
}

function leaderboard(tab) {
  const safeNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  if (tab === 'recent') {
    return (Array.isArray(accountData.recentDeaths) ? accountData.recentDeaths : []).map(entry => {
      const user = accountData.users?.[usernameKey(entry.name)];
      const currentRank = user ? rankInfo(user.xp || 0) : null;
      const profileCosmetics = user ? {
        avatarId: user.equippedItems?.profil_avatar || 'wolf',
        skinId: user.equippedItems?.deriler || 'wolf',
        effectId: user.equippedItems?.profil_efekt || user.equippedItems?.efektler || 'effect_none',
        frameId: user.equippedItems?.profil_cerceve || 'frame_woodland'
      } : (entry.profileCosmetics || { avatarId: 'wolf', effectId: 'effect_none', frameId: 'frame_woodland' });

      return {
        ...entry,
        xp: safeNumber(user?.xp ?? entry.xp ?? 0),
        rankId: currentRank?.rankId ?? safeNumber(entry.rankId ?? 0),
        rankName: currentRank?.name || entry.rankName || 'Tohum',
        level: currentRank?.level ?? Math.max(1, safeNumber(entry.rankId ?? 0) + 1),
        lastMatchAt: safeNumber(entry.lastMatchAt || entry.date || 0),
        playerKills: safeNumber(entry.playerKills ?? entry.kills ?? 0),
        minutesAgo: entry.date ? Math.max(0, Math.floor((Date.now() - safeNumber(entry.date)) / 60000)) : null,
        profileCosmetics
      };
    }).sort((a, b) => safeNumber(b.lastMatchAt) - safeNumber(a.lastMatchAt)).slice(0, 50).map((entry, index) => ({ ...entry, position: index + 1 }));
  }

  const allMap = new Map();
  // 1. Registered users
  for (const user of Object.values(accountData.users || {})) {
    const key = usernameKey(user.username);
    const rInfo = rankInfo(user.xp || 0);
    const savedLeaderboardEntry = accountData.leaderboard?.[key];
    allMap.set(key, {
      name: user.username,
      xp: safeNumber(user.xp || 0),
      score: Math.max(safeNumber(user.bestScore), safeNumber(user.score), safeNumber(user.gold)),
      gold: safeNumber(savedLeaderboardEntry?.gold ?? user.gold ?? user.coins ?? 0),
      kills: safeNumber(user.kills || 0),
      playerKills: safeNumber(user.kills || 0),
      rankId: rInfo.rankId,
      rankName: rInfo.name,
      level: rInfo.level,
      lastDate: safeNumber(user.lastLoginAt || Date.now()),
      lastMatchAt: safeNumber(user.lastMatchAt || user.lastLoginAt || user.createdAt || Date.now()),
      gamesPlayed: safeNumber(user.gamesPlayed || user.games || 0),
      timePlayed: safeNumber(user.timePlayed || 0),
      profileCosmetics: {
        avatarId: user.equippedItems?.profil_avatar || 'wolf',
        skinId: user.equippedItems?.deriler || 'wolf',
        effectId: user.equippedItems?.profil_efekt || user.equippedItems?.efektler || 'effect_none',
        frameId: user.equippedItems?.profil_cerceve || 'frame_woodland'
      },
      isRegistered: true
    });
  }

  // 2. Guest leaderboard records
  for (const [key, entry] of Object.entries(accountData.leaderboard || {})) {
    if (!allMap.has(key)) {
      allMap.set(key, {
        ...entry,
        xp: safeNumber(entry.xp || 0),
        score: safeNumber(entry.score || 0),
        gold: safeNumber(entry.gold || 0),
        kills: safeNumber(entry.kills || 0),
        playerKills: safeNumber(entry.playerKills ?? entry.kills ?? 0),
        lastMatchAt: safeNumber(entry.lastMatchAt || entry.date || 0),
        profileCosmetics: entry.profileCosmetics || { avatarId: 'wolf', effectId: 'effect_none', frameId: 'frame_woodland' }
      });
    } else {
      const existing = allMap.get(key);
      existing.score = Math.max(existing.score, safeNumber(entry.score || 0));
      existing.xp = Math.max(existing.xp || 0, safeNumber(entry.xp || 0));
      existing.gold = Math.max(existing.gold, safeNumber(entry.gold || 0));
      existing.kills = Math.max(existing.kills, safeNumber(entry.kills || 0));
      existing.playerKills = existing.kills;
      existing.lastMatchAt = Math.max(existing.lastMatchAt || 0, safeNumber(entry.lastMatchAt || entry.date || 0));
    }
  }

  const list = [...allMap.values()];
  if (tab === 'kills') list.sort((a, b) => safeNumber(b.playerKills ?? b.kills ?? 0) - safeNumber(a.playerKills ?? a.kills ?? 0));
  else list.sort((a, b) => safeNumber(b.gold) - safeNumber(a.gold) || safeNumber(b.score) - safeNumber(a.score) || safeNumber(b.xp) - safeNumber(a.xp));

  return list.slice(0, 50).map((entry, index) => ({
    ...entry,
    position: index + 1,
    playerKills: safeNumber(entry.playerKills ?? entry.kills ?? 0),
    minutesAgo: safeNumber(entry.lastMatchAt) ? Math.max(0, Math.floor((Date.now() - safeNumber(entry.lastMatchAt)) / 60000)) : null,
  }));
}

async function handleApi(request, response, requestPath) {
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); response.end(); return true; }
  if (!requestPath.startsWith('/api/')) return false;
  if (requestPath === '/api/owner/login' && request.method === 'POST') {
    const ownerCreds = getOwnerCredentials();
    if (authRateLimited(request, 'login')) {
      sendJson(response, 429, { error: 'Çok fazla deneme. Daha sonra tekrar deneyin.' });
      return true;
    }
    let body;
    try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz istek.' }); return true; }
    if (!body || typeof body !== 'object') {
      sendJson(response, 400, { error: 'Geçersiz istek.' });
      return true;
    }
    const incomingUsername = String(body.username || '').trim().toLowerCase();
    const incomingPassword = String(body.password || '').trim();
    const usernameMatches = timingSafeEqualText(incomingUsername, ownerCreds.username);
    const passwordMatches = timingSafeEqualText(incomingPassword, ownerCreds.password);
    if (!usernameMatches || !passwordMatches) {
      ownerAudit('owner_login_failed', { ip: requestClientKey(request), username: incomingUsername });
      console.warn(`[OwnerLogin] denied ip=${requestClientKey(request)} username=${incomingUsername} usernameMatches=${usernameMatches} passwordMatches=${passwordMatches} passwordLength=${incomingPassword.length}`);
      sendJson(response, 401, { error: 'Owner bilgileri geçersiz.' });
      return true;
    }
    const token = ownerTokenFor(ownerCreds.username);
    ownerSessions.set(token, { username: ownerCreds.username, role: 'owner', createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + ownerSessionTtl });
    ownerAudit('owner_login', { username: ownerCreds.username, ip: requestClientKey(request) });
    sendJson(response, 200, { token, user: { username: ownerCreds.username, role: 'owner', expiresAt: Date.now() + ownerSessionTtl } });
    return true;
  }
  if (requestPath === '/api/owner/logout' && request.method === 'POST') {
    const session = getOwnerSession(request);
    const token = String(request.headers.authorization || '').replace(/^Bearer\s+/, '');
    if (session) ownerAudit('owner_logout', { username: session.username });
    ownerSessions.delete(token);
    sendJson(response, 200, { ok: true });
    return true;
  }
  if (requestPath === '/api/owner/me' && request.method === 'GET') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    sendJson(response, 200, { user: { username: session.username, role: session.role, expiresAt: session.expiresAt } });
    return true;
  }
  if (requestPath === '/api/owner/dashboard' && request.method === 'GET') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    const registeredUsers = Object.values(accountData.users || {});
    const mem = process.memoryUsage();
    sendJson(response, 200, {
      stats: {
        online: players.size,
        buildings: buildings.size,
        mobs: mobs.size,
        registeredUsers: registeredUsers.length,
        clans: clans.size,
        parties: parties.size,
        database: Boolean(sqliteDb),
        maintenance: adminConfig.maintenance,
        pvpEnabled: adminConfig.pvpEnabled,
        uptimeSec: Math.floor(process.uptime()),
        ramMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
        bannedCount: bannedList.size
      },
      players: [...players.values()].map(player => ({
        id: player.id,
        name: player.name || 'Oyuncu',
        hp: Number(player.hp || 0),
        maxHp: Number(player.maxHp || 250),
        score: Number(player.score || 0),
        gold: Number(player.gold || 0),
        xp: Number(player.xp || 0),
        kills: Number(player.kills || 0),
        x: Math.round(Number(player.x || 0)),
        y: Math.round(Number(player.y || 0)),
        skin: player.skin || 'default',
        frozen: Boolean(player._ownerFrozen),
        clanTag: player.clanTag || '',
        team: player.team || ''
      })),
      config: adminConfig,
      audit: ownerAuditLog.slice(0, 50),
      banned: [...bannedList]
    });
    return true;
  }
  if (requestPath === '/api/owner/users' && request.method === 'GET') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    const query = String(new URL(request.url || '/', 'http://localhost').searchParams.get('q') || '').trim().toLowerCase();
    const users = Object.values(accountData.users || {}).filter(user => !query || `${user.username} ${user.email || ''}`.toLowerCase().includes(query)).slice(0, 200).map(user => ({
      id: user.id, username: user.username, email: user.email || '', xp: Number(user.xp || 0), coins: Number(user.coins || user.gold || 0), kills: Number(user.kills || 0), deaths: Number(user.deaths || 0), gamesPlayed: Number(user.gamesPlayed || user.games || 0), ownedItems: Array.isArray(user.ownedItems) ? user.ownedItems.length : 0, lastLoginAt: user.lastLoginAt || null, createdAt: user.createdAt || null
    }));
    sendJson(response, 200, { users });
    return true;
  }
  if (requestPath === '/api/owner/user-edit' && request.method === 'POST') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    let body;
    try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz istek.' }); return true; }
    const targetId = Number(body.userId);
    const targetUsername = String(body.username || '').trim();
    const user = Object.values(accountData.users || {}).find(u => u.id === targetId || usernameKey(u.username) === usernameKey(targetUsername));
    if (!user) { sendJson(response, 404, { error: 'Kullanıcı bulunamadı.' }); return true; }
    if (body.action === 'delete') {
      const uKey = usernameKey(user.username);
      delete accountData.users[uKey];
      saveAccountData(true);
      ownerAudit('user_deleted', { username: session.username, targetUser: user.username });
      sendJson(response, 200, { ok: true, deleted: true });
      return true;
    }
    if (body.coins !== undefined) {
      user.coins = Math.max(0, Math.min(100000000, Number(body.coins) || 0));
      user.gold = user.coins;
    }
    if (body.xp !== undefined) {
      user.xp = Math.max(0, Math.min(100000000, Number(body.xp) || 0));
      user.rankId = rankInfo(user.xp).rankId;
    }
    if (body.password && String(body.password).length >= 4) {
      const passObj = hashPassword(String(body.password));
      user.hash = passObj.hash;
      user.salt = passObj.salt;
    }
    saveAccountData(true);
    ownerAudit('user_updated', { username: session.username, targetUser: user.username, coins: user.coins, xp: user.xp });
    sendJson(response, 200, { ok: true, user: publicUser(user) });
    return true;
  }
  if (requestPath === '/api/owner/ban-list' && request.method === 'GET') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    sendJson(response, 200, { banned: [...bannedList] });
    return true;
  }
  if (requestPath === '/api/owner/ban' && request.method === 'POST') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    let body;
    try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz istek.' }); return true; }
    const target = String(body.target || '').trim();
    if (!target) { sendJson(response, 400, { error: 'Hedef belirtilmedi.' }); return true; }
    if (body.action === 'unban') {
      bannedList.delete(target);
      bannedList.delete(usernameKey(target));
      saveBannedList();
      ownerAudit('unbanned', { username: session.username, target });
      sendJson(response, 200, { ok: true, banned: [...bannedList] });
      return true;
    }
    bannedList.add(target);
    saveBannedList();
    ownerAudit('banned', { username: session.username, target });
    for (const [sId, p] of players) {
      if (p.name && (p.name.toLowerCase() === target.toLowerCase() || usernameKey(p.name) === usernameKey(target))) {
        const s = io.sockets.sockets.get(sId);
        s?.disconnect(true);
      }
    }
    sendJson(response, 200, { ok: true, banned: [...bannedList] });
    return true;
  }
  if (requestPath === '/api/cosmetics/catalog' && request.method === 'GET') {
    sendJson(response, 200, { items: cosmeticCatalog.map(publicCosmetic), rarities: [...COSMETIC_RARITIES], types: [...COSMETIC_TYPES] });
    return true;
  }
  if (requestPath === '/api/owner/cosmetics' && (request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE')) {
    const session = ownerRequired(request, response);
    if (!session) return true;
    if (request.method === 'GET') {
      sendJson(response, 200, { items: cosmeticCatalog.map(publicCosmetic), chests: Object.fromEntries(Object.entries(CHEST_CONFIG).map(([id, chest]) => [id, { cost: chest.cost, rewards: [...chest.rewards] }])) });
      return true;
    }
    let body;
    try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz kozmetik isteği.' }); return true; }
    const itemId = String(body.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
    if (!itemId || !COSMETIC_TYPES.has(body.type) || !COSMETIC_RARITIES.has(body.rarity)) { sendJson(response, 400, { error: 'ID, tür veya rarity geçersiz.' }); return true; }
    if (request.method === 'DELETE') {
      const index = cosmeticCatalog.findIndex(item => item.id === itemId);
      if (index < 0) { sendJson(response, 404, { error: 'Kozmetik bulunamadı.' }); return true; }
      cosmeticCatalog.splice(index, 1);
      for (const chest of Object.values(CHEST_CONFIG)) chest.rewards = chest.rewards.filter(reward => reward !== itemId);
      saveCosmeticCatalog();
      ownerAudit('cosmetic_deleted', { username: session.username, itemId });
      sendJson(response, 200, { ok: true });
      return true;
    }
    const item = { id: itemId, type: body.type, name: String(body.name || itemId).trim().slice(0, 40), rarity: body.rarity, color: String(body.color || '#b8f36b').slice(0, 20), asset: String(body.asset || `players/${itemId}.png`).trim().slice(0, 160), price: Math.max(0, Math.min(1000000, Number(body.price) || 0)), chests: Array.isArray(body.chests) ? body.chests.filter(chestId => Object.prototype.hasOwnProperty.call(CHEST_CONFIG, chestId)) : [], createdAt: Date.now() };
    const existing = cosmeticCatalog.findIndex(entry => entry.id === itemId);
    if (existing >= 0) cosmeticCatalog[existing] = item;
    else cosmeticCatalog.push(item);
    for (const [chestId, chest] of Object.entries(CHEST_CONFIG)) chest.rewards = chest.rewards.filter(reward => reward !== itemId);
    for (const chestId of item.chests) if (!CHEST_CONFIG[chestId].rewards.includes(itemId)) CHEST_CONFIG[chestId].rewards.push(itemId);
    saveCosmeticCatalog();
    ownerAudit(existing >= 0 ? 'cosmetic_updated' : 'cosmetic_created', { username: session.username, itemId, type: item.type, rarity: item.rarity });
    sendJson(response, 200, { ok: true, item: publicCosmetic(item) });
    return true;
  }
  if (requestPath === '/api/owner/config' && (request.method === 'GET' || request.method === 'POST')) {
    const session = ownerRequired(request, response);
    if (!session) return true;
    if (request.method === 'POST') {
      let body;
      try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz ayar isteği.' }); return true; }
      const allowed = ['maintenance', 'pvpEnabled', 'xpRate', 'mobSpawnMultiplier', 'resourceRespawnMultiplier'];
      const previous = { ...adminConfig };
      for (const key of allowed) {
        if (body[key] === undefined) continue;
        if (typeof adminConfig[key] === 'boolean') adminConfig[key] = Boolean(body[key]);
        else adminConfig[key] = Math.max(0.1, Math.min(20, Number(body[key]) || 1));
      }
      ownerAudit('config_updated', { username: session.username, previous, next: { ...adminConfig } });
      saveAdminConfig();
      io.emit('owner_config_updated', { pvpEnabled: adminConfig.pvpEnabled, maintenance: adminConfig.maintenance });
    }
    sendJson(response, 200, { config: adminConfig });
    return true;
  }
  if (requestPath === '/api/owner/announce' && request.method === 'POST') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    let body;
    try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz duyuru.' }); return true; }
    if (body.clear) {
      adminConfig.announcement = '';
      saveAdminConfig();
      ownerAudit('announcement_cleared', { username: session.username });
      io.emit('server_announce_clear', {});
      sendJson(response, 200, { ok: true, cleared: true });
      return true;
    }
    const message = String(body.message || '').trim().slice(0, 300);
    if (!message) { sendJson(response, 400, { error: 'Duyuru boş olamaz.' }); return true; }
    const title = String(body.title || 'FORESTBRAWL DUYURUSU').trim().slice(0, 60);
    const level = ['info', 'warning', 'event', 'reward'].includes(body.level) ? body.level : 'info';
    const sound = ['bell', 'horn', 'fanfare', 'siren', 'none'].includes(body.sound) ? body.sound : 'bell';
    const durationMs = Math.max(500, Math.min(3000, Number(body.durationMs ?? 3000)));
    adminConfig.announcement = message;
    saveAdminConfig();
    ownerAudit('announcement_sent', { username: session.username, message, title, level, sound, durationMs });
    io.emit('server_announce', {
      message,
      msg: message,
      text: message,
      title,
      level,
      sound,
      durationMs,
      from: session.username.toUpperCase(),
      at: Date.now()
    });
    sendJson(response, 200, { ok: true, message, title, level, durationMs });
    return true;
  }
  if (requestPath === '/api/owner/player-action' && request.method === 'POST') {
    const session = ownerRequired(request, response);
    if (!session) return true;
    let body;
    try { body = await readJson(request); } catch (_) { sendJson(response, 400, { error: 'Geçersiz oyuncu işlemi.' }); return true; }
    const playerId = String(body.playerId || '');
    const player = players.get(playerId);
    const action = String(body.action || '');
    if (!player || !['kick', 'freeze', 'unfreeze', 'heal', 'kill', 'give_gold', 'give_xp', 'teleport', 'damage', 'ban'].includes(action)) { sendJson(response, 404, { error: 'Oyuncu veya işlem bulunamadı.' }); return true; }
    const targetSocket = io.sockets.sockets.get(playerId);
    if (action === 'kick') targetSocket?.disconnect(true);
    if (action === 'freeze') { player._ownerFrozen = true; player.vx = 0; player.vy = 0; }
    if (action === 'unfreeze') player._ownerFrozen = false;
    if (action === 'heal') { player.hp = player.maxHp || 250; targetSocket?.emit('self_state', { hp: player.hp, hpSeq: player.hpSeq || 0, hpAt: Date.now() }); }
    if (action === 'kill') { player.hp = 0; onPlayerDeath(playerId); targetSocket?.emit('player_take_damage', { id: playerId, hp: 0, dmg: player.maxHp || 250, sourceName: 'Owner' }); }
    if (action === 'damage') {
      const dmg = Math.max(1, Math.min(player.hp || 250, Number(body.amount) || 50));
      player.hp = Math.max(0, (player.hp || 250) - dmg);
      targetSocket?.emit('player_take_damage', { id: playerId, hp: player.hp, dmg, sourceName: 'Owner' });
      if (player.hp <= 0) onPlayerDeath(playerId);
    }
    if (action === 'give_gold') {
      const amount = Math.max(1, Math.min(1000000, Number(body.amount) || 1000));
      player.gold = (player.gold || 0) + amount;
      if (player._authUser) { player._authUser.coins = (player._authUser.coins || 0) + amount; player._authUser.gold = player._authUser.coins; saveAccountData(true); }
      targetSocket?.emit('self_state', { g: player.gold, sc: player.score });
      targetSocket?.emit('server_announce', { message: `🎁 Kurucu sana +${amount.toLocaleString('tr-TR')} Altın verdi!`, msg: `🎁 Kurucu sana +${amount.toLocaleString('tr-TR')} Altın verdi!`, text: `🎁 Kurucu sana +${amount.toLocaleString('tr-TR')} Altın verdi!`, level: 'reward', title: 'KURUCU ÖDÜLÜ' });
    }
    if (action === 'give_xp') {
      const amount = Math.max(1, Math.min(1000000, Number(body.amount) || 1000));
      player.xp = (player.xp || 0) + amount;
      if (player._authUser) { player._authUser.xp = (player._authUser.xp || 0) + amount; player._authUser.rankId = rankInfo(player._authUser.xp).rankId; saveAccountData(true); }
      targetSocket?.emit('self_state', { xp: player.xp });
      targetSocket?.emit('server_announce', { message: `⭐ Kurucu sana +${amount.toLocaleString('tr-TR')} XP verdi!`, msg: `⭐ Kurucu sana +${amount.toLocaleString('tr-TR')} XP verdi!`, text: `⭐ Kurucu sana +${amount.toLocaleString('tr-TR')} XP verdi!`, level: 'reward', title: 'KURUCU ÖDÜLÜ' });
    }
    if (action === 'teleport') {
      const targetX = Math.max(-7000, Math.min(7000, Number(body.x) || 0));
      const targetY = Math.max(-7000, Math.min(7000, Number(body.y) || 0));
      player.x = targetX;
      player.y = targetY;
      player.vx = 0;
      player.vy = 0;
      targetSocket?.emit('pos_correction', { x: targetX, y: targetY });
      targetSocket?.emit('self_state', { x: targetX, y: targetY });
    }
    if (action === 'ban') {
      const clientIp = requestClientKey(targetSocket?.request || { headers: {}, socket: targetSocket?.conn?.transport?.socket });
      bannedList.add(playerId);
      if (player.name) bannedList.add(usernameKey(player.name));
      if (clientIp && clientIp !== 'unknown') bannedList.add(clientIp);
      saveBannedList();
      targetSocket?.emit('server_announce', { message: 'Sunucudan yasaklandınız (Banned).', msg: 'Sunucudan yasaklandınız (Banned).', text: 'Sunucudan yasaklandınız (Banned).', level: 'warning', title: 'YASAKLANDINIZ' });
      targetSocket?.disconnect(true);
    }
    ownerAudit('player_action', { username: session.username, playerId, playerName: player.name, action, amount: body.amount });
    sendJson(response, 200, { ok: true, action, playerId });
    return true;
  }
  if (requestPath === '/api/health' && request.method === 'GET') {
    const databaseOk = Boolean(sqliteDb) && !databaseLastError;
    sendJson(response, databaseOk ? 200 : 503, { ok: databaseOk, database: databaseOk, online: io.engine.clientsCount });
    return true;
  }

  let body = {};
  if (request.method !== 'GET') { try { body = await readJson(request); } catch { sendJson(response, 400, { error: 'Geçersiz istek.' }); return true; } }

  if (requestPath === '/api/auth/register' && request.method === 'POST') {
    if (authRateLimited(request, 'register')) { response.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '3600' }); response.end(JSON.stringify({ error: 'Çok fazla kayıt denemesi. Lütfen daha sonra tekrar deneyin.' })); return true; }
    const username = String(body.username || '').trim();
    const key = usernameKey(username);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[a-zA-Z0-9_ TürkÇĞİÖŞÜçğıöşü-]{3,20}$/.test(username)) { sendJson(response, 400, { error: 'Kullanıcı adı 3-20 karakter olmalı.' }); return true; }
    if (!body.password || String(body.password).length < 4) { sendJson(response, 400, { error: 'Şifre en az 4 karakter olmalı.' }); return true; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { sendJson(response, 400, { error: 'Geçerli bir e-posta adresi gerekli.' }); return true; }
    if (accountData.users[key]) { sendJson(response, 409, { error: 'Bu kullanıcı adı zaten kayıtlı.' }); return true; }
    if (Object.values(accountData.users).some(user => String(user.email || '').trim().toLowerCase() === email)) { sendJson(response, 409, { error: 'Bu e-posta zaten kayıtlı.' }); return true; }
    const password = hashPassword(String(body.password));
    const initXp = Math.max(0, Math.min(1000000, Math.floor(Number(body.initialXp) || 0)));
    const initCoins = 0;
    const user = {
      id: accountData.nextId++,
      username,
      email,
      ...password,
      rankId: rankInfo(initXp).rankId,
      xp: initXp,
      score: Math.max(0, Number(body.initialScore) || 0),
      kills: Math.max(0, Number(body.initialKills) || 0),
      deaths: 0,
      games: 0,
      gamesPlayed: 0,
      bestScore: Math.max(0, Number(body.initialScore) || 0),
      timePlayed: Math.max(0, Number(body.initialTime) || 0),
      coins: initCoins,
      gold: initCoins,
      ownedItems: ownedItemsForUser(null, body.initialOwnedItems),
      equippedItems: equippedItemsForUser(null, body.initialEquippedItems),
      dailyReward: { day: 1, claimedDate: '' },
      claimedLevelRewards: [],
      settings: (body.initialSettings && typeof body.initialSettings === 'object') ? { ...body.initialSettings } : {},
      createdAt: Date.now(),
      lastLoginAt: Date.now(),
      lastMatchAt: Date.now()
    };
    accountData.users[key] = user;
    saveAccountData(true);
    sendJson(response, 201, { token: createToken(user), user: publicUser(user) });
    return true;
  }
  if (requestPath === '/api/auth/login' && request.method === 'POST') {
    if (authRateLimited(request, 'login')) { response.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '600' }); response.end(JSON.stringify({ error: 'Çok fazla giriş denemesi. Lütfen 10 dakika sonra tekrar deneyin.' })); return true; }
    const user = findUserForLogin(body.identifier || body.username);
    const password = String(body.password || '');
    const check = user && user.hash && user.salt && hashPassword(password, user.salt).hash;
    if (!user || !check || !crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(user.hash, 'hex'))) {
      sendJson(response, 401, { error: 'Kullanıcı adı veya şifre hatalı.' });
      return true;
    }
    user.lastLoginAt = Date.now();
    saveAccountData();
    sendJson(response, 200, { token: createToken(user), user: publicUser(user) });
    return true;
  }
  if (requestPath === '/api/auth/me' && request.method === 'GET') {
    const user = getAuthUser(request);
    if (!user) sendJson(response, 401, { error: 'Oturum geçersiz.' });
    else sendJson(response, 200, { user: publicUser(user) });
    return true;
  }
  if (requestPath === '/api/auth/logout' && request.method === 'POST') {
    const token = String(request.headers.authorization || '').replace(/^Bearer\s+/, '');
    sessions.delete(token);
    sendJson(response, 200, { ok: true });
    return true;
  }
  
  if (requestPath === '/api/leaderboard' && request.method === 'GET') {
    const tab = new URL(request.url, 'http://localhost').searchParams.get('tab') || 'all';
    sendJson(response, 200, {
      entries: leaderboard(tab),
      recent: leaderboard('recent'),
      top: leaderboard('all')
    });
    return true;
  }
  
  if (requestPath === '/api/leaderboard/submit' && request.method === 'POST') {
    const authUser = getAuthUser(request);
    const guestId = String(body.guestId || '').trim();
    const requestedName = String(body.name || '').trim().slice(0, 20);
    if (!authUser && (!guestId || !requestedName || accountData.users[usernameKey(requestedName)])) {
      sendJson(response, 400, { error: 'Geçerli bir misafir kimliği ve oyuncu adı gerekli.' });
      return true;
    }
    const pName = authUser ? authUser.username : requestedName;
    const pScore = Math.min(100000000, Math.max(0, Number(body.score || body.gold || 0)));
    const pGold = Math.min(100000000, Math.max(0, Number(body.gold || body.coins || 0)));
    const pKills = Math.min(100000, Math.max(0, Number(body.kills || 0)));
    const pTime = Math.min(86400, Math.max(0, Number(body.timeAlive || body.timePlayed || 0)));
    recordDeathScore(pName, pScore, pGold, pKills, pTime, authUser, false);
    sendJson(response, 200, { ok: true });
    return true;
  }

  const user = getAuthUser(request);
  if (requestPath === '/api/profile' && request.method === 'GET') {
    if (!user) {
      sendJson(response, 401, { error: 'Oturum gerekli.' });
    } else {
      sendJson(response, 200, profileResponse(user));
    }
    return true;
  }
  if (requestPath === '/api/profile/state' && request.method === 'POST') {
    if (!user) {
      sendJson(response, 401, { error: 'Oturum gerekli.' });
      return true;
    }
    if (authRateLimited(request, 'profile_state')) {
      sendJson(response, 429, { error: 'Profil güncelleme limiti aşıldı.' });
      return true;
    }
    if (body.settings && typeof body.settings === 'object') {
      user.settings = { ...(user.settings || {}) };
      for (const [key, value] of Object.entries(body.settings).slice(0, 50)) {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(key) && (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string')) {
          user.settings[key] = value;
        }
      }
    }
    if (body.equippedItems && typeof body.equippedItems === 'object') user.equippedItems = equippedItemsForUser(user, { ...(user.equippedItems || {}), ...body.equippedItems });
    saveAccountData(true);
    sendJson(response, 200, { ok: true, user: publicUser(user) });
    return true;
  }
  if (requestPath === '/api/profile/xp' && request.method === 'POST') {
    if (!user) {
      const gainedXp = Math.max(0, Math.min(600, Math.round(clampNumber(body.xp, 0, 0, 6000) * MATCH_XP_RATE)));
      const startXP = Math.max(0, Number(body.startXP) || 0);
      const startRank = rankInfo(startXP);
      sendJson(response, 200, {
        ok: true, isGuest: true, gainedXp, coinsEarned: 0,
        currentLevel: startRank.level, startXP, gainedXP: gainedXp,
        maxXPForCurrentLevel: Math.max(0, startRank.nextMinXP - startRank.minXP),
      });
      return true;
    }
    if (authRateLimited(request, 'profile_xp')) {
      sendJson(response, 429, { error: 'Maç sonucu gönderme limiti aşıldı.' });
      return true;
    }
    const reqXp = clampNumber(body.xp, 0, 0, 10000);
    const gainedXp = Math.max(0, Math.min(600, Math.round(reqXp * MATCH_XP_RATE)));
    const startXP = Math.max(0, Number(user.xp) || 0);
    const previousRank = rankInfo(user.xp || 0).rankId;
    const nextKills = clampNumber(body.kills, 0, 0, 5000);
    const nextDeaths = clampNumber(body.deaths, 0, 0, 5000);
    const nextTime = clampNumber(body.timePlayed, 0, 0, 36000);
    const nextScore = clampNumber(body.score, 0, 0, MAX_ACCOUNT_SCORE);

    user.xp = clampNumber((user.xp || 0) + gainedXp, 0, 0, MAX_ACCOUNT_XP);
    user.kills = (user.kills || 0) + nextKills;
    user.deaths = (user.deaths || 0) + nextDeaths;
    user.gamesPlayed = (user.gamesPlayed || user.games || 0) + 1;
    user.games = user.gamesPlayed;
    user.timePlayed = (user.timePlayed || 0) + nextTime;
    user.score = Math.max(user.score || 0, nextScore);
    user.bestScore = Math.max(user.bestScore || 0, user.score);
    const currentRank = rankInfo(user.xp);
    user.rankId = currentRank.rankId;

    saveAccountData(true);

    sendJson(response, 200, {
      ...profileResponse(user),
      newXp: user.xp,
      xpGained: gainedXp,
      rankUp: currentRank.rankId > previousRank,
      newRankName: currentRank.name,
      newRankIcon: currentRank.icon,
      currentLevel: previousRank + 1,
      startXP,
      gainedXP: gainedXp,
      maxXPForCurrentLevel: Math.max(0, rankInfo(startXP).nextMinXP - rankInfo(startXP).minXP),
    });
    return true;
  }
  if (requestPath === '/api/quests/list' && request.method === 'GET') {
    const questOwner = user || { dailyQuests: null };
    const daily = ensureDailyQuests(questOwner, user ? usernameKey(user.username) : `guest:${requestClientKey(request)}`);
    const ultra = user ? ensureUltraQuests(user) : { tasks: ULTRA_QUESTS.map(quest => ({ ...quest, progress: 0, claimed: false })) };
    if (user) saveAccountData();
    sendJson(response, 200, { dayKey: daily.dayKey, expiresAt: daily.expiresAt, serverNow: Date.now(), quests: daily.tasks, ultraQuests: ultra.tasks, user: user ? publicUser(user) : null });
    return true;
  }
  if (requestPath === '/api/quests/claim' && request.method === 'POST') {
    const questId = String(body.questId || '');
    const questType = body.questType === 'ultra' ? 'ultra' : 'daily';

    if (user) {
      const daily = ensureDailyQuests(user, usernameKey(user.username));
      const ultra = ensureUltraQuests(user);
      const quest = (questType === 'ultra' ? ultra.tasks : daily.tasks).find(q => q.id === questId);
      if (!quest) {
        sendJson(response, 400, { error: 'Geçersiz görev.' });
        return true;
      }
      if (quest.claimed) {
        sendJson(response, 400, { error: 'Bu ödül zaten alınmış.' });
        return true;
      }
      const currentProg = Number(quest.progress || 0);
      if (currentProg < quest.target) {
        sendJson(response, 400, { error: 'Görev henüz tamamlanmadı.' });
        return true;
      }
      quest.claimed = true;
      const earnedQuestXp = Math.max(1, Math.round(Number(quest.rewardXp || 0) * QUEST_XP_RATE));
      const rewardCoins = Math.max(1, Math.round(Number(quest.rewardCoins || 0) * 1.35));
      user.xp = (user.xp || 0) + earnedQuestXp;
      user.coins = (user.coins || 0) + rewardCoins;
      user.gold = user.coins;
      user.rankId = rankInfo(user.xp).rankId;
      saveAccountData(true);
      sendJson(response, 200, {
        ok: true,
        message: `${quest.title} tamamlandı! +${rewardCoins} Altın ve +${earnedQuestXp} XP kazandınız!`,
        claimedQuestId: questId,
        rewardCoins,
        rewardXp: earnedQuestXp,
        dailyQuests: daily,
        user: publicUser(user)
      });
      return true;
    } else {
      // Guest claiming support
      const pool = questType === 'ultra' ? ULTRA_QUESTS : DAILY_QUEST_POOL;
      const quest = pool.find(q => q.id === questId);
      if (!quest) {
        sendJson(response, 400, { error: 'Geçersiz görev.' });
        return true;
      }
      const earnedQuestXp = Math.max(1, Math.round(Number(quest.rewardXp || 0) * QUEST_XP_RATE));
      const rewardCoins = Math.max(1, Math.round(Number(quest.rewardCoins || 0) * 1.35));
      sendJson(response, 200, {
        ok: true,
        message: `${quest.title} tamamlandı! +${rewardCoins} Altın ve +${earnedQuestXp} XP kazandınız!`,
        claimedQuestId: questId,
        rewardCoins,
        rewardXp: earnedQuestXp,
        guest: true
      });
      return true;
    }
  }
  if (requestPath === '/api/profile/level-reward' && request.method === 'POST') {
    if (!user) {
      sendJson(response, 401, { error: 'Seviye ödülü için giriş yapmalısınız.' });
      return true;
    }
    const level = Math.floor(Number(body.level));
    if (!Number.isInteger(level) || level < 1 || level > RANKS.length) {
      sendJson(response, 400, { error: 'Geçersiz seviye.' });
      return true;
    }
    if ((user.xp || 0) < RANKS[level - 1]) {
      sendJson(response, 400, { error: 'Bu seviye henüz açılmadı.' });
      return true;
    }
    const claimed = Array.isArray(user.claimedLevelRewards) ? user.claimedLevelRewards : [];
    if (claimed.includes(level)) {
      sendJson(response, 409, { error: 'Bu seviye ödülü zaten alındı.', level, user: publicUser(user) });
      return true;
    }
    const rewardCoins = LEVEL_REWARD_BASE_COINS + (level - 1) * LEVEL_REWARD_STEP_COINS;
    user.claimedLevelRewards = [...new Set([...claimed, level])].sort((a, b) => a - b);
    user.coins = (user.coins || 0) + rewardCoins;
    user.gold = user.coins;
    saveAccountData(true);
    sendJson(response, 200, { ok: true, level, rewardCoins, coins: user.coins, user: publicUser(user) });
    return true;
  }
  if (requestPath === '/api/daily-reward' && request.method === 'GET') {
    if (!user) {
      sendJson(response, 401, { error: 'Günlük ödül için giriş yapmalısınız.' });
      return true;
    }
    const state = dailyRewardState(user);
    user.dailyReward = state;
    const today = dailyQuestDayKey();
    saveAccountData(true);
    sendJson(response, 200, {
      day: state.day,
      claimedDate: state.claimedDate,
      claimedToday: state.claimedDate === today,
      today,
      rewards: DAILY_REWARDS
    });
    return true;
  }
  if (requestPath === '/api/daily-reward/claim' && request.method === 'POST') {
    if (!user) {
      sendJson(response, 401, { error: 'Günlük ödül için giriş yapmalısınız.' });
      return true;
    }
    const today = dailyQuestDayKey();
    const state = dailyRewardState(user);
    if (state.claimedDate === today) {
      sendJson(response, 409, { error: 'Bugünkü günlük ödül zaten alındı.', ...state, claimedToday: true });
      return true;
    }
    const reward = DAILY_REWARDS[state.day - 1];
    user.coins = (user.coins || 0) + reward;
    user.gold = user.coins;
    user.dailyReward = {
      day: state.day,
      claimedDate: today
    };
    saveAccountData(true);
    sendJson(response, 200, {
      ok: true,
      reward,
      day: state.day,
      claimedDate: today,
      nextDay: state.day >= DAILY_REWARDS.length ? 1 : state.day + 1,
      coins: user.coins,
      user: publicUser(user)
    });
    return true;
  }
  if (requestPath === '/api/shop/owned' && request.method === 'GET') {
    if (!user) sendJson(response, 401, { error: 'Oturum gerekli.' });
    else sendJson(response, 200, publicUser(user));
    return true;
  }
  if (requestPath === '/api/shop/sync' && request.method === 'POST') {
    if (!user) sendJson(response, 401, { error: 'Oturum gereklidir.' });
    else {
      if (Array.isArray(body.ownedItems)) {
        user.ownedItems = ownedItemsForUser(user, sanitizeOwnedItems(body.ownedItems));
      }
      if (body.equippedItems && typeof body.equippedItems === 'object') {
        user.equippedItems = equippedItemsForUser(user, { ...(user.equippedItems || {}), ...body.equippedItems });
      }
      const incomingCoins = clampNumber(body.coins, user.coins || 0, 0, MAX_ACCOUNT_COINS);
      if (Number.isFinite(incomingCoins) && incomingCoins >= 0 && incomingCoins >= (user.coins || 0)) {
        user.coins = incomingCoins;
        user.gold = user.coins;
      }
      saveAccountData(true);
      sendJson(response, 200, publicUser(user));
    }
    return true;
  }
  if (requestPath === '/api/shop/equip' && request.method === 'PUT') {
    if (!user) sendJson(response, 401, { error: 'Oturum gereklidir.' });
    else {
      const cat = String(body.category || '');
      const item = String(body.itemId || '');
      if (cat) {
        if (item === 'thor' && !canUseThor(user)) {
          sendJson(response, 403, { error: 'Thor derisi yalnızca Basilisk hesabına aittir.' });
          return true;
        }
        const freeItems = new Set(['wolf', 'default', 'ki_tier_0', 'ba_tier_0']);
        if (['deriler', 'kiliclar', 'baltalar'].includes(cat) && !freeItems.has(item) && !user.ownedItems?.includes(item) && item !== 'thor') {
          sendJson(response, 403, { error: 'Bu kozmetik hesabında bulunmuyor.' });
          return true;
        }
        user.equippedItems = equippedItemsForUser(user, { ...(user.equippedItems || {}), [cat]: item });
        saveAccountData(true);
      }
      sendJson(response, 200, { success: true, equippedItems: user.equippedItems });
    }
    return true;
  }
  if (requestPath === '/api/shop/buy' && request.method === 'POST') {
    if (!user) sendJson(response, 401, { error: 'Oturum gereklidir.' });
    else {
      if (authRateLimited(request, 'shop_buy')) {
        sendJson(response, 429, { error: 'Alışveriş limiti aşıldı.' });
        return true;
      }
      const itemId = String(body.itemId || '');
      const chest = CHEST_CONFIG[String(body.chestId || itemId)];
      if (chest) {
        if ((user.coins || 0) < chest.cost) {
          sendJson(response, 400, { error: 'Yetersiz altın.' });
        } else {
          const ownedItems = new Set(Array.isArray(user.ownedItems) ? user.ownedItems.map(String) : []);
          const availableRewards = chest.rewards.filter(rewardId => !ownedItems.has(rewardId));
          if (!availableRewards.length) {
            sendJson(response, 409, { error: 'Bu sandıktaki tüm skinlere zaten sahipsin.' });
            return true;
          }
          const rewardId = chooseChestReward(availableRewards);
          user.coins = (user.coins || 0) - chest.cost;
          user.gold = user.coins;
          user.ownedItems = [...new Set([...(user.ownedItems || []), rewardId])];
          saveAccountData(true);
          sendJson(response, 200, { success: true, chestId: Object.keys(CHEST_CONFIG).find(id => CHEST_CONFIG[id] === chest), rewardId, newCoins: user.coins, ownedItems: user.ownedItems });
        }
        return true;
      }
      const cosmetic = cosmeticCatalog.find(item => item.id === itemId);
      const cost = cosmetic ? Math.max(0, Number(cosmetic.price) || 0) : null;
      if (itemId === 'thor' && !canUseThor(user)) {
        sendJson(response, 403, { error: 'Thor derisi yalnızca Basilisk hesabına aittir.' });
      } else if (!itemId || !cosmetic) {
        sendJson(response, 400, { error: 'Geçersiz eşya.' });
      } else if ((user.ownedItems || []).includes(itemId)) {
        sendJson(response, 409, { error: 'Bu eşyaya zaten sahipsin.' });
      } else if ((user.coins || 0) < cost) {
        sendJson(response, 400, { error: 'Yetersiz altın.' });
      } else {
        user.coins = (user.coins || 0) - cost;
        user.gold = user.coins;
        user.ownedItems = [...new Set([...(user.ownedItems || []), itemId])];
        saveAccountData(true);
        sendJson(response, 200, { success: true, newCoins: user.coins, ownedItems: user.ownedItems });
      }
    }
    return true;
  }
  sendJson(response, 404, { error: 'API endpoint bulunamadı.' });
  return true;
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const server = http.createServer((request, response) => {
  let requestPath;
  try {
    requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }
  handleApi(request, response, requestPath).then(handled => {
    if (handled) return;
    serveStatic(request, response, requestPath);
  }).catch(error => {
    console.error('Request error:', error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Sunucu hatası.' });
  });
});

function serveStatic(request, response, requestPath) {
  const normalized = String(requestPath || '/').trim();

  if (normalized === '/admin' || normalized === '/admin/') {
    response.writeHead(302, { Location: '/admin.html' });
    response.end();
    return;
  }

  if (normalized === '/admin.html') {
    requestPath = '/admin/index.html';
  }
  else if (normalized === '/admin.css') {
    requestPath = '/admin/admin.css';
  }
  else if (normalized === '/admin.js') {
    requestPath = '/admin/admin.js';
  }
  else if (normalized === '/admin/index.html') {
    requestPath = '/admin/index.html';
  }

  if (requestPath === '/.well-known/assetlinks.json' || requestPath === '/assetlinks.json') {
    const candidatePaths = [
      path.join(root, '.well-known', 'assetlinks.json'),
      path.join(__dirname, '..', 'assetlinks.json'),
      path.join(__dirname, 'assetlinks.json'),
      path.join(__dirname, 'game', 'assetlinks.json')
    ];
    let foundPath = null;
    for (const cp of candidatePaths) {
      try { if (fs.existsSync(cp)) { foundPath = cp; break; } } catch (_) {}
    }
    if (foundPath) {
      fs.readFile(foundPath, (error, data) => {
        if (error) {
          response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end('{"error":"Read error"}');
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*'
        });
        response.end(data);
      });
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    response.end('{"error":"assetlinks.json not found"}');
    return;
  }

  let relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  if (relative.startsWith('game/')) relative = relative.slice(5);
  else if (relative.startsWith('game\\')) relative = relative.slice(5);
  if (relative === '') relative = 'index.html';
  if (relative.endsWith('/')) relative += 'index.html';

  const blockedPath = /(^|[\\/])(?:\.|server\.js$|package(?:-lock)?\.json$|forest-data\.json(?:\.bak)?$|ecosystem\.config\.[cm]?js$|render\.yaml$|\.nvmrc$)/i;
  const isAssetLinks = relative === '.well-known/assetlinks.json';
  if (!isAssetLinks && blockedPath.test(relative)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end('Not found');
    return;
  }

  const publicAssetDirs = new Set(['biomedecors', 'buildassets', 'mobassets', 'resourceasset']);
  const topLevelDir = relative.split(/[\\/]/, 1)[0];
  const assetRoot = publicAssetDirs.has(topLevelDir) ? __dirname : root;
  let filePath = path.resolve(assetRoot, relative);
  const isGameFile = filePath.startsWith(`${root}${path.sep}`) || filePath === root;
  const isPublicAsset = publicAssetDirs.has(topLevelDir) && filePath.startsWith(`${__dirname}${path.sep}${topLevelDir}${path.sep}`);
  if (!isGameFile && !isPublicAsset) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const isHtmlOrCode = ['.html', '.js', '.css'].includes(extension);
    const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(extension);
    response.writeHead(200, {
      'Content-Type': mime[extension] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "frame-ancestors 'self' https://forestbrawl.fun https://www.forestbrawl.fun https://titotu.io https://www.titotu.io https://titotu.ru https://www.titotu.ru",
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-DNS-Prefetch-Control': 'on',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Cache-Control': isHtmlOrCode ? 'no-cache' : isImage ? 'public, max-age=604800, immutable' : 'public, max-age=86400',
    });
    response.end(data);
  });
}

const io = new Server(server, {
  path: '/api/socket.io',
  pingInterval: 2500,
  pingTimeout: 8000,
  allowUpgrades: true,
  perMessageDeflate: false,
  maxHttpBufferSize: 1e6,
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      return callback(null, isAllowedOrigin(origin));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.engine.on('connection_error', (err) => {
  const details = err?.message || 'unknown socket.io engine error';
  console.warn('[Socket.IO] engine connection error:', details);
});

function compactState(state, full = false) {
  const score = Number(state.score ?? state.sc ?? 0) || 0;
  const res = {
    x: Math.round((state.x || 0) * 10) / 10, y: Math.round((state.y || 0) * 10) / 10,
    a: state.angle !== undefined ? Math.round(state.angle * 100) / 100 : 0, hp: state.hp ?? 100, mhp: state.maxHp ?? 100, w: state.weapon || 1,
    atk: Boolean(state.isAttacking), atp: Number(state.attackTimer) || 0, atd: Number(state.attackDuration) || 0, k: state.kills || 0, xp: state.xp || 0, g: state.gold || 0,
    sc: score, at: state.axeTier || 0, st: state.swordTier || 0, rk: state.visualRankId ?? Math.min(11, Number(state.rankId) || 0),
    vx: state.vx ? Math.round(state.vx * 10) / 10 : 0, vy: state.vy ? Math.round(state.vy * 10) / 10 : 0,
    bx: typeof state.buildX === 'number' ? Math.round(state.buildX) : null, by: typeof state.buildY === 'number' ? Math.round(state.buildY) : null,
    sq: state.stateSeq || 0, tm: state.stateAt || Date.now(),
    trappedBy: state.trappedBy || null, trappedX: state.trappedX ?? null, trappedY: state.trappedY ?? null,
  };
  if (full) {
    res.n = state.name || 'Oyuncu';
    res.sk = state.skin || 'default';
    res.color = state.color || '#8B5E3A';
    res.team = state.team || '';
    res.clanId = state.clanId || '';
    res.clanTag = state.clanTag || '';
    res.acc = state.acc || {};
    res.profileCosmetics = state.profileCosmetics || null;
    res.axeSkin = state.axeSkin || state.acc?.b || null;
    res.swordSkin = state.swordSkin || state.acc?.w || null;
  }
  return res;
}

function compactFullState(state) {
  return compactState(state, true);
}

function compactStateCompressed(state) {
  if (!state) return null;
  return {
    x: Math.round((Number(state.x) || 0) * 10) / 10,
    y: Math.round((Number(state.y) || 0) * 10) / 10,
    a: Number.isFinite(Number(state.angle)) ? Math.round(Number(state.angle) * 100) / 100 : 0,
    hp: Number(state.hp ?? 100),
    mhp: Number(state.maxHp ?? 100),
    w: Number(state.weapon || 1),
    sq: Number(state.stateSeq || 0),
    vx: Math.round((Number(state.vx) || 0) * 10) / 10,
    vy: Math.round((Number(state.vy) || 0) * 10) / 10,
    t: state.trappedBy ? 1 : 0,
    r: String(state.roomId || ''),
    clanId: state.clanId || '',
    clanTag: state.clanTag || ''
  };
}

function roomCellKey(x, y) {
  return `${Math.floor((Number(x) || 0) / 1800)},${Math.floor((Number(y) || 0) / 1800)}`;
}

function getRoomForPosition(x, y) {
  return `room:${roomCellKey(x, y)}`;
}

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function updatePlayerRoom(player) {
  if (!player) return null;
  const roomId = getRoomForPosition(player.x || 0, player.y || 0);
  if (player.roomId && rooms.get(player.roomId)?.has(player.id)) rooms.get(player.roomId).delete(player.id);
  player.roomId = roomId;
  ensureRoom(roomId).add(player.id);
  return roomId;
}

function nearbyRoomIds(x, y, radius = PLAYER_AOI_RADIUS) {
  const minCellX = Math.floor(((Number(x) || 0) - radius) / 1800);
  const maxCellX = Math.floor(((Number(x) || 0) + radius) / 1800);
  const minCellY = Math.floor(((Number(y) || 0) - radius) / 1800);
  const maxCellY = Math.floor(((Number(y) || 0) + radius) / 1800);
  const ids = new Set();
  for (let cx = minCellX; cx <= maxCellX; cx++) {
    for (let cy = minCellY; cy <= maxCellY; cy++) {
      ids.add(`room:${cx},${cy}`);
    }
  }
  return ids;
}

function getRoomMembers(roomId) {
  return [...(rooms.get(roomId) || [])].map(id => players.get(id)).filter(Boolean);
}

function sameClanEntity(a, b) {
  return Boolean(a && b && a.clanId && b.clanId && String(a.clanId) === String(b.clanId));
}

function sameClanBuildingOwner(attacker, building) {
  if (!attacker || !building) return false;
  if (attacker.clanId && building.ownerClanId && String(attacker.clanId) === String(building.ownerClanId)) return true;
  const owner = building.ownerId ? players.get(building.ownerId) : null;
  return Boolean(attacker.clanId && owner?.clanId && String(attacker.clanId) === String(owner.clanId));
}

function validateCombatState(attacker, target, { allowTrapHit = false, rangeLimit = 160, damage = 0, requireAlive = true, validWeapon = null } = {}) {
  if (!attacker || !target) return false;
  if (requireAlive && ((attacker.hp ?? 0) <= 0 || (target.hp ?? 0) <= 0)) return false;
  if (sameClanEntity(attacker, target) || (attacker.team && target.team && attacker.team === target.team)) return false;
  if (!pvpAllowed()) return false;
  if (!allowTrapHit && target.trappedBy) return false;
  if (validWeapon && Number(attacker.weapon ?? 1) !== Number(validWeapon)) return false;
  const dist = Math.hypot((Number(target.x) || 0) - (Number(attacker.x) || 0), (Number(target.y) || 0) - (Number(attacker.y) || 0));
  if (dist > rangeLimit) return false;
  if (!Number.isFinite(Number(damage)) || Number(damage) <= 0) return false;
  return true;
}

function validateTrapCapture(attacker, target, building) {
  if (!attacker || !target || !building) return false;
  if ((attacker.hp ?? 0) <= 0 || (target.hp ?? 0) <= 0) return false;
  if (building.type !== 6 || (building.hp ?? 0) <= 0 || building.ownerId === target.id) return false;
  if ((building.ownerId && building.ownerId !== attacker.id) && attacker.id !== target.id) return false;
  const dx = (Number(target.x) || 0) - (Number(building.x) || 0);
  const dy = (Number(target.y) || 0) - (Number(building.y) || 0);
  const radius = (Number(building.radius) || 78) + 34;
  return dx * dx + dy * dy <= radius * radius;
}

function compactMobTick(mob) {
  return {
    id: mob.id,
    seq: mob.stateSeq || 0,
    ts: mob.stateAt || Date.now(),
    x: Math.round(mob.x),
    y: Math.round(mob.y),
    vx: Math.round((mob.vx || 0) * 10) / 10,
    vy: Math.round((mob.vy || 0) * 10) / 10,
    angle: mob.angle !== undefined ? Math.round(mob.angle * 100) / 100 : 0,
    hp: mob.hp,
    maxHp: mob.maxHp,
    radius: mob.radius || 46,
    color: mob.color || '#6b4932',
    outline: mob.outline || '#28170d',
    eyes: mob.eyes || '#ffcc66',
    shape: mob.shape || 'wolf',
    typeName: mob.typeName || '🐺 Kurt',
    state: mob.state || 'idle',
    hitFlash: mob.hitFlash || 0,
  };
}

function publicClan(clan) {
  return { id: clan.id, name: clan.name, tag: clan.tag, ownerId: clan.ownerId, ownerName: clan.ownerName,
    members: (clan.members || []).map(member => ({ id: member.id, name: member.name })) };
}

function publicClanJoinRequest(request) {
  return {
    clanId: request.clanId,
    clanName: request.clanName,
    clanTag: request.clanTag,
    requesterId: request.requesterId,
    requesterName: request.requesterName,
    requestedAt: request.requestedAt || Date.now(),
  };
}

function emitClanUpdate(clan) {
  io.to(`clan:${clan.id}`).emit('clan_update', publicClan(clan));
}

function emitClanRequests(clan) {
  if (!clan || !clan.id) return;
  const requests = Array.isArray(clanJoinRequests.get(clan.id)) ? clanJoinRequests.get(clan.id) : [];
  const payload = requests.map(publicClanJoinRequest);
  const owner = io.sockets?.sockets?.get(clan.ownerId);
  if (owner) owner.emit('clan_requests_update', { clanId: clan.id, requests: payload });
}

function leaveClan(socket, notify = true) {
  const player = players.get(socket.id);
  const clanId = player?.clanId || socket.data.clanId;
  const clan = clanId ? clans.get(clanId) : null;
  if (!clan) return;
  clan.members = (clan.members || []).filter(member => member.id !== socket.id);
  socket.leave(`clan:${clan.id}`);
  if (clan.ownerId === socket.id) {
    clan.ownerId = clan.members[0]?.id || null;
    clan.ownerName = clan.members[0]?.name || null;
    if (!clan.ownerId) clans.delete(clan.id);
  }
  if (player) { player.clanId = ''; player.clanTag = ''; }
  socket.data.clanId = '';
  saveAccountData();
  if (clans.has(clan.id)) emitClanUpdate(clan);
  if (notify) socket.emit('clan_left');
}

function broadcastOnlineCount() {
  io.emit('online_count', io.engine.clientsCount);
}

function relayToOthers(socket, event, payload) {
  socket.broadcast.emit(event, payload);
}

const MAX_MOBS = 32;
const MOB_RADIUS = 36;
const MOB_AGGRO_RANGE = 420;
const MOB_SPEED = 24;
const MOB_WANDER_SPEED = 12;
const MOB_CHASE_TIMEOUT = 6000;
const MOB_GRID_CELL_SIZE = 300;
const MOB_AOI_RADIUS = 1200;
const PLAYER_AOI_RADIUS = 2200;
const PLAYER_GRID_CELL_SIZE = 420;
const MAX_PLAYER_SPEED = 360;
const MAX_MOVE_DELTA_PER_TICK = 96;
const BUILD_ROLES = {
  tank: {
    label: 'Tank',
    title: 'Iron Warden',
    theme: 'heavy protector',
    flavor: 'Duraklı ve kalın, göğsünü öne çıkarır, savunmayı önceleyen bir koruyucu.',
    color: '#9aa6ff',
    maxHp: 1.18, damage: 0.96, armor: 1.18, speed: 0.92,
    perks: ['Kalkan dayanımı', 'Ön hat tutma', 'Yüksek savunma']
  },
  vanguard: {
    label: 'Vanguard',
    title: 'Sunforge Vanguard',
    theme: 'frontliner titan',
    flavor: 'En öndeki savunma duvarı; göğüs geriye dönmez, sahayı kapatır.',
    color: '#a8c5ff',
    maxHp: 1.22, damage: 1.02, armor: 1.28, speed: 0.9,
    perks: ['Frontline wall', 'Stagger hold', 'Shield break']
  },
  assassin: {
    label: 'Assassin',
    title: 'Shadow Fang',
    theme: 'silent predator',
    flavor: 'Sessiz, hızlı ve ani hasar vurur; hedefi minimum mesafede imha eder.',
    color: '#d8a1ff',
    maxHp: 0.92, damage: 1.18, armor: 0.9, speed: 1.14,
    perks: ['Ani burst', 'Mobility', 'Critical tempo']
  },
  viper: {
    label: 'Viper',
    title: 'Night Viper',
    theme: 'venom rush',
    flavor: 'Kısa mesafede ölümcül hızla gelir; rakibin direncini çabuk tüketir.',
    color: '#cdaeff',
    maxHp: 0.9, damage: 1.26, armor: 0.88, speed: 1.18,
    perks: ['Poison tempo', 'Critical burst', 'Shadow cut']
  },
  ranged: {
    label: 'Ranged',
    title: 'Horizon Lens',
    theme: 'long sight',
    flavor: 'Uzaktan baskı kurar, hasarı ve menzili öne çıkarır.',
    color: '#7dd3fc',
    maxHp: 0.96, damage: 1.1, armor: 0.96, speed: 1.02,
    perks: ['Menzil üstünlüğü', 'İsabet', 'Kontrol']
  },
  oracle: {
    label: 'Oracle',
    title: 'Astral Oracle',
    theme: 'prophecy caster',
    flavor: 'Menzili ve kontrolü bozan, yıldız gibi kesin bir düzen kurar.',
    color: '#97f0ff',
    maxHp: 0.95, damage: 1.15, armor: 0.97, speed: 1.04,
    perks: ['Star guidance', 'Pacing control', 'Precision burst']
  },
  support: {
    label: 'Support',
    title: 'Aegis Relic',
    theme: 'guardian healer',
    flavor: 'Takımın ayakta kalmasını sağlar, savunma ve desteği öne çıkarır.',
    color: '#7ef0c3',
    maxHp: 1.06, damage: 0.94, armor: 1.04, speed: 1.0,
    perks: ['Heal pulse', 'Shield sustain', 'Utility']
  },
  trap: {
    label: 'Trap Master',
    title: 'Snare Warden',
    theme: 'field control',
    flavor: 'Tuzak kurup alanı kontrol eder; rakibin hareketini keser.',
    color: '#f9c66b',
    maxHp: 1.02, damage: 1.0, armor: 1.12, speed: 0.96,
    perks: ['Trap efficiency', 'Area denial', 'Tempo control']
  },
  warden: {
    label: 'Warden',
    title: 'Gale Warden',
    theme: 'field anchor',
    flavor: 'Alanı kontrol eder, tuzak ve zemin baskısını barındırır.',
    color: '#f6d87a',
    maxHp: 1.08, damage: 1.08, armor: 1.16, speed: 0.98,
    perks: ['Control field', 'Zone lockdown', 'Stall tempo']
  },
  berserker: {
    label: 'Berserker',
    title: 'Warfang Rage',
    theme: 'rage rush',
    flavor: 'Riskli ama yıkıcı bir saldırı profili; yakın dövüşte en tehlikelidir.',
    color: '#ff7d6b',
    maxHp: 0.9, damage: 1.24, armor: 0.82, speed: 1.08,
    perks: ['Burst damage', 'Aggro pressure', 'High risk tempo']
  }
};
const BUILD_HELMETS = {
  guardian: {
    label: 'Guardian',
    title: 'Stone Guardian',
    style: 'fortified',
    flavor: 'Kalın metal kask, dayanıklılık ve hiddet dengesini sağlar.',
    color: '#a5b4fc',
    maxHp: 1.12, damage: 0.94, armor: 1.2, speed: 0.96,
    rarity: 'Epic'
  },
  aegis: {
    label: 'Aegis',
    title: 'Sunfall Aegis',
    style: 'solar guard',
    flavor: 'Güneşi taşıyan koruyucu başlık; en sağlam bloklayıcı zırh profiline aittir.',
    color: '#ffe09a',
    maxHp: 1.18, damage: 0.98, armor: 1.3, speed: 0.94,
    rarity: 'Mythic'
  },
  phantom: {
    label: 'Phantom',
    title: 'Night Phantom',
    style: 'silent assassin',
    flavor: 'Hafif ama ölümcül; düşman önüne sessizce gelir.',
    color: '#d8b8ff',
    maxHp: 0.9, damage: 1.18, armor: 0.9, speed: 1.16,
    rarity: 'Legendary'
  },
  voidveil: {
    label: 'Voidveil',
    title: 'Moon Voidveil',
    style: 'shadow dusk',
    flavor: 'Geceye bürünmüş görünüm; sessizlik ve ölümcül ritim verir.',
    color: '#b9a7ff',
    maxHp: 0.88, damage: 1.22, armor: 0.88, speed: 1.2,
    rarity: 'Mythic'
  },
  ranger: {
    label: 'Ranger',
    title: 'Horizon Ranger',
    style: 'longview elite',
    flavor: 'Gözlem ve menzil odaklı, uzaktan savaşın kralı gibi durur.',
    color: '#7dd3fc',
    maxHp: 0.98, damage: 1.1, armor: 0.96, speed: 1.08,
    rarity: 'Epic'
  },
  sunflare: {
    label: 'Sunflare',
    title: 'Solar Crown',
    style: 'flare x-ray',
    flavor: 'Işık dalgaları taşıyan başlık; menzili ve hedefleme gücünü yükseltir.',
    color: '#ffcc7a',
    maxHp: 0.96, damage: 1.15, armor: 0.96, speed: 1.12,
    rarity: 'Mythic'
  },
  relic: {
    label: 'Relic',
    title: 'Aegis Relic',
    style: 'sacred ward',
    flavor: 'Kutsal ışıkla çevrili, koruyucu ve destek odaklı bir başlık.',
    color: '#7ef0c3',
    maxHp: 1.08, damage: 0.96, armor: 1.1, speed: 0.98,
    rarity: 'Epic'
  },
  frostcrown: {
    label: 'Frostcrown',
    title: 'Frostveil Crown',
    style: 'cryo discipline',
    flavor: 'Buzdan bir kılıçla kesilen soğuk hedefleme ve kontrollü savunma sağlar.',
    color: '#b2f0ff',
    maxHp: 1.06, damage: 1.1, armor: 1.12, speed: 1.0,
    rarity: 'Mythic'
  },
  trapper: {
    label: 'Trapper',
    title: 'Snare Trapper',
    style: 'mechanic warden',
    flavor: 'Mekanik tasarım, tuzak ve alan kontrolü için hazırlanmış.',
    color: '#fbbf24',
    maxHp: 1.02, damage: 1.06, armor: 1.08, speed: 0.94,
    rarity: 'Rare'
  },
  warfang: {
    label: 'Warfang',
    title: 'Warfang Crown',
    style: 'battle fury',
    flavor: 'Yırtıcı ve sert görünüm, en agresif savaşçılara uygun bir başlık.',
    color: '#ff8a65',
    maxHp: 0.88, damage: 1.26, armor: 0.84, speed: 1.1,
    rarity: 'Legendary'
  }
};
const LOADOUT_SETS = {
  sunforge: {
    label: 'Sunforge Set',
    theme: 'radiant frontliner',
    flavor: 'Güneşin ilk ışığı gibi baskı kurar; takımın önünde duran bir zırh setidir.',
    bonus: 'Savunma +12%, hasar +6%'
  },
  abyss: {
    label: 'Abyssal Set',
    theme: 'deep kill rhythm',
    flavor: 'Karanlığın içinde hareket eder; yakalanan hedefi çok hızlı düşürür.',
    bonus: 'Hız +10%, kritik +9%'
  },
  aurora: {
    label: 'Aurora Set',
    theme: 'luminous tempo',
    flavor: 'Parıltılı duruşu ve nazik görünümüyle hem kontrol hem baskı sağlar.',
    bonus: 'Kontrol +11%, tempo +7%'
  },
  tempest: {
    label: 'Tempest Set',
    theme: 'storm rush',
    flavor: 'Rüzgar gibi gelir, çarpma anında yıkıcı olur.',
    bonus: 'Hasar +14%, manevra +8%'
  },
  dawn: {
    label: 'Dawn Oath Set',
    theme: 'purity guardian',
    flavor: 'Ciddi bir koruyucu görselliği; takımın ayakta kalmasını sağlar.',
    bonus: 'Can +9%, kalkan +12%'
  }
};
const WEAPON_DEFINITIONS = {
  sword: { label: 'Sword', title: 'Velvet Edge', style: 'balanced duelist', damage: 1.08, range: 1.0, speed: 1.04, notes: 'Dengeli ve net hasar.' },
  axe: { label: 'Axe', title: 'Storm Cleaver', style: 'heavy breaker', damage: 1.22, range: 0.92, speed: 0.8, notes: 'Yüksek hasar, yüksek risk.' },
  spear: { label: 'Spear', title: 'Thorn Reach', style: 'control lance', damage: 1.1, range: 1.18, speed: 0.94, notes: 'Uzak kontrol ve giriş baskısı.' },
  bow: { label: 'Bow', title: 'Horizon String', style: 'range sniper', damage: 1.12, range: 1.26, speed: 0.9, notes: 'Menzil ve isabet üstünlüğü.' },
  crossbow: { label: 'Crossbow', title: 'Iron Verdict', style: 'heavy piercer', damage: 1.18, range: 1.2, speed: 0.72, notes: 'Yavaş ama yıkıcı.' },
  hammer: { label: 'Hammer', title: 'Vault Breaker', style: 'stun crusher', damage: 1.24, range: 0.9, speed: 0.7, notes: 'Yüksek stun ve ağır vurma.' },
  scythe: { label: 'Scythe', title: 'Reaper Arc', style: 'area sweeper', damage: 1.16, range: 1.05, speed: 0.82, notes: 'Alan kontrolü ve ters dönüş.' },
  staff: { label: 'Staff', title: 'Moon Weave', style: 'support caster', damage: 0.96, range: 1.1, speed: 1.0, notes: 'Destek, kontrol ve düzen.' },
  chakram: { label: 'Chakram', title: 'Aether Ring', style: 'arc thrower', damage: 1.08, range: 1.15, speed: 1.08, notes: 'Dönüşlü ve hızlı hasar.' },
  trapblade: { label: 'Trap Blade', title: 'Snare Fang', style: 'field trap', damage: 1.1, range: 1.04, speed: 0.9, notes: 'Tuzak ve alan baskısı.' },
  halberd: { label: 'Halberd', title: 'Gale Reach', style: 'reach finisher', damage: 1.14, range: 1.22, speed: 0.88, notes: 'Uzun menzil ve net giriş.' },
  dagger: { label: 'Dagger', title: 'Ghost Piercer', style: 'rush finisher', damage: 1.08, range: 0.84, speed: 1.2, notes: 'Hızlı burst ve çabuk öldürme.' },
  runeblade: { label: 'Rune Blade', title: 'Astral Sigil', style: 'arcane duelist', damage: 1.18, range: 1.02, speed: 1.04, notes: 'Büyülü hasar ve tekniği güçlü.' },
  wand: { label: 'Wand', title: 'Nova Scepter', style: 'spell anchor', damage: 1.0, range: 1.18, speed: 0.96, notes: 'Kontrol ve etkili destek.' },
  shotgun: { label: 'Shotgun', title: 'Bloom Breaker', style: 'close burst', damage: 1.22, range: 0.86, speed: 0.75, notes: 'Yakın mesafede devasa patlama.' },
  voidblade: { label: 'Voidblade', title: 'Null Eclipse', style: 'shadow edge', damage: 1.28, range: 1.08, speed: 1.12, notes: 'Karanlık enerjiyle kesen ölümcül bir kılıç.' },
  sunflare: { label: 'Sunflare', title: 'Helios Lash', style: 'solar cutter', damage: 1.3, range: 1.16, speed: 0.98, notes: 'Yüksek parlaklık ve baskı odaklı hasar.' },
  frostglaive: { label: 'Frost Glaive', title: 'Glacier Reach', style: 'ice control', damage: 1.18, range: 1.28, speed: 0.84, notes: 'Soğuk menzil ve kontrollü engeller.' },
  stormcannon: { label: 'Storm Cannon', title: 'Skybreaker', style: 'heavy artillery', damage: 1.34, range: 1.24, speed: 0.7, notes: 'Ağır, yüksek patlama hasarı.' },
  moonpiercer: { label: 'Moonpiercer', title: 'Lunar Fang', style: 'astral lance', damage: 1.2, range: 1.32, speed: 0.92, notes: 'Ay ışığı gibi net ve uzun menzilli vurum.' }
};
const mobGrid = new Map();
const playerGrid = new Map();

function mobCellKey(x, y) {
  return `${Math.floor(x / MOB_GRID_CELL_SIZE)},${Math.floor(y / MOB_GRID_CELL_SIZE)}`;
}

function rebuildMobGrid() {
  mobGrid.clear();
  for (const mob of mobs.values()) {
    const key = mobCellKey(mob.x, mob.y);
    const bucket = mobGrid.get(key);
    if (bucket) bucket.push(mob);
    else mobGrid.set(key, [mob]);
  }
}

function nearbyMobs(x, y, radius) {
  const minCellX = Math.floor((x - radius) / MOB_GRID_CELL_SIZE);
  const maxCellX = Math.floor((x + radius) / MOB_GRID_CELL_SIZE);
  const minCellY = Math.floor((y - radius) / MOB_GRID_CELL_SIZE);
  const maxCellY = Math.floor((y + radius) / MOB_GRID_CELL_SIZE);
  const result = [];
  const radiusSquared = radius * radius;
  for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      const bucket = mobGrid.get(`${cellX},${cellY}`);
      if (!bucket) continue;
      for (const mob of bucket) {
        const dx = mob.x - x, dy = mob.y - y;
        if (dx * dx + dy * dy <= radiusSquared) result.push(mob);
      }
    }
  }
  return result;
}

function playerCellKey(x, y) {
  return `${Math.floor(x / PLAYER_GRID_CELL_SIZE)},${Math.floor(y / PLAYER_GRID_CELL_SIZE)}`;
}

function rebuildPlayerGrid() {
  playerGrid.clear();
  for (const player of players.values()) {
    if (!player || (player.hp ?? 0) <= 0) continue;
    const key = playerCellKey(player.x, player.y);
    const bucket = playerGrid.get(key);
    if (bucket) bucket.push(player);
    else playerGrid.set(key, [player]);
  }
}

function nearbyPlayers(x, y, radius, excludeId = null) {
  const radiusSquared = radius * radius;
  const minCellX = Math.floor((x - radius) / PLAYER_GRID_CELL_SIZE);
  const maxCellX = Math.floor((x + radius) / PLAYER_GRID_CELL_SIZE);
  const minCellY = Math.floor((y - radius) / PLAYER_GRID_CELL_SIZE);
  const maxCellY = Math.floor((y + radius) / PLAYER_GRID_CELL_SIZE);
  const result = [];
  const seen = new Set();
  for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      const bucket = playerGrid.get(`${cellX},${cellY}`);
      if (!bucket) continue;
      for (const player of bucket) {
        if (!player || player.id === excludeId || (player.hp ?? 0) <= 0) continue;
        if (seen.has(player.id)) continue;
        const dx = (player.x || 0) - x;
        const dy = (player.y || 0) - y;
        if (dx * dx + dy * dy <= radiusSquared) {
          seen.add(player.id);
          result.push(player);
        }
      }
    }
  }
  return result;
}

function syncMobVisibility(changed = []) {
  rebuildMobGrid();
  for (const [id, player] of players) {
    const socket = io.sockets.sockets.get(id);
    if (!socket || !player.visibleMobIds) continue;
    const visibleMobs = nearbyMobs(player.x, player.y, MOB_AOI_RADIUS);
    const nextIds = new Set(visibleMobs.map(mob => mob.id));
    for (const mob of visibleMobs) {
      if (!player.visibleMobIds.has(mob.id)) socket.emit('mob_spawn', publicMob(mob));
    }
    for (const mobId of player.visibleMobIds) {
      if (!nextIds.has(mobId)) socket.emit('mob_despawn', { id: mobId, ts: Date.now() });
    }
    player.visibleMobIds = nextIds;
    const visibleChanged = changed.filter(mob => nextIds.has(mob.id));
    if (visibleChanged.length) socket.volatile.emit('mob_states', visibleChanged);
  }
}

function _makeMulberry32(seed) {
  return function() {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const serverObstacles = [];
const obstacleGrid = new Map();
const OBSTACLE_CELL_SIZE = 180;
function obstacleCellKey(x, y) {
  return `${Math.floor(x / OBSTACLE_CELL_SIZE)},${Math.floor(y / OBSTACLE_CELL_SIZE)}`;
}
function nearbyServerObstacles(x, y, radius) {
  const minCellX = Math.floor((x - radius) / OBSTACLE_CELL_SIZE);
  const maxCellX = Math.floor((x + radius) / OBSTACLE_CELL_SIZE);
  const minCellY = Math.floor((y - radius) / OBSTACLE_CELL_SIZE);
  const maxCellY = Math.floor((y + radius) / OBSTACLE_CELL_SIZE);
  const nearby = [];
  for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      const bucket = obstacleGrid.get(`${cellX},${cellY}`);
      if (bucket) nearby.push(...bucket);
    }
  }
  return nearby;
}
(function initServerObstacles() {
  const rng = _makeMulberry32(0x4F524553);
  const r = 7200 * 0.90 * 0.98;
  for (let i = 0; i < 420; i++) {
    const x = (rng() * 2 - 1) * r;
    const y = (rng() * 2 - 1) * r;
    const typeRoll = rng();
    const radius = typeRoll < 0.45 ? 145 : typeRoll < 0.75 ? 125 : 88;
    const obstacle = { x, y, radius };
    serverObstacles.push(obstacle);
    const key = obstacleCellKey(x, y);
    const bucket = obstacleGrid.get(key);
    if (bucket) bucket.push(obstacle);
    else obstacleGrid.set(key, [obstacle]);
  }
})();

function publicMob(mob) {
  return {
    id: mob.id, x: Math.round(mob.x), y: Math.round(mob.y), vx: Math.round(mob.vx * 10) / 10,
    vy: Math.round(mob.vy * 10) / 10, angle: mob.angle !== undefined ? Math.round(mob.angle * 100) / 100 : 0,
    seq: mob.stateSeq || 0,
    ts: mob.stateAt || Date.now(),
    hp: mob.hp, maxHp: mob.maxHp, radius: mob.radius,
    color: mob.color, outline: mob.outline, shape: mob.shape, eyes: mob.eyes,
    typeName: mob.typeName, dmg: mob.dmg, xpReward: mob.xpReward, goldReward: mob.goldReward,
    state: mob.state || 'idle',
    isBoss: false,
  };
}

const PREVIEW_RESOURCE_DEFS = {
  forest: [['wood', 30], ['wood', 16], ['stone', 20], ['stone', 10], ['gold', 5], ['gold', 3], ['apple', 10], ['bush', 14], ['mushroom', 8], ['crystal', 4], ['hive', 3]],
  winter: [['wood', 26], ['wood', 13], ['stone', 24], ['stone', 12], ['gold', 6], ['gold', 3], ['crystal', 5], ['bush', 8]],
  desert: [['wood', 16], ['wood', 9], ['stone', 28], ['stone', 14], ['gold', 8], ['gold', 4], ['bush', 10]],
  lava: [['wood', 28], ['wood', 14], ['stone', 20], ['stone', 10], ['gold', 6], ['gold', 3], ['bush', 12]],
};
function previewBiome(x, y) {
  const nx = x / 7200, ny = y / 7200;
  if (Math.abs(nx) < 0.65 && Math.abs(ny) < 0.65) return 'forest';
  if (Math.abs(ny) >= Math.abs(nx)) return ny < 0 ? 'winter' : 'lava';
  return nx > 0 ? 'desert' : 'lava';
}
function previewResources() {
  const rng = _makeMulberry32(0x4F524553);
  const resources = [];
  const radius = 7200 * 0.90 * 0.98;
  for (let i = 0; i < 420; i++) {
    const x = (rng() * 2 - 1) * radius;
    const y = (rng() * 2 - 1) * radius;
    const biome = previewBiome(x, y);
    const defs = PREVIEW_RESOURCE_DEFS[biome];
    const total = defs.reduce((sum, entry) => sum + entry[1], 0);
    let roll = rng() * total;
    let type = defs[0][0];
    for (const [candidate, weight] of defs) { roll -= weight; if (roll <= 0) { type = candidate; break; } }
    resources.push({ id: `resource-${i}`, x: Math.round(x), y: Math.round(y), type, biome });
  }
  return resources;
}
const previewWorldResources = previewResources();
const serverResources = previewWorldResources.map((resource, idx) => ({
  ...resource,
  idx,
  hp: resource.type === 'wood' ? 700 : resource.type === 'stone' ? 850 : 500,
  maxHp: resource.type === 'wood' ? 700 : resource.type === 'stone' ? 850 : 500,
  destroyed: false,
  lastHitBy: new Map()
}));

function findSafeMobSpawn() {
  const maxCoord = 3600;
  const minMobDist = 200;
  const minPlayerDist = 250;
  for (let attempt = 0; attempt < 30; attempt++) {
    const x = Math.round((Math.random() * 2 - 1) * maxCoord);
    const y = Math.round((Math.random() * 2 - 1) * maxCoord);
    let tooClose = false;
    for (const m of mobs.values()) {
      const dx = m.x - x, dy = m.y - y;
      if (dx * dx + dy * dy < minMobDist * minMobDist) { tooClose = true; break; }
    }
    if (!tooClose) {
      for (const p of players.values()) {
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy < minPlayerDist * minPlayerDist) { tooClose = true; break; }
      }
    }
    if (!tooClose) return { x, y };
  }
  return { x: Math.round((Math.random() * 2 - 1) * 3200), y: Math.round((Math.random() * 2 - 1) * 3200) };
}

function createMob() {
  const type = MOB_TYPES[(nextMobId - 1) % MOB_TYPES.length];
  const { x, y } = findSafeMobSpawn();
  const angle = Math.random() * Math.PI * 2;
  const mob = {
    id: `mob-${nextMobId++}`, x, y, vx: 0, vy: 0, radius: type.radius || MOB_RADIUS,
    hp: type.hp, maxHp: type.hp, color: type.color, outline: type.outline, shape: type.shape,
    eyes: type.eyes, typeName: type.typeName, dmg: type.dmg,
    speed: type.speed || MOB_SPEED, wanderSpeed: type.wanderSpeed || MOB_WANDER_SPEED,
    xpReward: type.xpReward || 35, goldReward: type.goldReward || 15,
    nextAttackAt: 0, wanderAngle: angle, angle, targetId: null, chaseUntil: 0, state: 'walk', stateSeq: 0, stateAt: Date.now(),
  };
  mobs.set(mob.id, mob);
  io.emit('mob_spawn', publicMob(mob));
  return mob;
}

function ensureMobs() {
  const target = Math.max(1, Math.round(MAX_MOBS * Math.max(0.1, Number(adminConfig.mobSpawnMultiplier) || 1)));
  while (mobs.size < target) createMob();
  while (mobs.size > target) {
    const oldest = mobs.keys().next().value;
    if (!oldest) break;
    mobs.delete(oldest);
    io.emit('mob_despawn', { id: oldest });
  }
}

function applyMobDamage(mob, target, damage, isWeb = false) {
  if (!mob || !target || (target.hp ?? 0) <= 0) return null;
  const targetSocket = io.sockets.sockets.get(target.id);
  if (!targetSocket || !targetSocket.connected) return null;
  const appliedDamage = Math.max(1, Math.round(Number(damage) || 1));
  applyPlayerDamage(target, appliedDamage);
  const hpAt = target.hpAt;
  const hpSeq = target.hpSeq;
  const payload = {
    id: target.id, hp: target.hp, dmg: appliedDamage, hpSeq, hpAt,
    sourceId: mob.id, sourceName: mob.typeName || 'Düşman', isWeb: Boolean(isWeb),
  };
  io.to(target.id).emit('player_take_damage', payload);
  io.to(target.id).emit('self_state', { hp: target.hp, hpSeq, hpAt });
  return payload;
}

function isPlayerCombatEligible(player, socketMap = io?.sockets?.sockets) {
  if (!player || typeof player !== 'object') return false;
  if ((player.hp ?? 0) <= 0 || player._dead === true) return false;
  if (!player.id) return false;
  const socket = socketMap ? socketMap.get(player.id) : null;
  return !!socket && socket.connected === true;
}

function isMobTargetEligible(mob, candidate, socketMap = io?.sockets?.sockets) {
  if (!mob || !candidate) return false;
  if (!isPlayerCombatEligible(candidate, socketMap)) return false;
  if (candidate.visibleMobIds && !candidate.visibleMobIds.has(mob.id)) return false;
  return true;
}

function applyPlayerDamage(target, damage) {
  target.hp = Math.max(0, (target.hp ?? 250) - Math.max(1, Math.round(Number(damage) || 1)));
  target.hpSeq = (target.hpSeq || 0) + 1;
  target.hpAt = Date.now();
  return target;
}

function sanitizePlayerLoadout(role, helmet) {
  const normalizedRole = String(role || 'tank').toLowerCase();
  const normalizedHelmet = String(helmet || 'guardian').toLowerCase();
  const resolvedRole = BUILD_ROLES[normalizedRole] ? normalizedRole : 'tank';
  const resolvedHelmet = BUILD_HELMETS[normalizedHelmet] ? normalizedHelmet : 'guardian';
  return {
    role: resolvedRole,
    helmet: resolvedHelmet,
    roleInfo: BUILD_ROLES[resolvedRole],
    helmetInfo: BUILD_HELMETS[resolvedHelmet]
  };
}

function buildLoadoutCatalog() {
  return {
    roles: Object.fromEntries(Object.entries(BUILD_ROLES).map(([key, value]) => [key, {
      ...value,
      id: key
    }])),
    helmets: Object.fromEntries(Object.entries(BUILD_HELMETS).map(([key, value]) => [key, {
      ...value,
      id: key
    }])),
    weapons: Object.fromEntries(Object.entries(WEAPON_DEFINITIONS).map(([key, value]) => [key, {
      ...value,
      id: key
    }])),
    sets: Object.fromEntries(Object.entries(LOADOUT_SETS).map(([key, value]) => [key, {
      ...value,
      id: key
    }]))
  };
}

function sanitizePremiumDesign(data = {}) {
  const weapon = String(data.designWeapon || data.weapon || 'sword').toLowerCase();
  const set = String(data.set || 'sunforge').toLowerCase();
  return {
    weapon: WEAPON_DEFINITIONS[weapon] ? weapon : 'sword',
    set: LOADOUT_SETS[set] ? set : 'sunforge'
  };
}

function applyLoadoutStats(player) {
  if (!player) return;
  const loadout = sanitizePlayerLoadout(player.role, player.helmet);
  const premiumDesign = sanitizePremiumDesign({
    weapon: player.designWeapon || (typeof player.weapon === 'string' ? player.weapon : 'sword'),
    set: player.loadoutSet
  });
  const weaponStats = WEAPON_DEFINITIONS[premiumDesign.weapon] || WEAPON_DEFINITIONS.sword;
  const setBonus = LOADOUT_SETS[premiumDesign.set] || LOADOUT_SETS.sunforge;
  const roleStats = BUILD_ROLES[loadout.role] || BUILD_ROLES.tank;
  const helmetStats = BUILD_HELMETS[loadout.helmet] || BUILD_HELMETS.guardian;
  const hpMultiplier = (roleStats.maxHp || 1) * (helmetStats.maxHp || 1);
  const damageMultiplier = (roleStats.damage || 1) * (helmetStats.damage || 1);
  const armorMultiplier = (roleStats.armor || 1) * (helmetStats.armor || 1);
  const speedMultiplier = (roleStats.speed || 1) * (helmetStats.speed || 1);
  const premiumDamageBuffer = Number(weaponStats.damage || 1) * 1.05;
  const baseMaxHp = Number(player.baseMaxHp) || 250;
  player.baseMaxHp = baseMaxHp;
  player.maxHp = Math.max(130, Math.round(baseMaxHp * hpMultiplier));
  player.hp = Math.min(player.maxHp, Math.max(1, Math.round((player.hp ?? player.maxHp) * (player.maxHp > 0 ? (player.maxHp / Math.max(1, baseMaxHp)) : 1))));
  player.damageMultiplier = damageMultiplier * premiumDamageBuffer;
  player.armorMultiplier = armorMultiplier;
  player.speedMultiplier = speedMultiplier * (Number(weaponStats.speed) || 1);
  player.role = loadout.role;
  player.helmet = loadout.helmet;
  player.designWeapon = premiumDesign.weapon;
  player.loadoutSet = premiumDesign.set;
  player.setInfo = setBonus;
  player.weaponInfo = weaponStats;
}

function stealDeathLoot(killer, target) {
  if (!killer || !target || killer.id === target.id) return;
  const stealRate = 0.2;
  const goldStolen = Math.max(0, Math.floor((Number(target.gold) || 0) * stealRate));
  const scoreStolen = Math.max(0, Math.floor((Number(target.score) || 0) * stealRate));
  const woodStolen = Math.max(0, Math.floor((Number(target.wood) || 0) * stealRate));
  const stoneStolen = Math.max(0, Math.floor((Number(target.stone) || 0) * stealRate));
  if (goldStolen > 0) {
    killer.gold = (killer.gold || 0) + goldStolen;
    target.gold = Math.max(0, (target.gold || 0) - goldStolen);
  }
  if (scoreStolen > 0) {
    killer.score = (killer.score || 0) + scoreStolen;
    target.score = Math.max(0, (target.score || 0) - scoreStolen);
  }
  if (woodStolen > 0) {
    killer.wood = (killer.wood || 0) + woodStolen;
    target.wood = Math.max(0, (target.wood || 0) - woodStolen);
  }
  if (stoneStolen > 0) {
    killer.stone = (killer.stone || 0) + stoneStolen;
    target.stone = Math.max(0, (target.stone || 0) - stoneStolen);
  }
  persistPlayerScore(killer);
  persistPlayerScore(target);
}

function publicAirdrop(ad) {
  return {
    id: ad.id,
    x: ad.x,
    y: ad.y,
    hp: ad.hp,
    maxHp: ad.maxHp,
    gold: ad.gold,
    tier: ad.tier || 1,
    spawnedAt: ad.spawnedAt
  };
}

function spawnAirdrop() {
  if (airdrops.size >= 4) return;
  const x = Math.round((Math.random() * 2 - 1) * 3200);
  const y = Math.round((Math.random() * 2 - 1) * 3200);
  const tier = Math.random() < 0.3 ? 2 : 1;
  const gold = tier === 2 ? (350 + Math.floor(Math.random() * 250)) : (180 + Math.floor(Math.random() * 150));
  const hp = tier === 2 ? 500 : 300;
  const ad = {
    id: `airdrop-${nextAirdropId++}`,
    x, y, hp, maxHp: hp, gold, tier,
    spawnedAt: Date.now()
  };
  airdrops.set(ad.id, ad);
  io.emit('airdrop_spawn', publicAirdrop(ad));
}

function updateBounty() {
  if (!BOUNTY_EVENT_ENABLED) {
    currentBountyId = null;
    return;
  }
}

function releaseTrapVictims(trapId) {
  for (const player of players.values()) {
    if (player.trappedBy === trapId) releaseTrapVictim(player.id, trapId);
  }
}

function removeBuilding(id) {
  const building = buildings.get(id);
  if (!building) return false;
  if (Number(building.type) === 6) releaseTrapVictims(id);
  buildings.delete(id);
  rebuildBuildingGrid();
  io.emit('build_destroy', { id });
  io.emit('trap_freed', { buildingId: id });
  return true;
}

function deletePlayerBuildings(playerId) {
  if (!playerId) return;
  for (const [id, b] of buildings) {
    if (b.ownerId === playerId || b._ownerId === playerId) {
      removeBuilding(id);
    }
  }
}

function sweepOrphanBuildings() {
  const orphanIds = [];
  for (const [id, building] of buildings) {
    if (!building || !building.ownerId) {
      orphanIds.push(id);
      continue;
    }

    const owner = players.get(building.ownerId);
    const socket = io.sockets?.sockets?.get(building.ownerId) || null;
    const clan = building.ownerClanId ? clans.get(building.ownerClanId) : null;
    const ownerIsLive = Boolean(owner && socket && socket.connected && socket.id === building.ownerId);
    const clanStillValid = !building.ownerClanId || Boolean(clan && clan.members?.some(member => member.id === building.ownerId));

    if (!ownerIsLive || !clanStillValid) {
      orphanIds.push(id);
    }
  }

  for (const id of orphanIds) {
    removeBuilding(id);
  }

  return orphanIds.length;
}

function onPlayerDeath(playerId) {
  if (!playerId) return;
  releaseTrapVictim(playerId);
  deletePlayerBuildings(playerId);
  const target = players.get(playerId);
  if (target) {
    target.wood = 0;
    target.stone = 0;
    target.gold = 0;
    target.apples = 5;
    target.score = 0;
    target.sc = 0;
    target._dead = true;
    if (target._guestId) {
      reconnectSessions.delete(target._guestId);
    }
  }
}

function applyTrapVictimState(target, trapId, trapX = target?.x, trapY = target?.y) {
  if (!target || !trapId) return false;
  const trap = buildings.get(trapId);
  if (!trap || trap.type !== 6 || (trap.hp ?? 0) <= 0) {
    return releaseTrapVictim(target.id, trapId);
  }
  target.trappedBy = trapId;
  target.trappedX = Number.isFinite(Number(trapX)) ? normalizeWorldCoord(Number(trapX), target.x || 0) : (Number(target.x) || 0);
  target.trappedY = Number.isFinite(Number(trapY)) ? normalizeWorldCoord(Number(trapY), target.y || 0) : (Number(target.y) || 0);
  target.x = target.trappedX;
  target.y = target.trappedY;
  target.vx = 0;
  target.vy = 0;
  io.emit('trap_state', {
    id: target.id, trappedBy: trapId, trappedX: target.trappedX, trappedY: target.trappedY,
    x: target.x, y: target.y, at: Date.now()
  });
  return true;
}

function releaseTrapVictim(playerId, trapId = null) {
  const target = players.get(playerId);
  if (!target || !target.trappedBy) return false;
  const activeTrapId = trapId ?? target.trappedBy;
  if (!activeTrapId || (trapId && target.trappedBy !== trapId)) return false;
  const trap = buildings.get(activeTrapId);
  const ownerId = trap?.ownerId || null;
  target.trappedBy = null;
  target.trappedX = null;
  target.trappedY = null;
  target.vx = 0;
  target.vy = 0;
  io.emit('trap_state', {
    id: target.id, trappedBy: null, trappedX: null, trappedY: null,
    x: target.x, y: target.y, at: Date.now()
  });
  io.to(playerId).emit('trap_freed', { buildingId: activeTrapId });
  if (ownerId) {
    io.to(ownerId).emit('trap_victim_freed', { victimId: playerId, buildingId: activeTrapId });
  }
  return true;
}

function capturePlayerInTrap(target) {
  if (!target || target.hp <= 0 || target.trappedBy) return false;
  for (const building of buildings.values()) {
    if (building.type !== 6 || (building.hp ?? 0) <= 0 || building.ownerId === target.id) continue;
    const dx = (Number(target.x) || 0) - (Number(building.x) || 0);
    const dy = (Number(target.y) || 0) - (Number(building.y) || 0);
    const triggerRadius = (Number(building.radius) || 78) + 34;
    if (dx * dx + dy * dy > triggerRadius * triggerRadius) continue;
    if (!applyTrapVictimState(target, building.id, target.x, target.y)) continue;
    io.to(target.id).emit('trap_caught', { buildingId: building.id, x: target.x, y: target.y });
    io.emit('trap_triggered', { buildingId: building.id, victimId: target.id, x: target.x, y: target.y });
    return true;
  }
  return false;
}

function capturePlayerInSpecificTrap(target, building) {
  if (!target || target.hp <= 0 || target.trappedBy || !building) return false;
  if (building.type !== 6 || (building.hp ?? 0) <= 0 || building.ownerId === target.id) return false;
  const dx = (Number(target.x) || 0) - (Number(building.x) || 0);
  const dy = (Number(target.y) || 0) - (Number(building.y) || 0);
  const triggerRadius = (Number(building.radius) || 78) + (Number(target.radius) || 34);
  if (dx * dx + dy * dy > triggerRadius * triggerRadius) return false;
  if (!applyTrapVictimState(target, building.id, target.x, target.y)) return false;
  io.to(target.id).emit('trap_caught', { buildingId: building.id, x: target.x, y: target.y });
  io.emit('trap_triggered', { buildingId: building.id, victimId: target.id, x: target.x, y: target.y });
  return true;
}

function pushTrappedVictim(owner, target, dx, dy, requestedStep = 1) {
  if (!owner || !target || !target.trappedBy || target.hp <= 0) return false;
  const trap = buildings.get(target.trappedBy);
  if (!trap || trap.ownerId !== owner.id || (trap.hp ?? 0) <= 0) return false;
  const length = Math.hypot(dx, dy) || 1;
  const cooldownKey = `${owner.id}:${target.id}`;
  const now = Date.now();
  if (now - (trapPushCooldowns.get(cooldownKey) || 0) < 16) return false;
  trapPushCooldowns.set(cooldownKey, now);
  const step = Math.min(2.4, Math.max(0.35, Number(requestedStep) || 1));
  const pushX = (dx / length) * step;
  const pushY = (dy / length) * step;
  target.trappedX += pushX;
  target.trappedY += pushY;
  const maxDistance = (Number(trap.radius) || 78) + 44;
  const trapDx = target.trappedX - (Number(trap.x) || 0);
  const trapDy = target.trappedY - (Number(trap.y) || 0);
  const trapDistance = Math.hypot(trapDx, trapDy);
  if (trapDistance > maxDistance) {
    target.trappedX = (Number(trap.x) || 0) + (trapDx / (trapDistance || 1)) * maxDistance;
    target.trappedY = (Number(trap.y) || 0) + (trapDy / (trapDistance || 1)) * maxDistance;
  }
  target.x = target.trappedX;
  target.y = target.trappedY;
  io.emit('trap_state', {
    id: target.id, trappedBy: target.trappedBy, trappedX: target.trappedX, trappedY: target.trappedY,
    x: target.x, y: target.y, at: now
  });
  io.to(target.id).emit('trap_victim_push', { dx: pushX, dy: pushY });
  io.emit('players', { [target.id]: compactState(target) });
  return true;
}

function dedupeTrapState(target, trapId) {
  if (!target || !trapId) return false;
  const trap = buildings.get(trapId);
  if (!trap || trap.type !== 6 || (trap.hp ?? 0) <= 0) {
    return releaseTrapVictim(target.id, trapId);
  }
  const trapDx = (Number(target.x) || 0) - (Number(trap.x) || 0);
  const trapDy = (Number(target.y) || 0) - (Number(trap.y) || 0);
  const leashRadius = (Number(trap.radius) || 78) + 26;
  if (trapDx * trapDx + trapDy * trapDy > leashRadius * leashRadius) {
    target.x = Number(trap.x) + (trapDx / (Math.hypot(trapDx, trapDy) || 1)) * leashRadius;
    target.y = Number(trap.y) + (trapDy / (Math.hypot(trapDx, trapDy) || 1)) * leashRadius;
    target.trappedX = target.x;
    target.trappedY = target.y;
    io.emit('trap_state', {
      id: target.id, trappedBy: trapId, trappedX: target.trappedX, trappedY: target.trappedY,
      x: target.x, y: target.y, at: Date.now()
    });
  }
  return true;
}

function enforceCanonicalTrapLock(target) {
  if (!target || !target.trappedBy) return false;
  const trap = buildings.get(target.trappedBy);
  if (!trap || trap.type !== 6 || (trap.hp ?? 0) <= 0) {
    return releaseTrapVictim(target.id, target.trappedBy);
  }
  const trapX = Number(trap.x) || 0;
  const trapY = Number(trap.y) || 0;
  const currentX = Number(target.x) || 0;
  const currentY = Number(target.y) || 0;
  const trapDx = currentX - trapX;
  const trapDy = currentY - trapY;
  const leashRadius = (Number(trap.radius) || 78) + 26;
  const distance = Math.hypot(trapDx, trapDy) || 1;
  if (distance > leashRadius) {
    const clampedX = trapX + (trapDx / distance) * leashRadius;
    const clampedY = trapY + (trapDy / distance) * leashRadius;
    target.x = clampedX;
    target.y = clampedY;
    target.trappedX = clampedX;
    target.trappedY = clampedY;
    target.vx = 0;
    target.vy = 0;
    io.emit('trap_state', {
      id: target.id,
      trappedBy: target.trappedBy,
      trappedX: target.trappedX,
      trappedY: target.trappedY,
      x: target.x,
      y: target.y,
      at: Date.now()
    });
    return true;
  }
  if (target.trappedX == null || target.trappedY == null) {
    target.trappedX = currentX;
    target.trappedY = currentY;
  }
  return true;
}

function resolveTrapOwnerCollisions(owner) {
  if (!owner || owner.hp <= 0) return;
  for (const target of players.values()) {
    if (target.id === owner.id || !target.trappedBy || target.hp <= 0) continue;
    const trap = buildings.get(target.trappedBy);
    if (!trap || trap.ownerId !== owner.id) continue;
    const dx = (Number(target.x) || 0) - (Number(owner.x) || 0);
    const dy = (Number(target.y) || 0) - (Number(owner.y) || 0);
    const distance = Math.hypot(dx, dy) || 0.01;
    const ownerRadius = Number(owner.radius) || 34;
    const targetRadius = Number(target.radius) || 34;
    const trapRadius = Number(trap.radius) || 78;
    const ownerToTrap = Math.hypot((Number(owner.x) || 0) - (Number(trap.x) || 0), (Number(owner.y) || 0) - (Number(trap.y) || 0));
    const ownerClearance = trapRadius + ownerRadius - 2;
    if (ownerToTrap < ownerClearance) continue;
    const pushRange = trapRadius + ownerRadius + targetRadius + 24;
    if (distance < pushRange) {
      const pushStep = Math.min(2.4, Math.max(0.35, (pushRange - distance) * 0.1));
      pushTrappedVictim(owner, target, dx, dy, pushStep);
    }
  }
}

function broadcastMobIds() {
  rebuildMobGrid();
  for (const [id, player] of players) {
    const socket = io.sockets.sockets.get(id);
    if (!socket) continue;
    const visibleMobs = nearbyMobs(player.x, player.y, MOB_AOI_RADIUS);
    player.visibleMobIds = new Set(visibleMobs.map(mob => mob.id));
    socket.emit('mob_ids', [...player.visibleMobIds]);
    socket.emit('mob_states', visibleMobs.map(publicMob));
  }
}

// The server owns mob positions so every connected player renders the same world.
setInterval(() => {
  const hasSpectators = [...io.sockets.sockets.values()].some(client => client.data.isSpectator);
  if (players.size === 0 && !hasSpectators) return;
  ensureMobs();
  const changed = [];
  const now = Date.now();
  for (const mob of mobs.values()) {
    mob.stateSeq = (mob.stateSeq || 0) + 1;
    mob.stateAt = now;
    if (mob.trappedBy) {
      const b = buildings.get(mob.trappedBy);
      if (b && (b.hp ?? 100) > 0 && now < (mob.trappedUntil || 0)) {
        mob.vx = 0;
        mob.vy = 0;
        mob.x = mob.trappedX ?? mob.x;
        mob.y = mob.trappedY ?? mob.y;
        changed.push(publicMob(mob));
        continue; // Mob is trapped in place — CANNOT chase or attack distant players!
      } else {
        mob.trappedBy = null;
        mob.trappedUntil = 0;
        io.emit('mob_freed', { mobId: mob.id });
      }
    }

    let target = mob.targetId ? players.get(mob.targetId) : null;
    if (target && !isMobTargetEligible(mob, target)) target = null;
    if (!target || (target.hp ?? 0) <= 0) {
      mob.targetId = null;
      target = null;
    }
    if (!target) {
      let nearestDistance = MOB_AGGRO_RANGE * MOB_AGGRO_RANGE;
      for (const candidate of players.values()) {
        if (!isMobTargetEligible(mob, candidate)) continue;
        const dx = candidate.x - mob.x, dy = candidate.y - mob.y;
        const distance = dx * dx + dy * dy;
        if (distance < nearestDistance) { target = candidate; nearestDistance = distance; }
      }
      if (target) {
        mob.targetId = target.id;
        mob.chaseUntil = now + MOB_CHASE_TIMEOUT;
      }
    }
    const targetDistance = target ? ((target.x - mob.x) ** 2 + (target.y - mob.y) ** 2) : Infinity;
    if (target && now < mob.chaseUntil) {
      const distance = Math.sqrt(targetDistance) || 1;
      const spd = mob.speed || MOB_SPEED;
      mob.angle = Math.atan2(target.y - mob.y, target.x - mob.x);
      mob.vx = (target.x - mob.x) / distance * spd;
      mob.vy = (target.y - mob.y) / distance * spd;

      // Spider special ranged attack (distance 75 to 300, 5-second cooldown)
      if ((mob.shape === 'spider' || mob.shape === 'orumcek') && distance < 300 && distance > 70 && now >= (mob.nextWebAt || 0)) {
        mob.nextWebAt = now + 5000;
        mob.nextAttackAt = now + 1600;
        mob.chaseUntil = now + MOB_CHASE_TIMEOUT;
        mob.state = 'attack';
        const webDmg = 16;
        const webDamage = applyMobDamage(mob, target, webDmg, true);
        io.emit('mob_attack', {
          id: mob.id, targetId: target.id, dmg: webDmg, hp: webDamage?.hp, hpSeq: webDamage?.hpSeq,
          typeName: mob.typeName, shape: mob.shape, isWeb: true,
          x: mob.x, y: mob.y, angle: mob.angle, targetX: target.x, targetY: target.y, seq: mob.stateSeq, ts: mob.stateAt
        });
      }
      // Melee attack for all mobs
      else if (distance < (mob.radius + 60) && now >= (mob.nextAttackAt || 0) && (now - (target.stateAt || 0) < 600)) {
        const meleeDamage = applyMobDamage(mob, target, mob.dmg);
        mob.nextAttackAt = now + 1600;
        mob.chaseUntil = now + MOB_CHASE_TIMEOUT;
        mob.state = 'attack';
        io.emit('mob_attack', {
          id: mob.id, targetId: target.id, dmg: mob.dmg, hp: meleeDamage?.hp, hpSeq: meleeDamage?.hpSeq,
          typeName: mob.typeName, shape: mob.shape,
          x: mob.x, y: mob.y, angle: mob.angle, targetX: target.x, targetY: target.y, seq: mob.stateSeq, ts: mob.stateAt
        });
        io.emit('players', { [target.id]: compactState(target) });
        if (target.hp <= 0) {
          onPlayerDeath(target.id);
          io.to(target.id).emit('pvp_killed', { byName: mob.typeName });
          io.emit('player_dead', { id: target.id });
        }
      } else if (mob.state === 'attack' && now >= (mob.nextAttackAt || 0) - 800) {
        mob.state = 'walk';
      }
    } else {
      mob.targetId = null;
      mob.state = 'walk';
      if (Math.random() < 0.06) mob.wanderAngle += (Math.random() - 0.5) * 1.4;
      const wspd = mob.wanderSpeed || MOB_WANDER_SPEED;
      if (mob.x > 3600) { mob.wanderAngle = Math.PI * (0.8 + Math.random() * 0.4); mob.x = 3590; }
      else if (mob.x < -3600) { mob.wanderAngle = Math.random() * 0.4 * Math.PI - 0.2 * Math.PI; mob.x = -3590; }
      if (mob.y > 3600) { mob.wanderAngle = -Math.PI * (0.3 + Math.random() * 0.4); mob.y = 3590; }
      else if (mob.y < -3600) { mob.wanderAngle = Math.PI * (0.3 + Math.random() * 0.4); mob.y = -3590; }
      mob.angle = mob.wanderAngle;
      mob.vx = Math.cos(mob.wanderAngle) * wspd;
      mob.vy = Math.sin(mob.wanderAngle) * wspd;
    }

    mob.x += mob.vx;
    mob.y += mob.vy;

    // Solid collision push-out against resources (trees, rocks, gold)
    const nearbyObstacles = nearbyServerObstacles(mob.x, mob.y, mob.radius + 60);
    for (let oi = 0; oi < nearbyObstacles.length; oi++) {
      const obs = nearbyObstacles[oi];
      const ox = mob.x - obs.x, oy = mob.y - obs.y;
      const oDist2 = ox * ox + oy * oy;
      const minODist = mob.radius + obs.radius;
      if (oDist2 < minODist * minODist && oDist2 > 0) {
        const oDist = Math.sqrt(oDist2) || 1;
        const push = minODist - oDist;
        mob.x += (ox / oDist) * push;
        mob.y += (oy / oDist) * push;
        const dot = mob.vx * (ox / oDist) + mob.vy * (oy / oDist);
        if (dot < 0) {
          mob.vx -= dot * (ox / oDist);
          mob.vy -= dot * (oy / oDist);
        }
      }
    }

    // Solid collision push-out against buildings
    for (const b of nearbyBuildings(mob.x, mob.y, mob.radius + 120)) {
      if (b.type === 5) continue; // Boost pad allows walkover
      if (b.type === 6 && (b.hp ?? 100) > 0) {
        // Trap capture check
        const tdx = mob.x - b.x, tdy = mob.y - b.y;
        if (tdx * tdx + tdy * tdy < 45 * 45) {
          mob.trappedBy = b.id;
          mob.trappedX = b.x; mob.trappedY = b.y;
          mob.trappedUntil = now + 4000;
          io.emit('mob_trapped', { mobId: mob.id, buildingId: b.id });
          break;
        }
      }
      const bdx = mob.x - b.x, bdy = mob.y - b.y;
      const bdist2 = bdx * bdx + bdy * bdy;
      const minBdist = mob.radius + (b.type === 8 ? 42 : 36);
      if (bdist2 < minBdist * minBdist && bdist2 > 0) {
        const bdist = Math.sqrt(bdist2) || 1;
        const push = minBdist - bdist;
        mob.x += (bdx / bdist) * push;
        mob.y += (bdy / bdist) * push;
        if (b.type === 3 && (b.hp ?? 100) > 0) { // Spike damage
          const spikeTier = b.tier || 0;
          const spikeDmg = [45, 75, 110, 160, 220, 300][spikeTier] || 45;
          mob.hp = Math.max(0, mob.hp - spikeDmg);
          mob.stateSeq = (mob.stateSeq || 0) + 1;
          io.emit('mob_update', { id: mob.id, seq: mob.stateSeq, ts: mob.stateAt, hp: mob.hp, maxHp: mob.maxHp, hitFlash: 8 });
          if (mob.hp <= 0) {
            mobs.delete(mob.id);
            const ownerId = b.ownerId || b._ownerId;
            io.emit('mob_dead', { id: mob.id, killerId: ownerId });
            const owner = players.get(ownerId);
            if (owner) {
              const trapGold = Math.max(1, Math.floor((mob.goldReward || 10) * 0.65));
              owner.gold = (owner.gold || 0) + trapGold;
              owner.score = (owner.score || 0) + trapGold * 3;
              persistPlayerScore(owner);
            }
          }
          break;
        }
      }
    }

    mob.x = Math.max(-3650, Math.min(3650, mob.x));
    mob.y = Math.max(-3650, Math.min(3650, mob.y));

    changed.push(compactMobTick(mob));
  }
  syncMobVisibility(changed);
}, 100);

// 30Hz Server Game Tick: send player states only to nearby clients.
setInterval(() => {
  if (players.size === 0) return;
  rebuildPlayerGrid();
  const now = Date.now();
  const livingPlayers = [...players.values()].filter((p) => p && (p.hp ?? 0) > 0);
  for (const p of livingPlayers) {
    if (p.isAttacking && now > (p.attackUntil || 0)) p.isAttacking = false;
    updatePlayerRoom(p);
  }
  for (const [recipientId, socket] of io.sockets.sockets) {
    if (!socket.connected) continue;
    const recipient = players.get(recipientId);
    if (!recipient) continue;
    const previousVisible = recipient.visiblePlayerIds || new Set();
    const nextVisible = new Set();
    const batch = {};
    const targetRoomIds = nearbyRoomIds(Number(recipient.x) || 0, Number(recipient.y) || 0, PLAYER_AOI_RADIUS);
    if (socket.data.isSpectator) {
      const spectatorBatch = {};
      for (const p of livingPlayers) spectatorBatch[p.id] = compactStateCompressed(p);
      if (Object.keys(spectatorBatch).length > 0) socket.volatile.emit('players', spectatorBatch);
      continue;
    }
    const nearbyPlayersSet = new Set();
    for (const roomId of targetRoomIds) {
      for (const player of getRoomMembers(roomId)) {
        if (!player || player.id === recipientId) continue;
        nearbyPlayersSet.add(player.id);
      }
    }
    for (const id of nearbyPlayersSet) {
      const p = players.get(id);
      if (!p || (p.hp ?? 0) <= 0) continue;
      nextVisible.add(p.id);
      batch[p.id] = compactStateCompressed(p);
      if (!previousVisible.has(p.id)) {
        socket.emit('player_join', { id: p.id, state: compactFullState(p), aoi: true });
      }
    }
    for (const id of previousVisible) {
      if (!nextVisible.has(id)) socket.emit('player_despawn', { id });
    }
    recipient.visiblePlayerIds = nextVisible;
    if (Object.keys(batch).length > 0) socket.volatile.emit('players', batch);
  }
}, 20);

// Broadcast short-lived Thor strikes so every connected client sees the same ground effect.
setInterval(() => {
  const thorPlayers = [...players.values()].filter(p => p && p.skin === 'thor' && (p.hp ?? 0) > 0);
  if (!thorPlayers.length) return;
  const strikes = [];
  const now = Date.now();
  for (const thor of thorPlayers) {
    for (let i = 0; i < 8; i++) {
      const angle = (now * 0.001 + i * 2.399 + thor.id.length) % (Math.PI * 2);
      const distance = 120 + ((now / 90 + i * 137) % 760);
      strikes.push({ sx: thor.x, sy: thor.y, x: thor.x + Math.cos(angle) * distance, y: thor.y + Math.sin(angle) * distance, at: now, seed: i });
    }
  }
  io.emit('thor_lightning', { strikes: strikes.slice(0, 32), at: now });
}, 700);

// Periodic server loop (1Hz): Windmill generation, stats confirmation and reconciliation
setInterval(() => {
  if (players.size === 0) return;

  // 1. Authoritative Windmill (type === 4) Tick: generate +15 gold and tier score every second
  if (buildings.size > 0) {
    const WINDMILL_SCORES = [10, 22, 50, 110, 220, 500];
    for (const b of buildings.values()) {
      if (Number(b.type) === 4 && (b.hp === undefined || b.hp > 0)) {
        const owner = players.get(b.ownerId);
        if (owner && (owner.hp ?? 0) > 0) {
          const wTier = Math.min(5, Math.max(0, Number(b.tier) || 0));
          const wGold = 15;
          const wScore = WINDMILL_SCORES[wTier] || 10;
          const ownerSocket = io.sockets.sockets.get(owner.id);
          if (!ownerSocket?.connected) continue;
          owner.gold = (owner.gold || 0) + wGold;
          owner.score = (owner.score || 0) + wScore;
          if (owner._authUser) {
            owner._authUser.coins = (owner._authUser.coins || 0) + wGold;
            owner._authUser.gold = owner._authUser.coins;
            owner._authUser.score = Math.max(owner._authUser.score || 0, owner.score);
          }
        }
      }
    }
  }

  // 2. Periodic self_state confirmation (1Hz)
  for (const [id, p] of players) {
    if (!p || (p.hp ?? 0) <= 0) continue;
    const s = io.sockets.sockets.get(id);
    if (s && s.connected) {
      s.emit('self_state', {
        x: p.x, y: p.y, hp: p.hp, hpSeq: p.hpSeq || 0, hpAt: p.hpAt || 0,
        sc: p.score, g: p.gold, xp: p.xp, seq: p.stateSeq || 0,
        wood: p.wood, stone: p.stone, apples: p.apples
      });
    }
  }
}, 1000);

setInterval(broadcastMobIds, 2000);

// Realtime leaderboard & bounty updates every 2s
setInterval(() => {
  if (players.size === 0) return;
  updateBounty();
  const list = [...players.values()]
    .filter(p => p && p.id && io.sockets.sockets.get(p.id)?.connected)
    .map(p => ({
      id: p.id,
      name: p.name || 'forestbrawl',
      xp: Number(p.xp ?? p._authUser?.xp ?? 0),
      rankId: rankInfo(Number(p.xp ?? p._authUser?.xp ?? 0)).visualRankId,
      rankName: rankInfo(Number(p.xp ?? p._authUser?.xp ?? 0)).name,
      score: Number(p.score ?? p.gold ?? 0),
      gold: Number(p.gold ?? 0),
      kills: p.kills || 0,
      profileCosmetics: p._authUser ? {
        avatarId: p._authUser.equippedItems?.profil_avatar || 'wolf',
        effectId: p._authUser.equippedItems?.profil_efekt || p._authUser.equippedItems?.efektler || 'effect_none',
        frameId: p._authUser.equippedItems?.profil_cerceve || 'frame_woodland'
      } : (p.profileCosmetics || { avatarId: 'wolf', effectId: 'effect_none', frameId: 'frame_woodland' })
    }))
    .sort((a, b) => (b.gold - a.gold) || (b.score - a.score) || (b.xp - a.xp))
    .slice(0, 10);
  io.emit('live_lb', list);
}, 2000);

// Periodic Airdrop Treasure Chest event (every ~60-90s)
setInterval(() => {
  if (players.size > 0 && (Date.now() - lastAirdropSpawn > 75000 || airdrops.size === 0)) {
    lastAirdropSpawn = Date.now();
    spawnAirdrop();
  }
}, 30000);

// Auto-cleanup ONLY when socket is actually disconnected.
// Never delete connected players even if they are in death/respawn screen!
setInterval(() => {
  if (players.size === 0) return;
  const now = Date.now();
  for (const [id, player] of players) {
    const socket = io.sockets.sockets.get(id);
    const isDisconnected = !socket || !socket.connected;
    if (isDisconnected && (now - (player.stateAt || now) > 60000)) {
      onPlayerDeath(id);
      players.delete(id);
      io.emit('player_dead', { id });
      io.emit('player_left', { id, name: player.name || 'Oyuncu' });
      broadcastOnlineCount();
    }
  }
}, 3000);

setInterval(() => {
  sweepOrphanBuildings();
}, 5000);

io.on('connection', (socket) => {
  const clientIp = requestClientKey(socket.request || { headers: {}, socket: socket.conn?.transport?.socket });
  if (isClientBanned(clientIp, null)) {
    socket.emit('server_announce', { message: 'Sunucudan yasaklandınız (Banned).', msg: 'Sunucudan yasaklandınız (Banned).', text: 'Sunucudan yasaklandınız (Banned).', level: 'warning', title: 'YASAKLANDINIZ' });
    socket.disconnect(true);
    return;
  }
  socket.emit('online_count', io.engine.clientsCount);

  socket.on('spectate', () => {
    socket.data.isSpectator = true;
    ensureMobs();
    const currentPlayers = Object.fromEntries([...players].map(([id, player]) => [id, compactState(player)]));
    socket.emit('welcome', {
      id: socket.id,
      players: currentPlayers,
      buildings: Object.fromEntries(buildings),
      worldSeed,
      resHp: Object.fromEntries(serverResources.map(resource => [resource.idx, { hp: resource.hp, maxHp: resource.maxHp, destroyed: resource.destroyed }])),
      mobs: [...mobs.values()].map(publicMob),
      resources: previewWorldResources,
      airdrops: [...airdrops.values()].map(publicAirdrop),
      bountyId: currentBountyId,
      isHost: false,
      isSpectator: true,
      announcement: adminConfig.announcement || ''
    });
    socket.emit('mob_ids', [...mobs.keys()]);
  });

  socket.on('loadout_select', (data = {}) => {
    const player = players.get(socket.id);
    if (!player) return;
    const nextLoadout = sanitizePlayerLoadout(data.role, data.helmet);
    const premiumDesign = sanitizePremiumDesign(data);
    player.role = nextLoadout.role;
    player.helmet = nextLoadout.helmet;
    player.designWeapon = premiumDesign.weapon;
    player.loadoutSet = premiumDesign.set;
    applyLoadoutStats(player);
    socket.emit('loadout_update', {
      role: player.role,
      helmet: player.helmet,
      weapon: player.designWeapon,
      set: player.loadoutSet,
      weaponInfo: player.weaponInfo,
      setInfo: player.setInfo,
      roleInfo: BUILD_ROLES[player.role],
      helmetInfo: BUILD_HELMETS[player.helmet],
      maxHp: player.maxHp,
      damageMultiplier: player.damageMultiplier,
      armorMultiplier: player.armorMultiplier,
      speedMultiplier: player.speedMultiplier,
      at: Date.now()
    });
  });

  socket.on('join', (data = {}) => {
    if (players.has(socket.id)) {
      const existing = players.get(socket.id);
      if (existing) normalizePlayerSnapshot(existing);
      socket.emit('welcome', {
        id: socket.id,
        players: Object.fromEntries([...players].filter(([id]) => id !== socket.id).map(([id, player]) => [id, compactFullState(player)])),
        buildings: Object.fromEntries(buildings),
        worldSeed,
        resHp: Object.fromEntries(serverResources.map(resource => [resource.idx, { hp: resource.hp, maxHp: resource.maxHp, destroyed: resource.destroyed }])),
        mobs: [...mobs.values()].map(publicMob),
        airdrops: [...airdrops.values()].map(publicAirdrop),
        bountyId: currentBountyId,
        isHost: players.size <= 1,
        announcement: adminConfig.announcement || '',
        loadoutCatalog: buildLoadoutCatalog(),
        loadout: {
          role: existing.role || 'tank', helmet: existing.helmet || 'guardian',
          weapon: existing.designWeapon || 'sword', set: existing.loadoutSet || 'sunforge'
        }
      });
      socket.emit('mob_ids', [...mobs.keys()]);
      return;
    }
    const authUser = verifyToken(data.token);
    const playerName = authUser ? authUser.username : (String(data.name || 'forestbrawl').trim().slice(0, 20) || 'forestbrawl');
    if (isClientBanned(clientIp, playerName)) {
      socket.emit('server_announce', { message: 'Bu hesap veya IP adresi yasaklanmıştır.', msg: 'Bu hesap veya IP adresi yasaklanmıştır.', text: 'Bu hesap veya IP adresi yasaklanmıştır.', level: 'warning', title: 'YASAKLANDINIZ' });
      socket.disconnect(true);
      return;
    }
    if (adminConfig.maintenance) {
      socket.emit('server_announce', { message: 'Sunucu bakım modunda. Birazdan tekrar deneyin.', msg: 'Sunucu bakım modunda. Birazdan tekrar deneyin.', text: 'Sunucu bakım modunda. Birazdan tekrar deneyin.', level: 'warning', title: 'SUNUCU BAKIMI' });
      return;
    }
    socket.data.authUser = authUser || null;
    const playerRank = authUser ? rankInfo(authUser.xp || 0) : rankInfo(Number(data.xp || 0));
    const initialScore = authUser ? Math.max(0, Number(authUser.score) || 0) : 0;
    const initialGold = authUser ? Math.max(0, Number(authUser.gold) || 0) : 100;
    const initialXp = Math.max(0, Number(authUser?.xp) || 0);
    const requestedSkin = String(data.skin || 'default');
    const guestId = String(data.guestId || '').slice(0, 80);
    const baseWorldX = normalizeWorldCoord(data.x, 0);
    const baseWorldY = normalizeWorldCoord(data.y, 0);
    const state = {
      ...data,
      x: baseWorldX,
      y: baseWorldY,
      skin: requestedSkin === 'thor' && !canUseThor(authUser) ? 'wolf' : requestedSkin,
      name: playerName,
      rk: playerRank.visualRankId,
      rankId: playerRank.rankId,
      visualRankId: playerRank.visualRankId,
      rankName: playerRank.name,
      hp: clampNumber(data.hp ?? 250, 250, 0, clampNumber(data.maxHp ?? 250, 250, 1, 5000)),
      maxHp: clampNumber(data.maxHp ?? 250, 250, 1, 5000),
      baseMaxHp: 250,
      hpSeq: 0,
      gold: initialGold,
      xp: initialXp,
      kills: authUser ? Math.max(0, Number(authUser.kills) || 0) : 0,
      score: initialScore,
      sc: initialScore,
      id: socket.id,
      clanId: '',
      clanTag: '',
      wood: 50,
      stone: 30,
      apples: 5,
      weapon: Number(data.weapon) || 1,
      designWeapon: sanitizePremiumDesign(data).weapon,
      loadoutSet: sanitizePremiumDesign(data).set,
      axeTier: Number(data.axeTier) || 0,
      swordTier: Number(data.swordTier) || 0,
      role: sanitizePlayerLoadout(data.role, data.helmet).role,
      helmet: sanitizePlayerLoadout(data.role, data.helmet).helmet,
      damageMultiplier: Number(data.damageMultiplier) || 1,
      armorMultiplier: Number(data.armorMultiplier) || 1,
      speedMultiplier: Number(data.speedMultiplier) || 1,
      axeSkin: data.axeSkin || data.acc?.b || null,
      swordSkin: data.swordSkin || data.acc?.w || null,
      buildX: typeof data.buildX === 'number' ? data.buildX : null,
      buildY: typeof data.buildY === 'number' ? data.buildY : null,
      profileCosmetics: authUser?.equippedItems ? {
        avatarId: authUser.equippedItems.profil_avatar || 'wolf',
        effectId: authUser.equippedItems.profil_efekt || authUser.equippedItems.efektler || 'effect_none',
        frameId: authUser.equippedItems.profil_cerceve || 'frame_woodland'
      } : (data.profileCosmetics || null),
      visibleMobIds: new Set(),
      visiblePlayerIds: new Set(),
      hpAt: Date.now(),
      stateAt: Date.now(),
      _guestId: guestId,
      _authUser: authUser
    };
    applyLoadoutStats(state);
    const reconnectSession = guestId ? reconnectSessions.get(guestId) : null;
    if (reconnectSession && reconnectSession.savedAt > Date.now() - 60000 && reconnectSession.state?.hp > 0 && !reconnectSession.state?._dead) {
      const saved = reconnectSession.state;
      for (const key of ['x', 'y', 'angle', 'vx', 'vy', 'hp', 'maxHp', 'score', 'sc', 'gold', 'xp', 'kills', 'wood', 'stone', 'apples', 'weapon', 'axeTier', 'swordTier', 'axeSkin', 'swordSkin', 'team', 'color', 'skin']) {
        if (saved[key] !== undefined) state[key] = saved[key];
      }
      for (const building of buildings.values()) {
        if (building.ownerId === reconnectSession.socketId) building.ownerId = socket.id;
      }
      reconnectSessions.delete(guestId);
    } else if (guestId) {
      reconnectSessions.delete(guestId);
    }
    const requestedClan = clans.get(String(data.clanId || ''));
    const clanMember = requestedClan?.members?.find(member => member.name === state.name);
    updatePlayerRoom(state);
    if (requestedClan && clanMember) {
      clanMember.id = socket.id;
      requestedClan.ownerId = requestedClan.ownerName === state.name ? socket.id : requestedClan.ownerId;
      state.clanId = requestedClan.id;
      state.clanTag = requestedClan.tag;
      socket.join(`clan:${requestedClan.id}`);
    }
    players.set(socket.id, state);
    ensureMobs(state.x || 0, state.y || 0);
    rebuildMobGrid();
    const visibleMobs = nearbyMobs(state.x || 0, state.y || 0, MOB_AOI_RADIUS);
    state.visibleMobIds = new Set(visibleMobs.map(mob => mob.id));
    const others = Object.fromEntries([...players].filter(([id, player]) => {
      if (id === socket.id) return false;
      const dx = (Number(player.x) || 0) - (Number(state.x) || 0);
      const dy = (Number(player.y) || 0) - (Number(state.y) || 0);
      return dx * dx + dy * dy <= PLAYER_AOI_RADIUS * PLAYER_AOI_RADIUS;
    }).map(([id, player]) => [id, compactFullState(player)]));
    state.visiblePlayerIds = new Set(Object.keys(others));
    socket.emit('welcome', {
      id: socket.id,
      players: others,
      buildings: Object.fromEntries(buildings),
      worldSeed,
      resHp: Object.fromEntries(serverResources.map(resource => [resource.idx, { hp: resource.hp, maxHp: resource.maxHp, destroyed: resource.destroyed }])),
      mobs: visibleMobs.map(publicMob),
      airdrops: [...airdrops.values()].map(publicAirdrop),
      announcement: adminConfig.announcement || '',
      isHost: players.size === 1,
      loadoutCatalog: buildLoadoutCatalog(),
      loadout: {
        role: state.role, helmet: state.helmet,
        weapon: state.designWeapon, set: state.loadoutSet,
        roleInfo: BUILD_ROLES[state.role], helmetInfo: BUILD_HELMETS[state.helmet],
        weaponInfo: state.weaponInfo, setInfo: state.setInfo
      }
    });
    socket.emit('mob_ids', [...state.visibleMobIds]);
    socket.broadcast.emit('player_join', { id: socket.id, state: compactFullState(state) });
    broadcastOnlineCount();
    updateBounty();
  });

  socket.on('respawn', () => {
    let player = players.get(socket.id);
    const spawnPt = {
      x: Math.round((Math.random() * 2 - 1) * 3200),
      y: Math.round((Math.random() * 2 - 1) * 3200)
    };
    onPlayerDeath(socket.id);
    if (!player) {
      const authUser = socket.data?.authUser || null;
      const rank = authUser ? rankInfo(authUser.xp || 0) : rankInfo(0);
      player = {
        id: socket.id,
        name: authUser?.username || 'forestbrawl',
        hp: 250,
        maxHp: 250,
        baseMaxHp: 250,
        score: 0,
        sc: 0,
        gold: 0,
        xp: authUser?.xp || 0,
        kills: 0,
        wood: 0,
        stone: 0,
        apples: 5,
        weapon: 1,
        designWeapon: 'sword',
        loadoutSet: 'sunforge',
        axeTier: 0,
        swordTier: 0,
        skin: 'wolf',
        rk: rank.visualRankId,
        rankId: rank.rankId,
        visualRankId: rank.visualRankId,
        rankName: rank.name,
        profileCosmetics: authUser?.equippedItems ? {
          avatarId: authUser.equippedItems.profil_avatar || 'wolf',
          effectId: authUser.equippedItems.profil_efekt || authUser.equippedItems.efektler || 'effect_none',
          frameId: authUser.equippedItems.profil_cerceve || 'frame_woodland'
        } : { avatarId: 'wolf', effectId: 'effect_none', frameId: 'frame_woodland' },
        x: spawnPt.x,
        y: spawnPt.y,
        vx: 0,
        vy: 0,
        angle: 0,
        stateSeq: 0,
        hpSeq: 0,
        stateAt: Date.now(),
        _dead: false,
        _authUser: authUser
      };
      players.set(socket.id, player);
    } else {
      player.hp = player.maxHp ?? 250;
      player.x = spawnPt.x;
      player.y = spawnPt.y;
      player.vx = 0;
      player.vy = 0;
      player.score = 0;
      player.sc = 0;
      player.gold = 0;
      player.xp = player._authUser ? Math.max(0, Number(player._authUser.xp) || 0) : Math.max(0, Number(player.xp) || 0);
      player.rankId = player._authUser ? rankInfo(player.xp).rankId : player.rankId;
      player.rankName = player._authUser ? rankInfo(player.xp).name : player.rankName;
      player.wood = 0;
      player.stone = 0;
      player.apples = 5;
      player.weapon = 1;
      player.trappedBy = null;
      player.stateSeq = 0;
      player.hpSeq = 0;
      player.hpAt = Date.now();
      player.visibleMobIds = new Set();
      player.visiblePlayerIds = new Set();
      player.stateAt = Date.now();
      player._dead = false;
      if (player._guestId) reconnectSessions.delete(player._guestId);
    }
    if (player) {
      const loadout = sanitizePlayerLoadout(player.role, player.helmet);
      player.role = loadout.role;
      player.helmet = loadout.helmet;
      applyLoadoutStats(player);
    }
    socket.emit('own_respawn', { x: spawnPt.x, y: spawnPt.y });
    socket.emit('self_state', { x: spawnPt.x, y: spawnPt.y, hp: player.hp, hpSeq: 0, hpAt: player.hpAt, sc: player.score, g: player.gold, wood: player.wood, stone: player.stone, apples: player.apples, seq: 0 });
    io.emit('player_respawn', { id: socket.id, state: compactFullState(player) });
    broadcastOnlineCount();
  });

  socket.on('state', (data = {}) => {
    if (socketEventRateLimited(socket, 'state')) return;
    let player = players.get(socket.id);
    if (!player) return;
    const prevX = Number(player.x) || 0;
    const prevY = Number(player.y) || 0;
    const incomingX = Number(data.x);
    const incomingY = Number(data.y);
    const incomingSeq = Number.isFinite(data.seq) ? Number(data.seq) : null;
    let acceptedX = incomingX;
    let acceptedY = incomingY;

    // Sequence check with wrap tolerance: drop strictly older packets unless a wrap/respawn happened
    if (incomingSeq !== null && incomingSeq <= (player.stateSeq || 0) && (player.stateSeq - incomingSeq < 1000)) {
      return;
    }

    let needsPosCorrection = false;
    if (Number.isFinite(incomingX) && Number.isFinite(incomingY)) {
      const dx = incomingX - prevX;
      const dy = incomingY - prevY;
      const dist = Math.hypot(dx, dy);
      const worldLimit = 7200;
      const elapsedMs = Math.max(16, Math.min(1000, Date.now() - (player.stateAt || Date.now())));
      const maxAllowedDist = Math.min(MAX_MOVE_DELTA_PER_TICK + elapsedMs * 0.75, 180);
      if (Math.abs(incomingX) > worldLimit || Math.abs(incomingY) > worldLimit) {
        acceptedX = Math.max(-worldLimit, Math.min(worldLimit, incomingX));
        acceptedY = Math.max(-worldLimit, Math.min(worldLimit, incomingY));
        needsPosCorrection = true;
      } else if (dist > maxAllowedDist) {
        // Smoothly clamp displacement in direction of movement instead of freezing completely.
        const ratio = maxAllowedDist / dist;
        acceptedX = prevX + dx * ratio;
        acceptedY = prevY + dy * ratio;
        data.vx = Number.isFinite(Number(data.vx)) ? clampNumber(Number(data.vx) * ratio, 0, -MAX_PLAYER_SPEED, MAX_PLAYER_SPEED) : 0;
        data.vy = Number.isFinite(Number(data.vy)) ? clampNumber(Number(data.vy) * ratio, 0, -MAX_PLAYER_SPEED, MAX_PLAYER_SPEED) : 0;
        needsPosCorrection = true;
      }
      if (Number.isFinite(Number(data.vx))) data.vx = clampNumber(Number(data.vx), 0, -MAX_PLAYER_SPEED, MAX_PLAYER_SPEED);
      if (Number.isFinite(Number(data.vy))) data.vy = clampNumber(Number(data.vy), 0, -MAX_PLAYER_SPEED, MAX_PLAYER_SPEED);
    }

    if (player.trappedBy) {
      const b = buildings.get(player.trappedBy);
      if (!b || b.type !== 6 || (b.hp ?? 100) <= 0 || b.ownerId === player.id) {
        releaseTrapVictim(player.id, player.trappedBy);
        player.trappedBy = null;
        player.trappedX = null;
        player.trappedY = null;
      } else {
        const offsetX = (Number(data.x) || prevX) - (player.trappedX ?? prevX);
        const offsetY = (Number(data.y) || prevY) - (player.trappedY ?? prevY);
        const trapRadius = (Number(b.radius) || 78) + 26;
        const trapDistance = Math.hypot((Number(player.x) || 0) - (Number(b.x) || 0), (Number(player.y) || 0) - (Number(b.y) || 0));
        if (Math.hypot(offsetX, offsetY) > 2 || trapDistance > trapRadius) {
          needsPosCorrection = true;
        }
        if (!dedupeTrapState(player, player.trappedBy)) {
          needsPosCorrection = true;
        }
        if (enforceCanonicalTrapLock(player)) {
          needsPosCorrection = true;
        }
        data.vx = 0;
        data.vy = 0;
        data.x = player.trappedX ?? data.x;
        data.y = player.trappedY ?? data.y;
        acceptedX = normalizeWorldCoord(data.x, prevX);
        acceptedY = normalizeWorldCoord(data.y, prevY);
      }
    }
    if (player._ownerFrozen) {
      acceptedX = prevX;
      acceptedY = prevY;
      data.vx = 0;
      data.vy = 0;
      needsPosCorrection = true;
    }
    acceptedX = normalizeWorldCoord(acceptedX, prevX);
    acceptedY = normalizeWorldCoord(acceptedY, prevY);
    for (const key of ['x', 'y', 'angle', 'vx', 'vy', 'isAttacking', 'attackTimer', 'attackDuration', 'team', 'color', 'skin', 'acc', 'buildX', 'buildY', 'weapon', 'designWeapon', 'loadoutSet', 'axeTier', 'swordTier', 'axeSkin', 'swordSkin']) {
      if (key === 'x' && Number.isFinite(acceptedX)) player.x = acceptedX;
      else if (key === 'y' && Number.isFinite(acceptedY)) player.y = acceptedY;
      else if (key === 'skin' && data[key] !== undefined) player.skin = String(data[key]) === 'thor' && !canUseThor(player._authUser) ? 'wolf' : String(data[key]);
      else if (key === 'weapon' && data[key] !== undefined) player.weapon = Number(data[key]) || 1;
      else if (key === 'designWeapon' && data[key] !== undefined) player.designWeapon = sanitizePremiumDesign({ weapon: data[key], set: player.loadoutSet }).weapon;
      else if (key === 'loadoutSet' && data[key] !== undefined) player.loadoutSet = sanitizePremiumDesign({ weapon: player.designWeapon, set: data[key] }).set;
      else if (key === 'axeTier' && data[key] !== undefined) player.axeTier = Number(data[key]) || 0;
      else if (key === 'swordTier' && data[key] !== undefined) player.swordTier = Number(data[key]) || 0;
      else if (data[key] !== undefined) player[key] = data[key];
    }
    // Accept predicted client resource gathering monotonically only if player is alive
    if (!player._dead && (player.hp ?? 100) > 0) {
      if (data.wood !== undefined) player.wood = Math.max(player.wood || 0, Number(data.wood) || 0);
      if (data.stone !== undefined) player.stone = Math.max(player.stone || 0, Number(data.stone) || 0);
      if (data.apples !== undefined) player.apples = Math.max(player.apples || 0, Number(data.apples) || 0);
    }
    capturePlayerInTrap(player);
    resolveTrapOwnerCollisions(player);

    // Advanced Networked Physics: 2-pass solid penetration resolution & velocity sliding
    if (!player.trappedBy) {
      const pRad = Number(player.radius) || 34;
      const initialColX = player.x;
      const initialColY = player.y;

      for (let pass = 0; pass < 2; pass++) {
        // 1. Solid Buildings & Traps (Static, invMass = 0)
        for (const b of nearbyBuildings(player.x, player.y, pRad + 120)) {
          if (b.type === 5) continue; // Boost pad allows walkover
          if (b.type === 6 && b.ownerId === player.id) continue; // Owner can cross own trap
          if ((b.hp ?? 100) <= 0) continue;
          const bRad = Number(b.radius) || (b.type === 8 ? 24 : (b.type === 6 ? 78 : 36));
          const col = NetworkPhysics.resolveCircleCircle(player, pRad, 1.0, b, bRad, 0.0);
          if (col && col.collided && pass === 0 && data.vx !== undefined && data.vy !== undefined) {
            NetworkPhysics.projectVelocitySlide(data, col.nx, col.ny, 0.05);
          }
        }

        // 2. Dynamic Players (Mass-weighted 50/50 separation, velocity sliding)
        for (const [otherId, other] of players) {
          if (otherId === socket.id || !other || other.hp <= 0) continue;
          if (other.trappedBy) {
            const trappedBuilding = buildings.get(other.trappedBy);
            if (trappedBuilding?.ownerId === socket.id) continue; // Owner pushes trapped victims instead of being repelled
          }
          const otherRad = Number(other.radius) || 34;
          const col = NetworkPhysics.resolveCircleCircle(player, pRad, 1.0, other, otherRad, 1.0);
          if (col && col.collided && pass === 0 && data.vx !== undefined && data.vy !== undefined) {
            NetworkPhysics.projectVelocitySlide(data, col.nx, col.ny, 0.05);
          }
        }
      }

      if (Math.hypot(player.x - initialColX, player.y - initialColY) > 0.8) {
        needsPosCorrection = true;
      }
    }
    if (incomingSeq !== null) player.stateSeq = incomingSeq;
    player.stateAt = Date.now();
    updatePlayerRoom(player);

    if (needsPosCorrection) {
      socket.emit('pos_correction', { x: player.x, y: player.y, seq: player.stateSeq || 0 });
    }
  });

  socket.on('swing', (data = {}) => {
    if (socketEventRateLimited(socket, 'swing')) return;
    let attacker = players.get(socket.id);
    if (!attacker) {
      attacker = { id: socket.id, name: 'Oyuncu', hp: 250, maxHp: 250, stateAt: Date.now() };
      players.set(socket.id, attacker);
    }
    if ((attacker.hp ?? 250) <= 0) attacker.hp = 250;
    const incomingWeapon = Number(data.weapon ?? attacker.weapon);
    const weapon = incomingWeapon === 2 ? 2 : 1;
    attacker.weapon = incomingWeapon;
    if (data.axeTier !== undefined) attacker.axeTier = Number(data.axeTier) || 0;
    if (data.swordTier !== undefined) attacker.swordTier = Number(data.swordTier) || 0;
    const now = Date.now();
    const swingCooldown = weapon === 2 ? 54 : 42;
    if (now - (attacker.lastSwingAt || 0) < swingCooldown) return;
    const swingId = Number.isFinite(Number(data.swingId)) ? Number(data.swingId) : null;
    if (swingId !== null && attacker.lastSwingId === swingId) return;
    const range = weapon === 2 ? 140 : 128;
    const spread = weapon === 2 ? Math.PI / 3.25 : Math.PI / 2.57;
    const tier = Math.max(0, Math.min(5, Number(weapon === 2 ? attacker.swordTier : attacker.axeTier) || 0));
    const multiplier = [1, 1.5, 2.2, 3.5, 5, 8][tier];
    const damage = Math.min(120, Math.round((weapon === 2 ? 30 : 22) * multiplier));
    const angle = Number(data.angle);
    if (!Number.isFinite(angle)) return;
    attacker.lastSwingAt = now;
    attacker.lastSwingId = swingId;
    attacker.attackUntil = now + swingCooldown;
    attacker.isAttacking = true;
    attacker.attackTimer = 0;
    attacker.attackDuration = weapon === 2 ? 280 : 300;
    io.emit('player_attack', {
      id: socket.id,
      weapon,
      angle,
      at: now,
      swingId: swingId ?? now,
      serverTime: now,
      durationMs: weapon === 2 ? 280 : 300
    });
    io.emit('playerAttack', socket.id);
    const attackerX = Number(attacker.x) || 0, attackerY = Number(attacker.y) || 0;
    if (!pvpAllowed()) return;
    // Gövde dönüşünü engelle: Oyuncunun gövde açısı saldırıyla zorla değiştirilmez, sürekli nişan açısında kalır.
    for (const [targetId, target] of players) {
      if (targetId === socket.id || target.hp <= 0) continue;
      if (!validateCombatState(attacker, target, { allowTrapHit: false, rangeLimit: range + 56, damage })) continue;
      if (swingId && target.lastHitSwingId === swingId) continue;
      const dx = (Number(target.x) || 0) - attackerX, dy = (Number(target.y) || 0) - attackerY;
      let difference = Math.abs(Math.atan2(dy, dx) - angle);
      if (difference > Math.PI) difference = Math.PI * 2 - difference;
      if (difference > spread) continue;
      if (swingId) target.lastHitSwingId = swingId;
      applyPlayerDamage(target, damage);
      io.to(targetId).emit('pvp_hit', { dmg: damage, fromName: attacker.name || 'Oyuncu' });
      io.to(targetId).emit('self_state', { hp: target.hp, hpSeq: target.hpSeq, hpAt: target.hpAt });
      io.emit('players', { [targetId]: compactState(target) });
      socket.emit('pvp_confirm', { targetId, dmg: damage, targetName: target.name || 'Oyuncu' });
      if (target.hp <= 0) {
        stealDeathLoot(attacker, target);
        onPlayerDeath(targetId);
        target.kills = target.kills || 0;
        attacker.kills = (attacker.kills || 0) + 1;
        attacker.score = (attacker.score || 0) + 150;
        if (BOUNTY_EVENT_ENABLED && currentBountyId && targetId === currentBountyId) {
          const bountyBonus = 300;
          attacker.gold = (attacker.gold || 0) + bountyBonus;
          attacker.score = (attacker.score || 0) + bountyBonus;
          socket.emit('bounty_kill_reward', { name: target.name || 'Oyuncu', bonus: bountyBonus });
          io.emit('bounty_killed_broadcast', { killer: attacker.name || 'Oyuncu', victim: target.name || 'Oyuncu', bonus: bountyBonus });
          currentBountyId = null;
          io.emit('bounty_update', { id: null });
        }
        io.to(targetId).emit('pvp_killed', { byName: attacker.name || 'Oyuncu' });
        io.emit('player_dead', { id: targetId });
        socket.emit('pvp_kill_confirm', { targetId, targetName: target.name || 'Oyuncu' });
        io.emit('pvp_kill_feed', { killer: attacker.name || 'Oyuncu', victim: target.name || 'Oyuncu', streak: attacker.kills });
        persistPlayerScore(attacker);
      }
      break;
    }
  });

  socket.on('pvp_hit', (data = {}) => {
    if (socketEventRateLimited(socket, 'pvp_hit')) return;
    if (!pvpAllowed()) return;
    const attacker = players.get(socket.id);
    const target = players.get(data.targetId);
    if (!attacker || !target || (attacker.hp ?? 0) <= 0 || (target.hp ?? 0) <= 0) return;
    if (!validateCombatState(attacker, target, { allowTrapHit: false, rangeLimit: 200, damage: 1 })) return;
    const swingId = Number(data.swingId);
    if (!Number.isFinite(attacker.lastSwingAt) || Date.now() - attacker.lastSwingAt > 750) return;
    if (swingId && target.lastHitSwingId === swingId) return; // Dedup against swing event
    const dist = Math.hypot((Number(target.x) || 0) - (Number(attacker.x) || 0), (Number(target.y) || 0) - (Number(attacker.y) || 0));
    const range = (attacker.weapon === 2 ? 140 : 128) + 120;
    if (dist > range) return;
    const weapon = attacker.weapon === 2 ? 2 : 1;
    const tier = Math.max(0, Math.min(5, Number(weapon === 2 ? attacker.swordTier : attacker.axeTier) || 0));
    const multiplier = [1, 1.5, 2.2, 3.5, 5, 8][tier];
    const damage = Math.min(120, Math.round((weapon === 2 ? 30 : 22) * multiplier));
    if (swingId) target.lastHitSwingId = swingId;
    applyPlayerDamage(target, damage);
    io.to(data.targetId).emit('pvp_hit', { dmg: damage, fromName: attacker.name || 'Oyuncu' });
    io.to(data.targetId).emit('self_state', { hp: target.hp, hpSeq: target.hpSeq, hpAt: target.hpAt });
    io.emit('players', { [data.targetId]: compactState(target) });
    socket.emit('pvp_confirm', { targetId: data.targetId, dmg: damage, targetName: target.name || 'Oyuncu' });
    if (target.hp <= 0) {
      onPlayerDeath(data.targetId);
      target.kills = target.kills || 0;
      attacker.kills = (attacker.kills || 0) + 1;
      attacker.score = (attacker.score || 0) + 150;
      if (BOUNTY_EVENT_ENABLED && currentBountyId && data.targetId === currentBountyId) {
        const bountyBonus = 300;
        attacker.gold = (attacker.gold || 0) + bountyBonus;
        attacker.score = (attacker.score || 0) + bountyBonus;
        socket.emit('bounty_kill_reward', { name: target.name || 'Oyuncu', bonus: bountyBonus });
        io.emit('bounty_killed_broadcast', { killer: attacker.name || 'Oyuncu', victim: target.name || 'Oyuncu', bonus: bountyBonus });
        currentBountyId = null;
        io.emit('bounty_update', { id: null });
      }
      io.to(data.targetId).emit('pvp_killed', { byName: attacker.name || 'Oyuncu' });
      io.emit('player_dead', { id: data.targetId });
      socket.emit('pvp_kill_confirm', { targetId: data.targetId, targetName: target.name || 'Oyuncu' });
      io.emit('pvp_kill_feed', { killer: attacker.name || 'Oyuncu', victim: target.name || 'Oyuncu', streak: attacker.kills });
      persistPlayerScore(attacker);
    }
  });

  socket.on('arrow_hit', (data = {}) => {
    if (socketEventRateLimited(socket, 'arrow_hit')) return;
    if (!pvpAllowed()) return;
    const attacker = players.get(socket.id);
    const target = players.get(data.targetId);
    if (!attacker || !target || attacker.hp <= 0 || target.hp <= 0) return;
    if (!validateCombatState(attacker, target, { allowTrapHit: false, rangeLimit: 780, damage: 1 })) return;
    const distance = Math.hypot((Number(target.x) || 0) - (Number(attacker.x) || 0), (Number(target.y) || 0) - (Number(attacker.y) || 0));
    if (distance > 780) return;
    const now = Date.now();
    if (now - (attacker.lastArrowAt || 0) < 140) return;
    attacker.lastArrowAt = now;
    const tier = Math.max(0, Math.min(5, Number(attacker.axeTier ?? attacker.swordTier) || 0));
    const damage = Math.min(140, Math.max(1, Math.round((14 + tier * 6) * (Number(attacker.damageMultiplier) || 1))));
    applyPlayerDamage(target, damage);
    io.to(data.targetId).emit('pvp_hit', { dmg: damage, fromName: attacker.name || 'Oyuncu' });
    io.to(data.targetId).emit('self_state', { hp: target.hp, hpSeq: target.hpSeq, hpAt: target.hpAt });
    io.emit('players', { [data.targetId]: compactState(target) });
    socket.emit('pvp_confirm', { targetId: data.targetId, dmg: damage, targetName: target.name || 'Oyuncu' });
    if (target.hp <= 0) {
      onPlayerDeath(data.targetId);
      target.kills = target.kills || 0;
      attacker.kills = (attacker.kills || 0) + 1;
      attacker.score = (attacker.score || 0) + 150;
      if (BOUNTY_EVENT_ENABLED && currentBountyId && data.targetId === currentBountyId) {
        const bountyBonus = 300;
        attacker.gold = (attacker.gold || 0) + bountyBonus;
        attacker.score = (attacker.score || 0) + bountyBonus;
        socket.emit('bounty_kill_reward', { name: target.name || 'Oyuncu', bonus: bountyBonus });
        io.emit('bounty_killed_broadcast', { killer: attacker.name || 'Oyuncu', victim: target.name || 'Oyuncu', bonus: bountyBonus });
        currentBountyId = null;
        io.emit('bounty_update', { id: null });
      }
      io.to(data.targetId).emit('pvp_killed', { byName: attacker.name || 'Oyuncu' });
      io.emit('player_dead', { id: data.targetId });
      socket.emit('pvp_kill_confirm', { targetId: data.targetId, targetName: target.name || 'Oyuncu' });
      io.emit('pvp_kill_feed', { killer: attacker.name || 'Oyuncu', victim: target.name || 'Oyuncu', streak: attacker.kills });
      persistPlayerScore(attacker);
    }
  });

  socket.on('spike_hit', (data = {}) => {
    if (socketEventRateLimited(socket, 'spike_hit')) return;
    if (!pvpAllowed()) return;
    const owner = players.get(socket.id);
    const target = players.get(data.targetId);
    const spike = buildings.get(String(data.bId || ''));
    if (!owner || !target || target.hp <= 0 || !spike || Number(spike.type) !== 3 || spike.ownerId !== socket.id || (spike.hp ?? 0) <= 0) return;
    if (Math.hypot((Number(target.x) || 0) - Number(spike.x), (Number(target.y) || 0) - Number(spike.y)) > 110) return;
    if (!validateCombatState(owner, target, { allowTrapHit: false, rangeLimit: 110, damage: 1 })) return;
    const tier = Math.max(0, Math.min(5, Number(spike.tier) || 0));
    const damage = Math.min(180, Math.round(60 * [1, 1.15, 1.3, 1.5, 1.8, 2.2][tier]));
    applyPlayerDamage(target, damage);
    io.to(data.targetId).emit('pvp_hit', { dmg: damage, fromName: owner?.name || 'Diken' });
    io.to(data.targetId).emit('self_state', { hp: target.hp, hpSeq: target.hpSeq, hpAt: target.hpAt });
    io.emit('players', { [data.targetId]: compactState(target) });
    socket.emit('spike_dmg_confirm', { targetId: data.targetId, dmg: damage, targetName: target.name || 'Oyuncu' });
    if (target.hp <= 0 && owner) {
      stealDeathLoot(owner, target);
      onPlayerDeath(data.targetId);
      target.kills = target.kills || 0;
      owner.kills = (owner.kills || 0) + 1;
      owner.score = (owner.score || 0) + 150;
      if (BOUNTY_EVENT_ENABLED && currentBountyId && data.targetId === currentBountyId) {
        const bountyBonus = 300;
        owner.gold = (owner.gold || 0) + bountyBonus;
        owner.score = (owner.score || 0) + bountyBonus;
        socket.emit('bounty_kill_reward', { name: target.name || 'Oyuncu', bonus: bountyBonus });
        io.emit('bounty_killed_broadcast', { killer: owner.name || 'Diken', victim: target.name || 'Oyuncu', bonus: bountyBonus });
        currentBountyId = null;
        io.emit('bounty_update', { id: null });
      }
      io.to(data.targetId).emit('pvp_killed', { byName: owner.name || 'Diken' });
      io.emit('player_dead', { id: data.targetId });
      socket.emit('pvp_kill_confirm', { targetId: data.targetId, targetName: target.name || 'Oyuncu' });
      io.emit('pvp_kill_feed', { killer: owner.name || 'Diken', victim: target.name || 'Oyuncu', streak: owner.kills });
      persistPlayerScore(owner);
    }
  });

  socket.on('airdrop_hit', (data = {}) => {
    if (socketEventRateLimited(socket, 'airdrop_hit')) return;
    const ad = airdrops.get(String(data.id || ''));
    if (!ad || ad.hp <= 0) return;
    const player = players.get(socket.id);
    if (!player || player.hp <= 0) return;
    if (Math.hypot((Number(player.x) || 0) - ad.x, (Number(player.y) || 0) - ad.y) > 180) return;
    if (!ad.lastHitBy) ad.lastHitBy = new Map();
    const now = Date.now();
    if (now - (ad.lastHitBy.get(socket.id) || 0) < 180) return;
    ad.lastHitBy.set(socket.id, now);
    const weapon = Number(player.weapon) === 2 ? 2 : 1;
    const tier = Math.max(0, Math.min(5, Number(weapon === 2 ? player.swordTier : player.axeTier) || 0));
    const dmg = Math.min(100, Math.round((weapon === 2 ? 30 : 22) * [1, 1.5, 2.2, 3.5, 5, 8][tier]));
    ad.hp = Math.max(0, ad.hp - dmg);
    io.emit('airdrop_hit_state', { id: ad.id, hp: ad.hp, maxHp: ad.maxHp });
    if (ad.hp <= 0) {
      airdrops.delete(ad.id);
      player.gold = (player.gold || 0) + ad.gold;
      player.score = (player.score || 0) + ad.gold;
      io.emit('airdrop_opened', {
        id: ad.id,
        x: ad.x,
        y: ad.y,
        openerId: socket.id,
        openerName: player.name || 'Oyuncu',
        gold: ad.gold,
        tier: ad.tier
      });
      persistPlayerScore(player);
    }
  });

  socket.on('trap_touch', (data = {}) => {
    if (socketEventRateLimited(socket, 'trap_touch')) return;
    if (data.victimId && String(data.victimId) !== socket.id) return;
    const target = players.get(data.victimId);
    const building = buildings.get(String(data.buildingId || ''));
    if (!target || target.hp <= 0) return;
    if (!building || building.type !== 6 || (building.hp ?? 0) <= 0) return;
    if (building.ownerId === data.victimId) return;
    if (building.ownerId !== socket.id && data.victimId !== socket.id) return;
    if (!validateTrapCapture(socket ? players.get(socket.id) : null, target, building)) return;
    capturePlayerInSpecificTrap(target, building);
  });

  socket.on('mob_trap_hit', (data = {}) => {
    const mob = mobs.get(String(data.mobId || ''));
    if (!mob || mob.hp <= 0) return;
    const b = buildings.get(String(data.buildingId || ''));
    const owner = b ? players.get(b.ownerId) : null;
    if (!b || b.type !== 6 || (b.hp ?? 0) <= 0 || !owner || owner.hp <= 0 || owner.id !== socket.id) return;
    const dx = mob.x - b.x, dy = mob.y - b.y;
    const triggerRadius = (Number(b.radius) || 78) + (Number(mob.radius) || 36);
    if (dx * dx + dy * dy > triggerRadius * triggerRadius) return;
    if (b && (b.hp ?? 100) > 0) {
      mob.trappedBy = b.id;
      mob.trappedUntil = Date.now() + 4000;
      mob.trappedX = mob.x;
      mob.trappedY = mob.y;
      mob.vx = 0;
      mob.vy = 0;
      mob.state = 'walk';
      mob.nextAttackAt = Date.now() + 3500; // Freeze attack while trapped
      io.emit('mob_trapped', { mobId: mob.id, buildingId: b.id, x: mob.x, y: mob.y });
    }
  });

  socket.on('trap_owner_push', (data = {}) => {
    if (socketEventRateLimited(socket, 'trap_owner_push')) return;
    const owner = players.get(socket.id);
    const target = players.get(data.victimId);
    const dx = Number(data.dx);
    const dy = Number(data.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    pushTrappedVictim(owner, target, dx, dy, data.step);
  });

  socket.on('train_board', () => {
    const player = players.get(socket.id);
    socket.emit('train_boarded', { x: player?.x || 0, y: player?.y || 0 });
    relayToOthers(socket, 'train_boarded', { id: socket.id });
  });

  socket.on('train_exit', () => {
    socket.emit('train_exited');
    relayToOthers(socket, 'train_exited', { id: socket.id });
  });

  socket.on('res_hit', (data = {}) => {
    if (socketEventRateLimited(socket, 'res_hit')) return;
    const player = players.get(socket.id);
    const idx = Number(data.idx);
    const resource = Number.isInteger(idx) ? serverResources[idx] : null;
    if (!player || !resource || resource.destroyed || player.hp <= 0) return;
    const distance = Math.hypot((Number(player.x) || 0) - resource.x, (Number(player.y) || 0) - resource.y);
    if (distance > 480) return;
    const now = Date.now();
    if (now - (resource.lastHitBy.get(socket.id) || 0) < 80) return;
    resource.lastHitBy.set(socket.id, now);
    const weapon = Number(player.weapon) === 2 ? 2 : 1;
    const tier = Math.max(0, Math.min(5, Number(weapon === 2 ? player.swordTier : player.axeTier) || 0));
    const harvestMult = (weapon === 1 ? 1.5 : 1.0) * (1 + tier * 0.25);
    const damage = Math.round((weapon === 2 ? 30 : 22) * [1, 1.5, 2.2, 3.5, 5, 8][tier]);
    resource.hp = Math.max(0, resource.hp - damage);
    io.emit('res_sync', { idx, hp: resource.hp, maxHp: resource.maxHp, shake: true });

    // Per-hit harvesting rewards
    let gainedWood = 0, gainedStone = 0, gainedGold = 0, gainedApples = 0, gainedHp = 0, gainedXp = 0, gainedScore = 0;
    switch (resource.type) {
      case 'wood':
        gainedWood = Math.round((10 + Math.floor(Math.random() * 6)) * harvestMult);
        if (Math.random() < 0.28) gainedApples = 1;
        gainedScore = Math.round(gainedWood * 0.5);
        break;
      case 'stone':
        gainedStone = Math.round((10 + Math.floor(Math.random() * 6)) * harvestMult);
        gainedScore = Math.round(gainedStone * 0.6);
        break;
      case 'gold':
        gainedGold = Math.round((6 + Math.floor(Math.random() * 6)) * harvestMult);
        gainedStone = Math.round(4 * harvestMult);
        gainedScore = Math.round(gainedGold * 2);
        break;
      case 'apple':
        gainedWood = Math.round(6 * harvestMult);
        gainedApples = 1 + (Math.random() < 0.4 ? 1 : 0);
        gainedScore = 15;
        break;
      case 'bush':
        gainedWood = Math.round(4 * harvestMult);
        if (Math.random() < 0.65) gainedApples = 1;
        gainedScore = 8;
        break;
      case 'mushroom':
        gainedGold = 2;
        gainedHp = 35;
        player.hp = Math.min(player.maxHp ?? 250, (player.hp ?? 0) + gainedHp);
        gainedScore = 12;
        break;
      case 'crystal':
        gainedXp = 45;
        player.xp = (player.xp || 0) + gainedXp;
        gainedScore = 30;
        break;
      case 'hive':
        gainedGold = 6 + Math.floor(Math.random() * 4);
        gainedScore = 20;
        break;
      default:
        gainedWood = Math.round(5 * harvestMult);
        break;
    }

    // Destruction bonus if HP drops to 0
    if (resource.hp <= 0) {
      resource.destroyed = true;
      if (resource.type === 'wood') { gainedWood += 30; gainedScore += 25; }
      else if (resource.type === 'stone') { gainedStone += 30; gainedScore += 30; }
      else if (resource.type === 'gold') { gainedGold += 25; gainedScore += 60; }
      else if (resource.type === 'apple') { gainedWood += 20; gainedApples += 3; gainedScore += 35; }
      else if (resource.type === 'bush') { gainedWood += 12; gainedApples += 2; gainedScore += 20; }
      else if (resource.type === 'crystal') { gainedXp += 60; gainedScore += 50; player.xp = (player.xp || 0) + 60; }
      else if (resource.type === 'mushroom') { gainedHp += 25; player.hp = Math.min(player.maxHp ?? 250, (player.hp ?? 0) + 25); }

      io.emit('res_sync', { idx, hp: 0, maxHp: resource.maxHp, destroyed: true });
      setTimeout(() => {
        resource.hp = resource.maxHp;
        resource.destroyed = false;
        io.emit('res_respawn', { idx, hp: resource.hp, maxHp: resource.maxHp });
      }, 30000 * Math.max(0.1, Number(adminConfig.resourceRespawnMultiplier) || 1));
    }

    player.wood = (player.wood || 0) + gainedWood;
    player.stone = (player.stone || 0) + gainedStone;
    player.gold = (player.gold || 0) + gainedGold;
    player.apples = (player.apples || 0) + gainedApples;
    player.score = (player.score || 0) + gainedScore;

    if (player._authUser && gainedGold > 0) {
      player._authUser.coins = (player._authUser.coins || 0) + gainedGold;
      player._authUser.gold = player._authUser.coins;
      player._authUser.score = Math.max(player._authUser.score || 0, player.score);
    }
    if (player._authUser && gainedXp > 0) {
      player._authUser.xp = (player._authUser.xp || 0) + gainedXp;
      player._authUser.rankId = rankInfo(player._authUser.xp).rankId;
    }

    socket.emit('res_reward', {
      wood: player.wood,
      stone: player.stone,
      gold: player.gold,
      apples: player.apples,
      score: player.score,
      gainedWood,
      gainedStone,
      gainedGold,
      gainedApples,
      gainedHp,
      gainedXp,
      gainedScore,
      hitType: resource.type,
      resX: resource.x,
      resY: resource.y,
      destroyed: resource.hp <= 0
    });
  });

  socket.on('chat', (data = {}) => {
    if (socketEventRateLimited(socket, 'chat')) return;
    const now = Date.now();
    if (now - (socket._lastChatAt || 0) < 500) return;
    socket._lastChatAt = now;
    const cleanMsg = String(data.msg || '').trim().slice(0, 120);
    if (!cleanMsg) return;
    io.emit('chat', { name: players.get(socket.id)?.name || 'Oyuncu', msg: cleanMsg, id: socket.id });
  });
  socket.on('quick_chat', (data = {}) => {
    if (socketEventRateLimited(socket, 'quick_chat')) return;
    const player = players.get(socket.id);
    const idx = Number(data.idx);
    if (!player || !Number.isInteger(idx) || idx < 0 || idx >= 8) return;
    io.emit('quick_chat', {
      id: socket.id,
      name: player.name || 'Oyuncu',
      idx,
      x: Number(player.x) || 0,
      y: Number(player.y) || 0,
      at: Date.now()
    });
  });
  socket.on('ping_req', (data) => socket.emit('pong_res', typeof data === 'object' && data ? data : { t: data }));
  // Death is emitted only by server-side damage handlers.
  socket.on('player_dead', () => {
    onPlayerDeath(socket.id);
  });
  socket.on('player_died', () => {
    onPlayerDeath(socket.id);
  });
  socket.on('eat_apple', () => {
    if (socketEventRateLimited(socket, 'eat_apple')) return;
    const player = players.get(socket.id);
    if (player && player.hp > 0 && player.apples > 0 && Date.now() - (player.lastAppleAt || 0) >= 700 && player.hp < (player.maxHp ?? 250)) {
      player.lastAppleAt = Date.now();
      player.apples--;
      player.hp = Math.min(player.maxHp ?? 250, (player.hp ?? 0) + 30);
      player.hpSeq = (player.hpSeq || 0) + 1;
      player.hpAt = Date.now();
    }
    socket.emit('self_state', { hp: player?.hp ?? 250, hpSeq: player?.hpSeq || 0, hpAt: player?.hpAt || Date.now(), apples: player?.apples || 0 });
  });

  socket.on('mob_hit_req', (data = {}) => {
    if (socketEventRateLimited(socket, 'mob_hit_req')) return;
    const mobId = String(data.mobId || '');
    const mob = mobs.get(mobId);
    if (!mob || mob.hp <= 0) return;
    let attacker = players.get(socket.id);
    if (!attacker) {
      attacker = { id: socket.id, name: 'Oyuncu', hp: 250, maxHp: 250, stateAt: Date.now() };
      players.set(socket.id, attacker);
    }
    const now = Date.now();
    const hitKey = `${socket.id}:${mob.id}`;
    if (now - (mobHitCooldowns.get(hitKey) || 0) < 180) return;
    mobHitCooldowns.set(hitKey, now);

    if ((attacker.hp ?? 250) <= 0) return;
    const distance = Math.hypot((Number(attacker.x) || 0) - mob.x, (Number(attacker.y) || 0) - mob.y);
    const weapon = Number(attacker.weapon) === 2 ? 2 : 1;
    const range = weapon === 2 ? 170 : 155;
    if (distance > range + (mob.radius || 0)) return;
    const tier = Math.max(0, Math.min(6, Number(weapon === 2 ? attacker.swordTier : attacker.axeTier) || 0));
    const multiplier = [1, 1.5, 2.2, 3.5, 5, 8, 12][tier];
    const dmg = Math.min(120, Math.round((weapon === 2 ? 30 : 22) * multiplier));
    mob.hp = Math.max(0, mob.hp - dmg);
    mob.targetId = socket.id;
    mob.chaseUntil = now + MOB_CHASE_TIMEOUT;

    mob.stateSeq = (mob.stateSeq || 0) + 1;
    io.emit('mob_update', { id: mob.id, seq: mob.stateSeq, hp: mob.hp, maxHp: mob.maxHp, hitFlash: 8, targetId: socket.id });

    if (mob.hp <= 0) {
      mobs.delete(mob.id);
      io.emit('mob_dead', { id: mob.id, killerId: socket.id });
      const rewardGold = Math.max(1, Math.floor((mob.goldReward || 10) * 0.65));
      const rewardXp = Math.max(1, Math.round((mob.xpReward || 35) * Math.max(0.1, Number(adminConfig.xpRate) || 1)));
      const rewardScore = Math.round(rewardXp * 0.75 + rewardGold * 3);
      attacker.gold = (attacker.gold || 0) + rewardGold;
      attacker.xp = (attacker.xp || 0) + rewardXp;
      attacker.score = (attacker.score || 0) + rewardScore;
      if (attacker._authUser) {
        attacker._authUser.xp = (attacker._authUser.xp || 0) + rewardXp;
        attacker._authUser.rankId = rankInfo(attacker._authUser.xp).rankId;
      }
      persistPlayerScore(attacker);
      socket.emit('self_state', { g: attacker.gold, xp: attacker.xp, sc: attacker.score });
      socket.emit('mob_kill_reward', {
        xp: rewardXp,
        gold: rewardGold,
        score: rewardScore,
        typeName: mob.typeName
      });
      setTimeout(() => {
        if (players.size > 0) ensureMobs();
      }, 4000 + Math.random() * 2000);
    }
  });

  for (const event of ['kill_streak', 'server_announce', 'boss_telegraph']) {
    socket.on(event, (data) => relayToOthers(socket, event, { ...(data || {}), fromId: socket.id }));
  }

  const SERVER_BUILD_LIMITS = { 3: 25, 4: 7, 5: 12, 6: 8, 7: 4, 8: 35, 9: 12, 10: 4 };
  const TRAP_MAX_HP = 240;
  const BUILD_COSTS = { 3: [20, 5, 0], 4: [40, 20, 0], 5: [10, 20, 0], 6: [30, 10, 0], 7: [60, 40, 0], 8: [30, 0, 0], 9: [80, 60, 0], 10: [25, 0, 0] };
  const BUILD_RADII = { 3: 34, 4: 44, 5: 22, 6: 32, 7: 32, 8: 20, 9: 52, 10: 28 };

  function normalizeBuilding(data, owner, id) {
    const type = Number(data.type);
    const x = Number(data.x), y = Number(data.y), angle = Number(data.angle) || 0;
    if (!Number.isInteger(type) || !SERVER_BUILD_LIMITS[type] || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Math.abs(x) > 6480 || Math.abs(y) > 6480) return null;
    if (!owner || owner.hp <= 0 || Math.hypot(x - (Number(owner.x) || 0), y - (Number(owner.y) || 0)) > 260) return null;
    const maxHp = type === 6 ? TRAP_MAX_HP : Math.max(1, Math.min(2000, Number(data.maxHp) || 100));
    return {
      id, type, x, y, angle: Number.isFinite(angle) ? angle : 0,
      radius: BUILD_RADII[type], hp: maxHp, maxHp,
      tier: Math.max(0, Math.min(6, Number(data.tier) || 0)),
      ownerId: owner.id, ownerClanId: owner.clanId || ''
    };
  }

  socket.on('place_building', (data = {}) => {
    if (socketEventRateLimited(socket, 'place_building')) return;
    const bType = Number(data.type);
    if (!Number.isInteger(bType) || !SERVER_BUILD_LIMITS[bType]) return;
    const owner = players.get(socket.id);
    if (!owner) return;
    const limit = SERVER_BUILD_LIMITS[bType] || 25;
    let ownedCount = 0;
    for (const b of buildings.values()) {
      if (b.ownerId === socket.id && Number(b.type) === bType && (b.hp === undefined || b.hp > 0)) {
        ownedCount++;
      }
    }
    if (ownedCount >= limit) {
      socket.emit('build_limit_reached', { type: bType, count: ownedCount, limit, clientId: data.id });
      socket.emit('self_state', { g: owner.gold, wood: owner.wood, stone: owner.stone, apples: owner.apples });
      return;
    }


    const id = `${socket.id}-${crypto.randomBytes(6).toString('hex')}`;
    const building = normalizeBuilding({ ...data, type: bType }, { ...owner, id: socket.id }, id);
    if (!building) return;
    const [wood, stone, gold] = BUILD_COSTS[bType];
    if ((owner.wood || 0) < wood || (owner.stone || 0) < stone || (owner.gold || 0) < gold) {
      socket.emit('build_limit_reached', { type: bType, count: ownedCount, limit, clientId: data.id });
      socket.emit('self_state', { g: owner.gold, wood: owner.wood, stone: owner.stone, apples: owner.apples });
      return;
    }
    owner.wood -= wood; owner.stone -= stone; owner.gold -= gold;
    buildings.set(id, building);
    socket.emit('self_state', { g: owner.gold, wood: owner.wood, stone: owner.stone, apples: owner.apples });
    socket.emit('build_ack', { clientId: data.id, serverId: id });
    io.emit('build', { id, building: { ...building } });
  });
  socket.on('build', (data = {}) => {
    // Legacy client event intentionally ignored; place_building is authoritative.
  });
  socket.on('build_destroy', ({ id } = {}) => {
    const building = buildings.get(id);
    if (!building) return;
    const player = players.get(socket.id);
    const isOwner = building.ownerId === socket.id;
    const isClanOwner = player?.clanId && building.ownerClanId === player.clanId && clans.get(player.clanId)?.ownerId === socket.id;
    if (!isOwner && !isClanOwner) return;
    removeBuilding(id);
  });
  socket.on('building_hit', ({ id, dmg } = {}) => {
    const building = buildings.get(id) || buildings.get(String(id));
    const attacker = players.get(socket.id);
    if (!building || !attacker || attacker.hp <= 0) return;
    if (sameClanBuildingOwner(attacker, building)) return;
    if (Math.hypot((Number(attacker.x) || 0) - Number(building.x), (Number(attacker.y) || 0) - Number(building.y)) > 250) return;
    if (building.ownerId === socket.id) return;
    const weapon = Number(attacker.weapon) === 2 ? 2 : 1;
    const tier = Math.max(0, Math.min(5, Number(weapon === 2 ? attacker.swordTier : attacker.axeTier) || 0));
    const hitDmg = Math.min(120, Math.round((weapon === 2 ? 30 : 22) * [1, 1.5, 2.2, 3.5, 5, 8][tier]));
    building.hp = Math.max(0, (building.hp ?? building.maxHp ?? 100) - hitDmg);
    io.emit('build_hp_update', { id, hp: building.hp });
    if (building.hp <= 0) {
      removeBuilding(id);
    }
  });
  socket.on('build_hp_update', (data = {}) => {
    if (socketEventRateLimited(socket, 'build_hp_update')) return;
    const id = String(data.id || '');
    const hp = Number(data.hp);
    const building = buildings.get(id);
    if (!building || !Number.isFinite(hp)) return;
    const player = players.get(socket.id);
    const isOwner = building.ownerId === socket.id;
    const isClanOwner = player?.clanId && building.ownerClanId === player.clanId;
    if (!isOwner && !isClanOwner) return; // Only owner or clan member can update building HP directly!
    if (hp >= (building.hp ?? building.maxHp ?? 100)) return;
    building.hp = Math.max(0, Math.min(building.hp ?? building.maxHp ?? 100, hp));
    io.emit('build_hp_update', { id, hp: building.hp });
  });

  socket.on('build_tier_update', (data = {}) => {
    if (socketEventRateLimited(socket, 'build_tier_update')) return;
    const id = String(data.id || '');
    const building = buildings.get(id);
    if (!building || building.ownerId !== socket.id) return;
    const newTier = Math.min(5, Math.max(0, Number(data.tier) || 0));
    const UPGRADE_SCORE = [400, 1000, 2500, 6000, 15000];
    const prevTier = building.tier || 0;
    if (newTier !== prevTier + 1) return;
    const cost = UPGRADE_SCORE[prevTier] || 0;
    const player = players.get(socket.id);
    if (!player || (player.score || 0) < cost) return;
    player.score -= cost;
    if (player._authUser) player._authUser.score = Math.max(0, (player._authUser.score || 0) - cost);
    const baseHp = { 3: 250, 4: 180, 5: 100, 6: 850, 7: 350, 8: 500, 9: 750, 10: 400 }[building.type] || 100;
    const tierHpMultiplier = [1, 1.6, 2.5, 4, 6.5, 10][newTier] || 1;
    const hpRatio = building.maxHp > 0 ? Math.max(0, Math.min(1, building.hp / building.maxHp)) : 1;
    building.tier = newTier;
    building.maxHp = Math.round(baseHp * tierHpMultiplier);
    building.hp = Math.max(1, Math.round(building.maxHp * hpRatio));
    io.emit('build_tier_update', { id, tier: building.tier, maxHp: building.maxHp, hp: building.hp });
    if (player) {
      socket.emit('self_state', { sc: player.score, g: player.gold });
    }
  });

  socket.on('buildings_sync', () => socket.emit('buildings_sync', { buildings: Object.fromEntries(buildings) }));

  socket.on('clan_create', ({ name, tag, playerName } = {}) => {
    const player = players.get(socket.id) || { name: String(playerName || 'Oyuncu').trim() };
    if (!player || player.clanId || socket.data.clanId) return socket.emit('clan_error', { msg: 'Önce mevcut klanından ayrılmalısın.' });
    const cleanName = String(name || '').trim().slice(0, 20);
    const cleanTag = String(tag || '').trim().toUpperCase().replace(/[^A-Z0-9ÇĞİÖŞÜ]/g, '').slice(0, 4);
    if (cleanName.length < 3 || cleanTag.length < 2) return socket.emit('clan_error', { msg: 'Klan adı en az 3, etiket en az 2 karakter olmalı.' });
    const id = crypto.randomBytes(4).toString('hex');
    const clan = { id, name: cleanName, tag: cleanTag, ownerId: socket.id, ownerName: player.name, members: [{ id: socket.id, name: player.name }] };
    clans.set(id, clan); saveAccountData(); player.clanId = id; player.clanTag = cleanTag; socket.join(`clan:${id}`);
    socket.data.clanId = id; socket.data.clanName = player.name; socket.data.clanTag = cleanTag;
    socket.emit('clan_joined', publicClan(clan));
    io.to(socket.id).emit('clan_requests_update', { clanId: clan.id, requests: [] });
  });
  socket.on('clan_join', ({ id, playerName } = {}) => {
    const player = players.get(socket.id) || { name: String(playerName || 'Oyuncu').trim() };
    const clan = clans.get(String(id || '').toLowerCase());
    if (!player || !clan) return socket.emit('clan_error', { msg: 'Klan bulunamadı.' });
    if (player.clanId || socket.data.clanId) return socket.emit('clan_error', { msg: 'Zaten bir klandasın.' });
    if (clan.members.length >= 20) return socket.emit('clan_error', { msg: 'Klan dolu.' });
    const socketMember = { id: socket.id, name: player.name };
    if (!clan.members.some(member => member.id === socket.id)) clan.members.push(socketMember);
    player.clanId = clan.id; player.clanTag = clan.tag; socket.join(`clan:${clan.id}`);
    socket.data.clanId = clan.id; socket.data.clanName = player.name;
    saveAccountData(); emitClanUpdate(clan); socket.emit('clan_joined', publicClan(clan));
  });
  socket.on('clan_request_join', ({ id, playerName } = {}) => {
    const player = players.get(socket.id) || { name: String(playerName || 'Oyuncu').trim() };
    if (!player) return;
    const clan = clans.get(String(id || '').toLowerCase()) || clans.get(String(id || ''));
    if (!clan) return socket.emit('clan_error', { msg: 'Klan bulunamadı.' });
    if (player.clanId || socket.data.clanId) return socket.emit('clan_error', { msg: 'Zaten bir klandasın.' });
    if (clan.members.length >= 20) return socket.emit('clan_error', { msg: 'Klan dolu.' });
    const list = clanJoinRequests.get(clan.id) || [];
    if (!list.some(req => req.requesterId === socket.id)) {
      const request = { clanId: clan.id, clanName: clan.name, clanTag: clan.tag, requesterId: socket.id, requesterName: player.name, requestedAt: Date.now() };
      list.push(request);
      clanJoinRequests.set(clan.id, list);
      io.to(clan.ownerId).emit('clan_join_request', publicClanJoinRequest(request));
      io.to(socket.id).emit('clan_request_sent', { clanId: clan.id, clanName: clan.name, clanTag: clan.tag });
      emitClanRequests(clan);
    }
  });
  socket.on('clan_request_decide', ({ clanId, requesterId, accept } = {}) => {
    const player = players.get(socket.id);
    const clan = clans.get(String(clanId || ''));
    if (!clan || !player || clan.ownerId !== socket.id) return socket.emit('clan_error', { msg: 'Bu işlemi sadece klan sahibi yapabilir.' });
    const list = clanJoinRequests.get(clan.id) || [];
    const request = list.find(item => item.requesterId === requesterId);
    if (!request) return socket.emit('clan_error', { msg: 'İstek bulunamadı.' });
    if (accept) {
      const target = players.get(requesterId);
      const targetSocket = io.sockets?.sockets?.get(requesterId) || null;
      if (!target || !targetSocket || clan.members.length >= 20) return socket.emit('clan_error', { msg: 'Klan dolu veya oyuncu çevrimdışı.' });
      if (!target.clanId) {
        target.clanId = clan.id;
        target.clanTag = clan.tag;
        targetSocket.join(`clan:${clan.id}`);
        if (targetSocket?.data) {
          targetSocket.data.clanId = clan.id;
          targetSocket.data.clanName = clan.name;
        }
        clan.members.push({ id: target.id, name: target.name || request.requesterName });
        saveAccountData();
        io.to(requesterId).emit('clan_joined', publicClan(clan));
        io.to(requesterId).emit('clan_notice', { msg: `${clan.name} klanına kabul edildin.` });
      }
      io.to(socket.id).emit('clan_request_decided', { requesterId, accepted: true, clanId: clan.id });
      io.to(requesterId).emit('clan_request_accepted', { clanId: clan.id, clanName: clan.name });
    } else {
      io.to(requesterId).emit('clan_request_rejected', { clanId: clan.id, clanName: clan.name });
      io.to(socket.id).emit('clan_request_decided', { requesterId, accepted: false, clanId: clan.id });
    }
    clanJoinRequests.set(clan.id, list.filter(item => item.requesterId !== requesterId));
    emitClanUpdate(clan);
    emitClanRequests(clan);
  });
  socket.on('clan_join_requests', () => {
    const player = players.get(socket.id);
    const clan = clans.get(player?.clanId || socket.data.clanId);
    if (!clan || clan.ownerId !== socket.id) return socket.emit('clan_requests_update', { clanId: clan?.id, requests: [] });
    emitClanRequests(clan);
  });
  socket.on('clan_kick', ({ memberId } = {}) => {
    const player = players.get(socket.id); const clan = clans.get(player?.clanId);
    if (!clan || (clan.ownerId !== socket.id && clan.ownerName !== player.name) || !clan.members.some(member => member.id === memberId)) return;
    const target = players.get(memberId);
    const targetSocket = io.sockets?.sockets?.get(memberId) || null;
    if (target) { target.clanId = ''; target.clanTag = ''; }
    if (targetSocket) {
      targetSocket.leave(`clan:${clan.id}`);
      if (targetSocket.data) {
        targetSocket.data.clanId = '';
        targetSocket.data.clanName = '';
        targetSocket.data.clanTag = '';
      }
      io.to(memberId).emit('clan_kicked');
    }
    clan.members = clan.members.filter(member => member.id !== memberId);
    if (clan.members.length === 0) {
      clans.delete(clan.id);
      clanJoinRequests.delete(clan.id);
    } else {
      emitClanUpdate(clan);
      emitClanRequests(clan);
    }
    saveAccountData();
  });
  socket.on('clan_leave', () => leaveClan(socket));
  socket.on('clan_get', () => { const clan = clans.get(players.get(socket.id)?.clanId || socket.data.clanId); if (clan) socket.emit('clan_joined', publicClan(clan)); });

  socket.on('party_create', ({ name } = {}) => {
    const code = Math.random().toString(36).slice(2, 7).toUpperCase();
    parties.set(code, { code, members: [{ id: socket.id, name: name || 'Oyuncu' }], owner: socket.id });
    socket.join(`party:${code}`);
    socket.emit('party_created', parties.get(code));
  });
  socket.on('party_join', ({ code, name } = {}) => {
    const party = parties.get(String(code || '').toUpperCase());
    if (!party || party.members.length >= 8) return socket.emit('party_error', { msg: 'Parti bulunamadı veya dolu.' });
    if (party.members.some(member => member.id === socket.id)) return socket.emit('party_joined', party);
    party.members.push({ id: socket.id, name: name || 'Oyuncu' });
    socket.join(`party:${party.code}`);
    io.to(`party:${party.code}`).emit('party_update', party);
    socket.emit('party_joined', party);
  });
  socket.on('party_start', () => { for (const room of socket.rooms) if (room.startsWith('party:')) io.to(room).emit('party_game_start', { partyCode: room.slice(6) }); });
  socket.on('party_leave', () => {
    for (const room of socket.rooms) if (room.startsWith('party:')) {
      const party = parties.get(room.slice(6));
      if (party) {
        party.members = party.members.filter(member => member.id !== socket.id);
        if (party.owner === socket.id) party.owner = party.members[0]?.id || null;
        if (!party.members.length) parties.delete(party.code);
        else io.to(room).emit('party_update', party);
      }
      socket.leave(room);
    }
    socket.emit('party_left');
  });

  socket.on('disconnect', () => {
    for (const key of mobHitCooldowns.keys()) if (key.startsWith(`${socket.id}:`)) mobHitCooldowns.delete(key);
    const player = players.get(socket.id);
    const guestId = String(player?._guestId || '').slice(0, 80);
    if (player && guestId && player.hp > 0 && !player._dead) {
      reconnectSessions.set(guestId, { savedAt: Date.now(), socketId: socket.id, state: { ...player } });
    } else if (player) {
      onPlayerDeath(socket.id);
      if (guestId) reconnectSessions.delete(guestId);
    }
    if (player && (player.score > 0 || player.gold > 0 || player.kills > 0)) {
      syncLivePlayerProgress(player);
      persistPlayerScore(player);
      saveAccountData(true);
    }
    deletePlayerBuildings(socket.id);
    leaveClan(socket, false);
    players.delete(socket.id);
    for (const [code, party] of parties) {
      const hadMember = party.members.some(member => member.id === socket.id);
      if (!hadMember) continue;
      party.members = party.members.filter(member => member.id !== socket.id);
      if (party.owner === socket.id) party.owner = party.members[0]?.id || null;
      if (!party.members.length) parties.delete(code);
      else io.to(`party:${code}`).emit('party_update', party);
    }
    socket.broadcast.emit('player_left', { id: socket.id, name: player?.name || 'Oyuncu' });
    broadcastOnlineCount();
  });
});

server.on('error', (error) => {
  console.error(`[Server] Failed to listen on port ${PORT}:`, error.message);
  process.exitCode = 1;
});

server.listen(PORT, '0.0.0.0', () => {
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : PORT;
  console.log(`ForestBrawl multiplayer server listening on 0.0.0.0:${boundPort}`);
});