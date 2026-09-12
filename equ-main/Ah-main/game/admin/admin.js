/**
 * ═════════════════════════════════════════════════════════════════
 * FORESTBRAWL OWNER & ADMIN COMMAND DECK — CLIENT CONTROLLER
 * Full Reactive Telemetry, God Mode, Broadcast Studio, and Moderation
 * ═════════════════════════════════════════════════════════════════
 */

(() => {
  'use strict';

  // ── Application State ──────────────────────────────────────────
  const state = {
    token: localStorage.getItem('fb_owner_token') || '',
    user: null,
    dashboardData: null,
    usersList: [],
    cosmeticsData: null,
    activeTab: 'overview',
    selectedPlayer: null,
    sfxEnabled: localStorage.getItem('fb_admin_sfx') !== 'false',
    pollInterval: null,
    userSearchTimeout: null
  };

  // ── DOM Selectors ──────────────────────────────────────────────
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ── Audio Synthesizer (Web Audio API) ──────────────────────────
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) audioCtx = new AudioContext();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playSoundTone(freq, duration = 0.08, type = 'sine', gainVal = 0.15) {
    if (!state.sfxEnabled) return;
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch (_) {}
  }

  const sfx = {
    click: () => playSoundTone(880, 0.04, 'sine', 0.1),
    success: () => {
      playSoundTone(523.25, 0.08, 'triangle', 0.15);
      setTimeout(() => playSoundTone(659.25, 0.08, 'triangle', 0.15), 60);
      setTimeout(() => playSoundTone(783.99, 0.12, 'triangle', 0.18), 120);
    },
    error: () => {
      playSoundTone(220, 0.12, 'sawtooth', 0.2);
      setTimeout(() => playSoundTone(180, 0.16, 'sawtooth', 0.22), 80);
    },
    gong: () => {
      playSoundTone(440, 0.3, 'sine', 0.2);
      setTimeout(() => playSoundTone(554.37, 0.35, 'triangle', 0.2), 60);
    }
  };

  // ── Toast Notification System ──────────────────────────────────
  function showToast(message, type = 'success', duration = 3200) {
    const container = $('#toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast-msg ${type === 'error' ? 'toast-error' : type === 'warning' ? 'toast-warning' : ''}`;
    
    const icon = type === 'error' ? '⚠️' : type === 'warning' ? '🔔' : '✨';
    el.innerHTML = `<span class="toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(el);

    requestAnimationFrame(() => el.classList.add('show'));

    if (type === 'error') sfx.error();
    else sfx.success();

    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 320);
    }, duration);
  }

  // ── API Fetch Client ───────────────────────────────────────────
  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }

    try {
      const res = await fetch(path, { ...options, headers });
      const data = await res.json().catch(() => ({ error: 'Sunucudan geçersiz JSON yanıtı.' }));
      if (!res.ok) {
        throw new Error(data.error || `İşlem başarısız (HTTP ${res.status}).`);
      }
      return data;
    } catch (err) {
      if (err.message && err.message.includes('Owner oturumu')) {
        showLoginView();
      }
      throw err;
    }
  }

  // ── View Switching ─────────────────────────────────────────────
  function showLoginView() {
    state.token = '';
    state.user = null;
    localStorage.removeItem('fb_owner_token');
    stopPolling();
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#login-error').classList.add('hidden');
  }

  function showAppView(user) {
    state.user = user;
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');

    const name = user.username || 'Owner';
    $('#owner-display-name').textContent = name;
    $('#owner-avatar').textContent = name.charAt(0).toUpperCase();

    // Initial data fetch
    loadDashboard();
    startPolling();
  }

  // ── Authentication Handlers ────────────────────────────────────
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit-btn');
    const errBox = $('#login-error');
    errBox.classList.add('hidden');

    const username = $('#username').value.trim();
    const password = $('#password').value;

    if (!username || !password) {
      errBox.textContent = 'Kullanıcı adı ve şifre gereklidir.';
      errBox.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.querySelector('span').textContent = 'Doğrulanıyor...';

    try {
      const res = await api('/api/owner/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      state.token = res.token;
      localStorage.setItem('fb_owner_token', state.token);
      sfx.success();
      showToast(`Hoş geldin, ${res.user.username}! Komuta merkezi hazır.`);
      showAppView(res.user);
    } catch (err) {
      sfx.error();
      errBox.textContent = err.message || 'Giriş başarısız.';
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Panele Güvenli Bağlan';
    }
  });

  $('#toggle-pwd-btn').addEventListener('click', () => {
    const input = $('#password');
    const isPwd = input.type === 'password';
    input.type = isPwd ? 'text' : 'password';
    $('#toggle-pwd-btn').textContent = isPwd ? '🔒' : '👁️';
    sfx.click();
  });

  $('#logout-btn').addEventListener('click', async () => {
    sfx.click();
    try {
      await api('/api/owner/logout', { method: 'POST' });
    } catch (_) {}
    showToast('Güvenli çıkış yapıldı.');
    showLoginView();
  });

  // ── Tab Management ─────────────────────────────────────────────
  const TAB_HEADINGS = {
    overview: 'Sunucu Nabzı & Canlı Telemetri',
    players: 'Canlı Oyuncular & God Mode',
    broadcast: 'Duyuru & Oyun İçi Yayın Stüdyosu',
    world: 'Dünya Kuralları & Dinamik Ayarlar',
    users: 'Kayıtlı Oyuncu Hesapları & Moderasyon',
    cosmetics: 'Kozmetik Envanteri & Sandık Havuzları',
    audit: 'Güvenlik Logları & Aktif Yasaklamalar'
  };

  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (!tab || tab === state.activeTab) return;
      sfx.click();
      setActiveTab(tab);
    });
  });

  function setActiveTab(tab) {
    state.activeTab = tab;

    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tab}`));

    $('#active-tab-title').textContent = tab.toUpperCase();
    $('#view-heading').textContent = TAB_HEADINGS[tab] || 'Komuta Merkezi';

    // Refresh specific tab data when activated
    if (tab === 'users') loadUsers();
    else if (tab === 'cosmetics') loadCosmetics();
    else if (tab === 'players') renderPlayersTable();
    else if (tab === 'audit') renderAuditTimeline();
  }

  // ── Sound FX Toggle ────────────────────────────────────────────
  $('#sfx-toggle-btn').addEventListener('click', () => {
    state.sfxEnabled = !state.sfxEnabled;
    localStorage.setItem('fb_admin_sfx', String(state.sfxEnabled));
    $('#sfx-icon').textContent = state.sfxEnabled ? '🔊' : '🔇';
    if (state.sfxEnabled) sfx.click();
    showToast(state.sfxEnabled ? 'Panel sesleri açıldı.' : 'Panel sessize alındı.');
  });
  $('#sfx-icon').textContent = state.sfxEnabled ? '🔊' : '🔇';

  // ── Polling & Dashboard Data Loader ────────────────────────────
  $('#refresh-btn').addEventListener('click', () => {
    sfx.click();
    loadDashboard(true);
  });

  function startPolling() {
    stopPolling();
    state.pollInterval = setInterval(() => {
      if (document.visibilityState === 'visible' && state.token) {
        loadDashboard(false);
      }
    }, 3500);
  }

  function stopPolling() {
    if (state.pollInterval) {
      clearInterval(state.pollInterval);
      state.pollInterval = null;
    }
  }

  async function loadDashboard(showManualToast = false) {
    try {
      const data = await api('/api/owner/dashboard');
      state.dashboardData = data;

      renderHudPills(data.stats);
      renderOverviewTab(data);
      if (state.activeTab === 'players') renderPlayersTable();
      if (state.activeTab === 'audit') renderAuditTimeline();

      if (showManualToast) {
        showToast('Veriler güncellendi.');
      }
    } catch (err) {
      console.warn('[AdminDashboard] poll failed:', err.message);
    }
  }

  // ── Render Helpers ─────────────────────────────────────────────
  function formatUptime(seconds) {
    const s = Math.floor(seconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}s ${m}d`;
    if (m > 0) return `${m}d ${sec}sn`;
    return `${sec}sn`;
  }

  function renderHudPills(stats) {
    if (!stats) return;
    $('#server-uptime-label').textContent = formatUptime(stats.uptimeSec);
    $('#server-ram-label').textContent = `${stats.ramMb || 0} MB`;
    $('#sys-rss-stat').textContent = `${stats.ramMb || 0} MB`;
    $('#sys-heap-stat').textContent = `${stats.heapMb || 0} MB`;
    $('#sys-banned-stat').textContent = `${stats.bannedCount || 0} IP / Kullanıcı`;
    $('#nav-badge-online').textContent = stats.online || 0;
  }

  function renderOverviewTab(data) {
    const s = data.stats || {};
    const c = data.config || {};

    $('#stat-online').textContent = s.online ?? 0;
    $('#stat-online-detail').textContent = `${s.online ?? 0} aktif savaşta`;
    $('#stat-mobs').textContent = s.mobs ?? 0;
    $('#stat-buildings').textContent = s.buildings ?? 0;
    $('#stat-users').textContent = s.registeredUsers ?? 0;
    $('#stat-clans').textContent = s.clans ?? 0;
    $('#stat-parties-badge').textContent = `${s.parties ?? 0} aktif parti`;

    // Quick toggles in overview hero
    const maintToggle = $('#quick-maintenance-toggle');
    maintToggle.checked = Boolean(c.maintenance);
    $('#quick-maint-status').textContent = c.maintenance ? 'AKTİF (Girişler Kapalı)' : 'Kapalı';
    $('#quick-maint-status').style.color = c.maintenance ? 'var(--crimson-light)' : 'var(--text-dim)';

    const pvpToggle = $('#quick-pvp-toggle');
    pvpToggle.checked = c.pvpEnabled !== false;
    $('#quick-pvp-status').textContent = (c.pvpEnabled !== false) ? 'Açık (Savaş Var)' : 'Kapalı (Barış)';
    $('#quick-pvp-status').style.color = (c.pvpEnabled !== false) ? 'var(--emerald-light)' : 'var(--amber-light)';

    // World settings tab inputs
    $('#cfg-maintenance').checked = Boolean(c.maintenance);
    $('#cfg-pvp').checked = c.pvpEnabled !== false;
    
    ['xpRate', 'mobSpawnMultiplier', 'resourceRespawnMultiplier'].forEach(k => {
      const val = c[k] !== undefined ? Number(c[k]) : 1;
      const idMap = { xpRate: 'xprate', mobSpawnMultiplier: 'mobrate', resourceRespawnMultiplier: 'resrate' };
      const el = $(`#cfg-${idMap[k]}`);
      const valEl = $(`#cfg-${idMap[k]}-val`);
      if (el) el.value = val;
      if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
    });

    // Quick audit feed
    const auditList = data.audit || [];
    const feedEl = $('#quick-audit-feed');
    if (auditList.length === 0) {
      feedEl.innerHTML = '<div class="empty-feed">Henüz yönetici hareketi yok.</div>';
    } else {
      feedEl.innerHTML = auditList.slice(0, 6).map(item => `
        <div class="audit-chip">
          <div><b>${escapeHtml(item.action)}</b> · <span class="muted">${escapeHtml(item.username || 'system')}</span></div>
          <time>${new Date(item.at).toLocaleTimeString('tr-TR')}</time>
        </div>
      `).join('');
    }
  }

  // ── Quick World Toggles ────────────────────────────────────────
  $('#quick-maintenance-toggle').addEventListener('change', async (e) => {
    sfx.click();
    try {
      await api('/api/owner/config', {
        method: 'POST',
        body: JSON.stringify({ maintenance: e.target.checked })
      });
      showToast(e.target.checked ? '🛑 Bakım modu açıldı!' : '✅ Bakım modu kapatıldı.');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
      e.target.checked = !e.target.checked;
    }
  });

  $('#quick-pvp-toggle').addEventListener('change', async (e) => {
    sfx.click();
    try {
      await api('/api/owner/config', {
        method: 'POST',
        body: JSON.stringify({ pvpEnabled: e.target.checked })
      });
      showToast(e.target.checked ? '⚔️ PvP modu açıldı.' : '🕊️ PvP modu kapatıldı.');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
      e.target.checked = !e.target.checked;
    }
  });

  // ── Quick Broadcast Launcher ───────────────────────────────────
  let quickCategory = 'info';
  $$('.cat-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      sfx.click();
      $$('.cat-pill').forEach(b => b.classList.toggle('active', b === btn));
      quickCategory = btn.dataset.level;
      updateQuickPreview();
    });
  });

  $('#quick-announce-title').addEventListener('input', updateQuickPreview);
  $('#quick-announce-msg').addEventListener('input', (e) => {
    $('#quick-char-count').textContent = e.target.value.length;
    updateQuickPreview();
  });

  function updateQuickPreview() {
    const title = $('#quick-announce-title').value.trim() || 'FORESTBRAWL DUYURUSU';
    const msg = $('#quick-announce-msg').value.trim() || 'Duyuru metni burada canlı görünecek...';
    
    const banner = $('#live-preview-banner');
    banner.className = `preview-banner preview-level-${quickCategory}`;
    
    $('#preview-title').textContent = title.toUpperCase();
    $('#preview-message').textContent = msg;

    const iconMap = { info: '📢', event: '🔥', warning: '⚠️', reward: '🎁' };
    const tagMap = { info: 'DUYURU', event: 'ETKİNLİK', warning: 'UYARI', reward: 'ÖDÜL' };
    $('#preview-icon').textContent = iconMap[quickCategory] || '📢';
    $('#preview-tag').textContent = tagMap[quickCategory] || 'DUYURU';
  }

  $('#quick-send-announce-btn').addEventListener('click', async () => {
    const message = $('#quick-announce-msg').value.trim();
    const title = $('#quick-announce-title').value.trim() || 'FORESTBRAWL DUYURUSU';

    if (!message) {
      showToast('Lütfen bir duyuru mesajı yazın.', 'warning');
      return;
    }

    try {
      await api('/api/owner/announce', {
        method: 'POST',
        body: JSON.stringify({
          message,
          title,
          level: quickCategory,
          sound: 'bell',
          durationMs: 3000
        })
      });
      sfx.gong();
      showToast('🚀 Duyuru tüm sunucuya başarıyla yayınlandı!');
      $('#quick-announce-msg').value = '';
      $('#quick-char-count').textContent = '0';
      updateQuickPreview();
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#quick-clear-announce-btn').addEventListener('click', async () => {
    sfx.click();
    try {
      await api('/api/owner/announce', {
        method: 'POST',
        body: JSON.stringify({ clear: true })
      });
      showToast('Yayındaki duyuru temizlendi.');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#hero-broadcast-trigger').addEventListener('click', () => {
    sfx.click();
    setActiveTab('broadcast');
  });

  // ── Broadcast Studio ───────────────────────────────────────────
  $$('.preset-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      sfx.click();
      $('#studio-title').value = btn.dataset.title || '';
      $('#studio-message').value = btn.dataset.msg || '';
      $('#studio-category').value = btn.dataset.level || 'info';
      $('#studio-char-count').textContent = $('#studio-message').value.length;
      updateStudioPreview();
    });
  });

  $('#studio-category').addEventListener('change', updateStudioPreview);
  $('#studio-title').addEventListener('input', updateStudioPreview);
  $('#studio-message').addEventListener('input', (e) => {
    $('#studio-char-count').textContent = e.target.value.length;
    updateStudioPreview();
  });

  function updateStudioPreview() {
    const category = $('#studio-category').value;
    const title = $('#studio-title').value.trim() || 'FORESTBRAWL DUYURUSU';
    const msg = $('#studio-message').value.trim() || 'Duyuru metnini yazdıkça burası anlık güncellenir.';

    const banner = $('#studio-preview-banner');
    banner.className = `preview-banner preview-level-${category}`;

    const iconMap = { info: '📢', event: '🔥', warning: '⚠️', reward: '🎁' };
    const tagMap = { info: 'DUYURU', event: 'ETKİNLİK', warning: 'UYARI', reward: 'ÖDÜL' };

    $('#sp-icon').textContent = iconMap[category] || '📢';
    $('#sp-tag').textContent = tagMap[category] || 'DUYURU';
    $('#sp-title').textContent = title.toUpperCase();
    $('#sp-message').textContent = msg;
    $('#kf-preview-text').textContent = `${iconMap[category] || '📢'} ${msg}`;
  }

  $('#studio-broadcast-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('#studio-message').value.trim();
    const title = $('#studio-title').value.trim() || 'FORESTBRAWL DUYURUSU';
    const level = $('#studio-category').value;
    const sound = $('#studio-sound').value;

    if (!message) {
      showToast('Duyuru metni boş olamaz.', 'warning');
      return;
    }

    try {
      await api('/api/owner/announce', {
        method: 'POST',
        body: JSON.stringify({ message, title, level, sound })
      });
      sfx.gong();
      showToast('🚀 Duyuru stüdyodan canlı olarak yayınlandı!');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#studio-clear-btn').addEventListener('click', async () => {
    sfx.click();
    try {
      await api('/api/owner/announce', {
        method: 'POST',
        body: JSON.stringify({ clear: true })
      });
      showToast('Yayındaki duyuru kaldırıldı.');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Tab 2: Live Players Table & God Mode ────────────────────────
  $('#player-search').addEventListener('input', renderPlayersTable);

  function renderPlayersTable() {
    const list = state.dashboardData?.players || [];
    const query = ($('#player-search')?.value || '').toLowerCase().trim();
    const filtered = list.filter(p => !query || `${p.name} ${p.id} ${p.skin}`.toLowerCase().includes(query));

    $('#player-roster-count').textContent = `${filtered.length} / ${list.length} Oyuncu`;

    const tbody = $('#players-table-body');
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center muted" style="padding:32px 0;">${list.length === 0 ? 'Şu anda oyunda çevrimiçi oyuncu bulunmuyor.' : 'Aramayla eşleşen oyuncu bulunamadı.'}</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(p => {
      const maxHp = p.maxHp || 250;
      const hpPct = Math.max(0, Math.min(100, Math.round((p.hp / maxHp) * 100)));
      const isLowHp = hpPct < 30;

      return `
        <tr>
          <td>
            <div class="player-cell">
              <div class="player-avatar" title="${escapeHtml(p.skin)}">${skinEmoji(p.skin)}</div>
              <div class="player-name-wrap">
                <span class="p-name">${escapeHtml(p.name)}</span>
                <span class="p-id">${p.id}</span>
              </div>
            </div>
          </td>
          <td>
            <span class="pill-state ${p.frozen ? 'frozen' : 'active'}">
              ${p.frozen ? '❄️ Dondurulmuş' : '● Canlı'}
            </span>
          </td>
          <td>
            <div><b>${p.hp}</b> / ${maxHp}</div>
            <div class="hp-bar-wrap">
              <div class="hp-bar-fill ${isLowHp ? 'low' : ''}" style="width:${hpPct}%"></div>
            </div>
          </td>
          <td><b>${Number(p.score || 0).toLocaleString('tr-TR')}</b></td>
          <td><span style="color:var(--amber-light);font-weight:700;">🪙 ${Number(p.gold || 0).toLocaleString('tr-TR')}</span></td>
          <td><b>⚔️ ${p.kills || 0}</b></td>
          <td><code style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);">${p.x}, ${p.y}</code></td>
          <td class="text-right">
            <div class="actions-cell">
              <button class="btn-action-pill" data-godmode-id="${p.id}" title="God Mode İşlemleri">
                ⚡ God Mode
              </button>
              <button class="btn-action-pill" data-quick-action="heal" data-target-id="${p.id}" title="Can Doldur">
                💚
              </button>
              <button class="btn-action-pill danger" data-quick-action="kick" data-target-id="${p.id}" title="Sunucudan At">
                🚪
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function skinEmoji(skin) {
    if (!skin) return '👤';
    if (skin === 'thor') return '⚡';
    if (skin === 'wolf') return '🐺';
    if (skin === 'bear') return '🐻';
    if (skin === 'fox') return '🦊';
    if (skin === 'dragon') return '🐲';
    return '👤';
  }

  // Quick Table Actions
  $('#players-table-body').addEventListener('click', async (e) => {
    const gmBtn = e.target.closest('[data-godmode-id]');
    if (gmBtn) {
      sfx.click();
      openGodModeModal(gmBtn.dataset.godmodeId);
      return;
    }

    const quickBtn = e.target.closest('[data-quick-action]');
    if (quickBtn) {
      sfx.click();
      const action = quickBtn.dataset.quickAction;
      const playerId = quickBtn.dataset.targetId;
      try {
        await api('/api/owner/player-action', {
          method: 'POST',
          body: JSON.stringify({ playerId, action })
        });
        showToast(`Oyuncu işlemi başarılı: ${action}`);
        loadDashboard();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  // ── God Mode Modal ─────────────────────────────────────────────
  function openGodModeModal(playerId) {
    const player = (state.dashboardData?.players || []).find(p => p.id === playerId);
    if (!player) {
      showToast('Oyuncu bulunamadı (ayrılmış olabilir).', 'warning');
      return;
    }

    state.selectedPlayer = player;
    $('#gm-player-name').textContent = player.name;
    $('#gm-player-id').textContent = `Socket ID: ${player.id} · Skin: ${player.skin}`;
    $('#gm-hp').textContent = `${player.hp}/${player.maxHp || 250}`;
    $('#gm-score').textContent = Number(player.score || 0).toLocaleString('tr-TR');
    $('#gm-gold').textContent = Number(player.gold || 0).toLocaleString('tr-TR');
    $('#gm-kills').textContent = player.kills || 0;
    $('#gm-pos').textContent = `${player.x}, ${player.y}`;

    const freezeBtn = $('[data-action="toggle_freeze"]');
    if (freezeBtn) {
      $('#gm-freeze-label').textContent = player.frozen ? 'Buzu Çöz (Unfreeze)' : 'Dondur / Sabitle';
    }

    $('#godmode-modal').classList.remove('hidden');
  }

  function closeGodModeModal() {
    $('#godmode-modal').classList.add('hidden');
    state.selectedPlayer = null;
  }

  $('[data-close-modal="godmode"]').addEventListener('click', () => {
    sfx.click();
    closeGodModeModal();
  });

  // Handle God Mode Modal Clicks
  $('.gm-actions-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('.gm-btn');
    if (!btn || !state.selectedPlayer) return;

    sfx.click();
    const action = btn.dataset.action;
    const playerId = state.selectedPlayer.id;
    let finalAction = action;

    if (action === 'toggle_freeze') {
      finalAction = state.selectedPlayer.frozen ? 'unfreeze' : 'freeze';
    }

    const payload = {
      playerId,
      action: finalAction,
      amount: btn.dataset.amount ? Number(btn.dataset.amount) : undefined,
      x: btn.dataset.x ? Number(btn.dataset.x) : undefined,
      y: btn.dataset.y ? Number(btn.dataset.y) : undefined
    };

    if (finalAction === 'ban') {
      if (!confirm(`${state.selectedPlayer.name} isimli oyuncuyu ve IP adresini sunucudan kalıcı olarak YASAKLAMAK istediğine emin misin?`)) {
        return;
      }
    }

    try {
      await api('/api/owner/player-action', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`İşlem uygulandı: ${finalAction}`);
      closeGodModeModal();
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Tab 4: World & Server Configuration ────────────────────────
  ['xprate', 'mobrate', 'resrate'].forEach(id => {
    $(`#cfg-${id}`).addEventListener('input', (e) => {
      $(`#cfg-${id}-val`).textContent = `${Number(e.target.value).toFixed(1)}x`;
    });
  });

  $('#save-world-config-btn').addEventListener('click', async () => {
    sfx.click();
    const payload = {
      maintenance: $('#cfg-maintenance').checked,
      pvpEnabled: $('#cfg-pvp').checked,
      xpRate: Number($('#cfg-xprate').value),
      mobSpawnMultiplier: Number($('#cfg-mobrate').value),
      resourceRespawnMultiplier: Number($('#cfg-resrate').value)
    };

    try {
      await api('/api/owner/config', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('💾 Dünya ayarları kaydedildi ve tüm haritaya canlı uygulandı!');
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Tab 5: Registered User Accounts & Moderation ───────────────
  $('#user-search').addEventListener('input', (e) => {
    clearTimeout(state.userSearchTimeout);
    state.userSearchTimeout = setTimeout(() => {
      loadUsers(e.target.value);
    }, 300);
  });

  async function loadUsers(query = '') {
    try {
      const q = encodeURIComponent(query.trim());
      const data = await api(`/api/owner/users?q=${q}`);
      state.usersList = data.users || [];
      renderUsersTable(state.usersList);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderUsersTable(users) {
    $('#user-total-count').textContent = `${users.length} Kayıtlı Hesap`;
    const tbody = $('#users-table-body');

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center muted" style="padding:32px 0;">Kayıtlı kullanıcı bulunamadı.</td></tr>`;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const kd = (u.deaths > 0 ? (u.kills / u.deaths).toFixed(2) : u.kills || 0);
      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="player-avatar">👤</div>
              <div>
                <b style="color:#fff;">${escapeHtml(u.username)}</b>
                <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-dim);">ID: #${u.id}</div>
              </div>
            </div>
          </td>
          <td><span style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">${escapeHtml(u.email || '-')}</span></td>
          <td><span style="color:var(--emerald-light);font-weight:700;">⭐ ${Number(u.xp || 0).toLocaleString('tr-TR')}</span></td>
          <td><span style="color:var(--amber-light);font-weight:700;">🪙 ${Number(u.coins || 0).toLocaleString('tr-TR')}</span></td>
          <td><b>${kd}</b> <small class="muted">(${u.kills}/${u.deaths})</small></td>
          <td>${u.gamesPlayed || 0} maç</td>
          <td><b>${Number(u.bestScore || 0).toLocaleString('tr-TR')}</b></td>
          <td class="text-right">
            <button class="btn-action-pill" data-edit-user-id="${u.id}" title="Hesabı Düzenle">
              ✏️ Düzenle
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  $('#users-table-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit-user-id]');
    if (!btn) return;
    sfx.click();
    const userId = Number(btn.dataset.editUserId);
    const user = state.usersList.find(u => u.id === userId);
    if (user) openUserEditModal(user);
  });

  function openUserEditModal(user) {
    $('#ue-user-id').value = user.id;
    $('#ue-user-name').value = user.username;
    $('#ue-username').textContent = user.username;
    $('#ue-id').textContent = `ID: #${user.id} · E-posta: ${user.email || 'Yok'}`;
    $('#ue-coins').value = user.coins || 0;
    $('#ue-xp').value = user.xp || 0;
    $('#ue-new-password').value = '';

    $('#user-edit-modal').classList.remove('hidden');
  }

  function closeUserEditModal() {
    $('#user-edit-modal').classList.add('hidden');
  }

  $('[data-close-modal="user-edit"]').addEventListener('click', () => {
    sfx.click();
    closeUserEditModal();
  });

  $('#user-edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    sfx.click();

    const userId = Number($('#ue-user-id').value);
    const username = $('#ue-user-name').value;
    const coins = Number($('#ue-coins').value);
    const xp = Number($('#ue-xp').value);
    const password = $('#ue-new-password').value.trim();

    const payload = { userId, username, coins, xp };
    if (password) payload.password = password;

    try {
      await api('/api/owner/user-edit', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast('Hesap bilgileri başarıyla güncellendi.');
      closeUserEditModal();
      loadUsers($('#user-search').value);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#ue-delete-btn').addEventListener('click', async () => {
    const userId = Number($('#ue-user-id').value);
    const username = $('#ue-user-name').value;

    if (!confirm(`DİKKAT: "${username}" kullanıcısının hesabı ve tüm ilerlemesi kalıcı olarak silinecek. Onaylıyor musun?`)) {
      return;
    }

    try {
      await api('/api/owner/user-edit', {
        method: 'POST',
        body: JSON.stringify({ userId, username, action: 'delete' })
      });
      showToast('Kullanıcı hesabı tamamen silindi.');
      closeUserEditModal();
      loadUsers($('#user-search').value);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── Tab 6: Cosmetics Catalog ───────────────────────────────────
  let activeCosmeticType = 'all';
  $$('.cat-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sfx.click();
      $$('.cat-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      activeCosmeticType = btn.dataset.type;
      renderCosmeticsGallery();
    });
  });

  async function loadCosmetics() {
    try {
      const data = await api('/api/owner/cosmetics');
      state.cosmeticsData = data;
      renderCosmeticsGallery();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderCosmeticsGallery() {
    const items = state.cosmeticsData?.items || [];
    const filtered = items.filter(item => activeCosmeticType === 'all' || item.type === activeCosmeticType);

    $('#cosmetic-catalog-count').textContent = `${filtered.length} / ${items.length} Kozmetik`;

    const grid = $('#cosmetics-gallery-grid');
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty-feed">Bu kategoride kozmetik bulunamadı.</div>';
      return;
    }

    grid.innerHTML = filtered.map(item => `
      <div class="cosmetic-card">
        <div class="cosmetic-thumb-wrap">
          <img class="cosmetic-img" src="../${item.asset}" onerror="this.outerHTML='🎭'" alt="${escapeHtml(item.name)}">
        </div>
        <div class="cosmetic-name">${escapeHtml(item.name)}</div>
        <span class="cosmetic-rarity-badge rarity-${item.rarity}">${item.rarity}</span>
        <div class="cosmetic-meta">🪙 ${Number(item.price || 0).toLocaleString('tr-TR')} Altın</div>
      </div>
    `).join('');
  }

  // ── Tab 7: Security & Audit Log Timeline ────────────────────────
  function renderAuditTimeline() {
    const list = state.dashboardData?.audit || [];
    const container = $('#full-audit-timeline');

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-feed">Henüz denetim kaydı bulunmuyor.</div>';
    } else {
      container.innerHTML = list.map(entry => `
        <div class="timeline-entry">
          <div class="timeline-main">
            <span class="timeline-action">${escapeHtml(entry.action)}</span>
            <span class="timeline-actor">Yetkili: ${escapeHtml(entry.username || 'System')}</span>
          </div>
          <div class="timeline-meta">${new Date(entry.at).toLocaleString('tr-TR')}</div>
        </div>
      `).join('');
    }

    // Render Banned Targets
    const banned = state.dashboardData?.banned || [];
    const banContainer = $('#active-ban-list');
    if (banned.length === 0) {
      banContainer.innerHTML = '<div class="empty-feed">Aktif yasaklama bulunmuyor.</div>';
    } else {
      banContainer.innerHTML = banned.map(target => `
        <div class="ban-item">
          <span class="ban-target">🚫 ${escapeHtml(target)}</span>
          <button class="btn-unban" data-unban-target="${escapeHtml(target)}">Yasağı Kaldır</button>
        </div>
      `).join('');
    }
  }

  $('#manual-ban-btn').addEventListener('click', async () => {
    const input = $('#manual-ban-target');
    const target = input.value.trim();
    if (!target) return;

    sfx.click();
    try {
      await api('/api/owner/ban', {
        method: 'POST',
        body: JSON.stringify({ target })
      });
      showToast(`Hedef yasaklandı: ${target}`);
      input.value = '';
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  $('#active-ban-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unban-target]');
    if (!btn) return;
    sfx.click();
    const target = btn.dataset.unbanTarget;

    try {
      await api('/api/owner/ban', {
        method: 'POST',
        body: JSON.stringify({ target, action: 'unban' })
      });
      showToast(`Yasak kaldırıldı: ${target}`);
      loadDashboard();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ── HTML Escape Helper ─────────────────────────────────────────
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>'"]/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c]));
  }

  // ── Keyboard Shortcuts (ESC closes modals) ────────────────────
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeGodModeModal();
      closeUserEditModal();
    }
  });

  // ── Initial Boot ───────────────────────────────────────────────
  (async () => {
    if (!state.token) {
      showLoginView();
      return;
    }

    try {
      const res = await api('/api/owner/me');
      showAppView(res.user);
    } catch (_) {
      showLoginView();
    }
  })();

})();
