function esc(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

let currentUser = null;

function showLoginScreen() {
  const invite = new URLSearchParams(location.search).get('invite');
  document.getElementById('login-link').href = invite
    ? `/auth/discord?invite=${encodeURIComponent(invite)}`
    : '/auth/discord';
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app-shell').classList.add('hidden');
}

function showApp(user) {
  currentUser = user;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('auth-name').textContent = user.discord_username ?? user.name;
  document.getElementById('auth-avatar').src = user.discord_avatar_url ?? '';
  document.getElementById('auth-avatar').classList.toggle('hidden', !user.discord_avatar_url);
  const isLeader = user.role === 'leader';
  for (const el of document.querySelectorAll('.leader-only')) {
    el.classList.toggle('hidden', !isLeader);
  }
}

const api = (path, options) =>
  fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...options }).then(async (r) => {
    if (r.status === 401) {
      showLoginScreen();
      throw new Error('authentication required');
    }
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    return body;
  });

document.getElementById('logout-btn').onclick = async () => {
  await fetch('/auth/logout', { method: 'POST' });
  showLoginScreen();
};

document.getElementById('invite-btn').onclick = async () => {
  try {
    const invite = await api('/invites', { method: 'POST', body: JSON.stringify({}) });
    await navigator.clipboard.writeText(`${location.origin}${invite.url}`);
    alert('Invite link copied to clipboard!');
  } catch (err) {
    alert(err.message);
  }
};

async function bootstrap() {
  let me;
  try {
    me = await fetch('/api/me').then((r) => (r.ok ? r.json() : null));
  } catch {
    me = null;
  }
  if (!me) {
    return showLoginScreen();
  }
  showApp(me);
  await loadPlayRoulettes();
  await joinLobbyFromLink();
}

async function joinLobbyFromLink() {
  const matchId = new URLSearchParams(location.search).get('match');
  if (!matchId) return;
  let match;
  try {
    match = await api(`/matches/${matchId}`);
  } catch {
    return;
  }
  if (match.status !== 'waiting') return;
  currentMatch = match;
  enterLobby();
}

// --- Tabs ---
for (const btn of document.querySelectorAll('nav button')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    refreshTab(btn.dataset.tab);
  });
}

function refreshTab(tab) {
  if (tab === 'games') loadGames();
  if (tab === 'roulettes') loadRoulettes();
  if (tab === 'players') loadPlayers();
  if (tab === 'history') loadHistory();
  if (tab === 'play') loadPlayRoulettes();
}

// --- Games ---
async function loadGames() {
  const games = await api('/games');
  const tbody = document.querySelector('#games-table tbody');
  tbody.innerHTML = '';
  document.getElementById('games-table').classList.toggle('hidden', games.length === 0);
  document.getElementById('games-empty').classList.toggle('hidden', games.length > 0);
  for (const g of games) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td data-label="Title">${esc(g.title)}</td><td data-label="Steam AppID">${esc(g.steam_appid)}</td><td></td>`;
    if (currentUser?.role === 'leader') {
      const del = document.createElement('button');
      del.textContent = 'Remove';
      del.className = 'secondary';
      del.onclick = async () => {
        try {
          await api(`/games/${g.id}`, { method: 'DELETE' });
        } catch (err) {
          return alert(err.message);
        }
        loadGames();
      };
      tr.lastElementChild.appendChild(del);
    }
    tbody.appendChild(tr);
  }
}
document.getElementById('game-add').onclick = async () => {
  const input = document.getElementById('game-title');
  if (!input.value.trim()) return;
  await api('/games', { method: 'POST', body: JSON.stringify({ title: input.value.trim() }) });
  input.value = '';
  loadGames();
};

// --- Steam search (as-you-type suggestions) ---
let searchDebounce = null;
document.getElementById('game-search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchDebounce);
  const resultsEl = document.getElementById('game-search-results');
  if (q.length < 2) {
    resultsEl.innerHTML = '';
    return;
  }
  searchDebounce = setTimeout(async () => {
    let results;
    try {
      results = await api(`/steam/search?q=${encodeURIComponent(q)}`);
    } catch {
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.innerHTML = '';
    for (const r of results) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `${r.cover_url ? `<img src="${esc(r.cover_url)}" alt="" />` : ''}<span>${esc(r.title)}</span>`;
      item.onclick = async () => {
        await api('/games', {
          method: 'POST',
          body: JSON.stringify({ title: r.title, steam_appid: r.appid, cover_url: r.cover_url }),
        });
        document.getElementById('game-search').value = '';
        resultsEl.innerHTML = '';
        loadGames();
      };
      resultsEl.appendChild(item);
    }
  }, 300);
});

// --- Roulettes ---
async function loadRoulettes() {
  const roulettes = await api('/roulettes');
  const select = document.getElementById('roulette-select');
  select.innerHTML = roulettes.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const hasRoulettes = roulettes.length > 0;
  document.getElementById('roulettes-empty').classList.toggle('hidden', hasRoulettes);
  document.querySelector('#tab-roulettes .row:has(#roulette-select)').classList.toggle('hidden', !hasRoulettes);
  if (hasRoulettes) loadRouletteGames(select.value);
  else document.getElementById('roulette-games').innerHTML = '';
}
document.getElementById('roulette-select').addEventListener('change', (e) => loadRouletteGames(e.target.value));

async function loadRouletteGames(id) {
  if (!id) return;
  const [roulette, allGames] = await Promise.all([api(`/roulettes/${id}`), api('/games')]);
  const container = document.getElementById('roulette-games');
  const memberIds = new Set(roulette.games.map((g) => g.id));
  container.innerHTML = '<h3>Games in this roulette</h3>';
  if (allGames.length === 0) {
    container.innerHTML += '<p class="empty-state">No games in the pool yet. Add some in the Games tab first.</p>';
    return;
  }
  if (memberIds.size === 0) {
    container.innerHTML += '<p class="empty-state">No games added to this roulette yet — check the boxes below to add some.</p>';
  }
  for (const g of allGames) {
    const chip = document.createElement('label');
    chip.className = 'game-chip';
    const checked = memberIds.has(g.id);
    const isLeader = currentUser?.role === 'leader';
    chip.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} ${isLeader ? '' : 'disabled'}/> ${esc(g.title)}`;
    chip.querySelector('input').onchange = async (e) => {
      if (e.target.checked) {
        await api(`/roulettes/${id}/games`, { method: 'POST', body: JSON.stringify({ game_id: g.id }) });
      } else {
        await api(`/roulettes/${id}/games/${g.id}`, { method: 'DELETE' });
      }
      loadRouletteGames(id);
    };
    container.appendChild(chip);
  }
}
document.getElementById('roulette-add').onclick = async () => {
  const input = document.getElementById('roulette-name');
  if (!input.value.trim()) return;
  await api('/roulettes', { method: 'POST', body: JSON.stringify({ name: input.value.trim() }) });
  input.value = '';
  loadRoulettes();
};
document.getElementById('roulette-delete').onclick = async () => {
  const id = document.getElementById('roulette-select').value;
  if (!id) return;
  await api(`/roulettes/${id}`, { method: 'DELETE' });
  loadRoulettes();
};

// --- Players ---
async function loadPlayers() {
  const players = await api('/players');
  const leaderCount = players.filter((p) => p.role === 'leader').length;
  const tbody = document.querySelector('#players-table tbody');
  tbody.innerHTML = '';
  document.getElementById('players-table').classList.toggle('hidden', players.length === 0);
  document.getElementById('players-empty').classList.toggle('hidden', players.length > 0);
  for (const p of players) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td data-label="Name">${esc(p.name)}${p.role === 'leader' ? ' 👑' : ''}</td><td data-label="Skips left / quota"></td><td data-label="SteamID64">${esc(p.steam_id64)}</td><td></td>`;
    const skipCell = tr.children[1];
    const skipCount = document.createElement('span');
    skipCount.textContent = `${p.skips_remaining} / ${p.skip_quota}`;
    skipCell.appendChild(skipCount);
    if (currentUser?.role === 'leader') {
      const adjustSkips = async (delta) => {
        const updated = await api(`/players/${p.id}`, {
          method: 'PUT',
          body: JSON.stringify({ skips_remaining: Math.max(0, p.skips_remaining + delta) }),
        });
        skipCount.textContent = `${updated.skips_remaining} / ${updated.skip_quota}`;
        p.skips_remaining = updated.skips_remaining;
      };
      const minusBtn = document.createElement('button');
      minusBtn.textContent = '−';
      minusBtn.className = 'secondary skip-btn';
      minusBtn.title = 'Take away a skip';
      minusBtn.onclick = () => adjustSkips(-1);
      const plusBtn = document.createElement('button');
      plusBtn.textContent = '+';
      plusBtn.className = 'secondary skip-btn';
      plusBtn.title = 'Give a skip';
      plusBtn.onclick = () => adjustSkips(1);
      skipCell.appendChild(minusBtn);
      skipCell.appendChild(plusBtn);
    }
    const cell = tr.lastElementChild;
    if (currentUser?.role === 'leader') {
      const roleBtn = document.createElement('button');
      const isSoleLeader = p.role === 'leader' && leaderCount <= 1;
      roleBtn.textContent = p.role === 'leader' ? 'Demote' : 'Promote to leader';
      roleBtn.className = 'secondary';
      roleBtn.disabled = isSoleLeader;
      roleBtn.title = isSoleLeader ? "Can't demote the only leader" : '';
      roleBtn.onclick = async () => {
        try {
          await api(`/players/${p.id}`, {
            method: 'PUT',
            body: JSON.stringify({ role: p.role === 'leader' ? 'member' : 'leader' }),
          });
        } catch (err) {
          return alert(err.message);
        }
        loadPlayers();
      };
      cell.appendChild(roleBtn);
      if (p.steam_id64) {
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import Steam';
        importBtn.className = 'secondary';
        importBtn.onclick = async () => {
          importBtn.disabled = true;
          try {
            const result = await api(`/players/${p.id}/steam-import`, { method: 'POST' });
            alert(`Imported ${result.imported} games for ${p.name}`);
            loadGames();
          } catch (err) {
            alert(err.message);
          } finally {
            importBtn.disabled = false;
          }
        };
        cell.appendChild(importBtn);
      }
      const del = document.createElement('button');
      del.textContent = 'Remove';
      del.className = 'secondary';
      del.onclick = async () => {
        await api(`/players/${p.id}`, { method: 'DELETE' });
        loadPlayers();
      };
      cell.appendChild(del);
    }
    tbody.appendChild(tr);
  }
}
document.getElementById('player-add').onclick = async () => {
  const name = document.getElementById('player-name');
  const steamid = document.getElementById('player-steamid');
  const quota = document.getElementById('player-quota');
  if (!name.value.trim()) return;
  await api('/players', {
    method: 'POST',
    body: JSON.stringify({
      name: name.value.trim(),
      steam_id64: steamid.value.trim() || null,
      skip_quota: Number(quota.value) || 0,
    }),
  });
  name.value = '';
  steamid.value = '';
  loadPlayers();
};

// --- FX (exaggerated match-event feedback) ---
let audioCtx = null;
function beep({ freq = 440, duration = 0.08, type = 'square', gain = 0.15, endFreq } = {}) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audioCtx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  if (endFreq) osc.frequency.linearRampToValueAtTime(endFreq, ctx.currentTime + duration);
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function triggerSirenEffect() {
  const overlay = document.getElementById('fx-overlay');
  if (!reducedMotion()) {
    overlay.classList.remove('siren');
    void overlay.offsetHeight;
    overlay.classList.add('siren');
    setTimeout(() => overlay.classList.remove('siren'), 1300);
  }
  for (let i = 0; i < 4; i++) {
    setTimeout(() => beep({ freq: 620, endFreq: 900, duration: 0.15, type: 'sawtooth', gain: 0.12 }), i * 300);
  }
}

function triggerEliminateEffect() {
  beep({ freq: 160, endFreq: 60, duration: 0.3, type: 'sawtooth', gain: 0.2 });
  if (reducedMotion()) return;
  const stage = document.querySelector('.wheel-stage');
  const stamp = document.createElement('div');
  stamp.className = 'eliminate-stamp';
  stamp.textContent = '✕';
  stage.appendChild(stamp);
  stamp.addEventListener('animationend', () => stamp.remove());
}

function triggerWinEffect() {
  [523, 659, 784].forEach((freq, i) => {
    setTimeout(() => beep({ freq, duration: 0.18, type: 'square', gain: 0.15 }), i * 140);
  });
  if (reducedMotion()) return;
  const overlay = document.getElementById('fx-overlay');
  const colors = ['#1f6f43', '#d4af37', '#b3413a', '#e8e8ec'];
  for (let i = 0; i < 30; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = `${1.8 + Math.random() * 1.2}s`;
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    overlay.appendChild(piece);
    piece.addEventListener('animationend', () => piece.remove());
  }
}

// --- Play ---
let currentMatch = null;
let wheelRotation = 0;
let wheelGames = [];

async function loadPlayRoulettes() {
  const roulettes = await api('/roulettes');
  document.getElementById('play-roulette').innerHTML = roulettes
    .map((r) => `<option value="${r.id}">${esc(r.name)}</option>`)
    .join('');
  document.getElementById('play-start').disabled = roulettes.length === 0;
  if (roulettes.length === 0) {
    document.getElementById('play-state').textContent = 'No roulettes yet — create one in the Roulettes tab and add some games to it first.';
  }
}

// Polar point on a clock face: 0deg = top, clockwise. Matches the wheel's own
// rotation convention so slice angle math and the visual pointer stay in sync.
function polarPoint(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function truncateLabel(title, sliceCount) {
  const maxChars = sliceCount <= 4 ? 18 : sliceCount <= 6 ? 13 : sliceCount <= 8 ? 10 : 8;
  return title.length > maxChars ? `${title.slice(0, maxChars - 1)}…` : title;
}

// rotationOffset is the wheel's current CSS rotation (deg) at draw time. Text
// upright/flip has to be judged against where a label will actually sit on
// screen once that rotation is applied — not its angle within the SVG's own
// unrotated coordinates — otherwise labels flip based on stale geometry and
// can render upside down after the wheel has spun (see wheelRotation usage
// at call sites).
function buildWheelSVG(games, rotationOffset = 0) {
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;
  if (games.length === 0) {
    return `<svg viewBox="0 0 ${size} ${size}"><circle cx="${cx}" cy="${cy}" r="${r - 3}" fill="#22242e" /><text class="empty-label" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle">No games</text></svg>`;
  }
  const segAngle = 360 / games.length;
  const fontSize = Math.max(9, Math.min(15, 130 / games.length));
  const labelRadius = r * 0.62;
  const rotMod = ((rotationOffset % 360) + 360) % 360;
  let slices = '';
  games.forEach((game, i) => {
    const start = i * segAngle;
    const end = start + segAngle;
    const p1 = polarPoint(cx, cy, r, start);
    const p2 = polarPoint(cx, cy, r, end);
    const largeArc = segAngle > 180 ? 1 : 0;
    const fill = i % 2 === 0 ? '#1f6f43' : '#22242e';
    const path = `M ${cx} ${cy} L ${p1.x} ${p1.y} A ${r} ${r} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z`;
    const mid = start + segAngle / 2;
    const screenMid = (mid + rotMod) % 360;
    const flip = screenMid > 90 && screenMid < 270;
    const label = esc(truncateLabel(game.title, games.length));
    slices += `<path d="${path}" fill="${fill}" stroke="#14151a" stroke-width="1" />`;
    slices += `<g transform="rotate(${mid} ${cx} ${cy})"><g transform="translate(${cx} ${cy - labelRadius}) rotate(${flip ? 180 : 0})"><text class="wheel-label" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}">${label}<title>${esc(game.title)}</title></text></g></g>`;
  });
  return `<svg viewBox="0 0 ${size} ${size}">${slices}</svg>`;
}

function renderWheel(games, rotationOffset = 0) {
  document.getElementById('wheel').innerHTML = buildWheelSVG(games, rotationOffset);
}

async function loadWheelGamesForRoulette(rouletteId) {
  const roulette = await api(`/roulettes/${rouletteId}`);
  return roulette.games.filter((g) => g.active);
}

document.getElementById('play-start').onclick = async () => {
  const roulette_id = Number(document.getElementById('play-roulette').value);
  const elimination_rounds = Number(document.getElementById('play-rounds').value) || 0;
  if (!roulette_id) return alert('Create a roulette with games first.');
  currentMatch = await api('/matches', { method: 'POST', body: JSON.stringify({ roulette_id, elimination_rounds }) });
  currentMatch = await api(`/matches/${currentMatch.id}`);
  enterLobby();
};

let lobbyPollTimer = null;

const isLeaderUser = () => currentUser?.role === 'leader';

function enterLobby() {
  document.getElementById('play-setup').classList.add('hidden');
  document.getElementById('play-lobby').classList.remove('hidden');
  document.querySelector('.wheel-stage').classList.add('hidden');
  document.getElementById('play-actions').innerHTML = '';
  document.getElementById('play-state').textContent = '';
  renderLobby();
  updateCancelVisibility();
  clearInterval(lobbyPollTimer);
  lobbyPollTimer = setInterval(refreshLobby, 3000);
}

function updateCancelVisibility() {
  const show = isLeaderUser() && currentMatch && (currentMatch.status === 'waiting' || currentMatch.status === 'in_progress');
  document.getElementById('cancel-match-btn').classList.toggle('hidden', !show);
}

function resetPlayStage() {
  clearInterval(lobbyPollTimer);
  currentMatch = null;
  wheelGames = [];
  document.getElementById('play-setup').classList.remove('hidden');
  document.getElementById('play-lobby').classList.add('hidden');
  document.querySelector('.wheel-stage').classList.add('hidden');
  document.getElementById('play-actions').innerHTML = '';
  document.getElementById('play-state').textContent = '';
  document.getElementById('cancel-match-btn').classList.add('hidden');
  loadPlayRoulettes();
}

document.getElementById('cancel-match-btn').onclick = async () => {
  if (!currentMatch || !confirm('Cancel this match?')) return;
  try {
    await api(`/matches/${currentMatch.id}/cancel`, { method: 'POST' });
  } catch (err) {
    return alert(err.message);
  }
  resetPlayStage();
};

document.getElementById('lobby-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/?match=${currentMatch.id}`);
    alert('Lobby link copied to clipboard!');
  } catch (err) {
    alert(err.message);
  }
};

async function refreshLobby() {
  currentMatch = await api(`/matches/${currentMatch.id}`);
  if (currentMatch.status !== 'waiting') {
    clearInterval(lobbyPollTimer);
    return;
  }
  renderLobby();
}

function renderLobby() {
  const list = document.getElementById('lobby-players');
  list.innerHTML = currentMatch.players.length
    ? currentMatch.players.map((p) => `<span class="game-chip">${esc(p.name)}${p.role === 'leader' ? ' 👑' : ''}</span>`).join('')
    : '<p class="empty-state">No one has joined yet.</p>';
  const joined = currentMatch.players.some((p) => p.id === currentUser.id);
  document.getElementById('lobby-join').classList.toggle('hidden', joined);
  document.getElementById('lobby-start').disabled = currentMatch.players.length === 0;
  document.getElementById('lobby-link').classList.toggle('hidden', !isLeaderUser());
}

document.getElementById('lobby-join').onclick = async () => {
  try {
    await api(`/matches/${currentMatch.id}/join`, { method: 'POST' });
  } catch (err) {
    return alert(err.message);
  }
  currentMatch = await api(`/matches/${currentMatch.id}`);
  renderLobby();
};

document.getElementById('lobby-start').onclick = async () => {
  try {
    await api(`/matches/${currentMatch.id}/start`, { method: 'POST' });
  } catch (err) {
    return alert(err.message);
  }
  clearInterval(lobbyPollTimer);
  currentMatch = await api(`/matches/${currentMatch.id}`);
  document.getElementById('play-lobby').classList.add('hidden');
  document.querySelector('.wheel-stage').classList.remove('hidden');
  wheelGames = await loadWheelGamesForRoulette(currentMatch.roulette_id);
  const wheel = document.getElementById('wheel');
  wheelRotation = 0;
  wheel.style.transition = 'none';
  wheel.style.transform = 'rotate(0deg)';
  renderWheel(wheelGames);
  void wheel.offsetHeight;
  wheel.style.transition = '';
  document.getElementById('play-state').textContent = 'Match started. Spin!';
  updateCancelVisibility();
  renderPlayActions();
};

function renderPlayActions() {
  const actions = document.getElementById('play-actions');
  actions.innerHTML = '';
  if (!currentMatch || currentMatch.status === 'complete') return;

  const spinBtn = document.createElement('button');
  spinBtn.textContent = 'Spin';
  spinBtn.onclick = doSpin;
  actions.appendChild(spinBtn);
}

// Reads the wheel's live rendered rotation (works mid-transition, any easing).
function currentWheelAngle(el) {
  const t = getComputedStyle(el).transform;
  if (t === 'none') return 0;
  const [a, b] = t.match(/^matrix\(([^)]+)\)$/)[1].split(',').map(Number);
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

// Pulses the pointer each time a wedge boundary passes under it. Sampling the
// live transform (rather than the eased duration) means ticks land exactly on
// crossings and naturally speed up/slow down with the wheel itself.
function runTickLoop(wheel, pointer, segAngle, startRotation, endRotation) {
  let lastRaw = ((startRotation % 360) + 360) % 360;
  let unwrapped = startRotation;
  let lastSeg = Math.floor((((-unwrapped) % 360) + 360) % 360 / segAngle);
  let rafId = requestAnimationFrame(function frame() {
    const raw = currentWheelAngle(wheel);
    let delta = raw - lastRaw;
    if (delta < -180) delta += 360;
    if (delta > 180) delta -= 360;
    unwrapped += Math.max(delta, 0);
    lastRaw = raw;
    const seg = Math.floor((((-unwrapped) % 360) + 360) % 360 / segAngle);
    if (seg !== lastSeg) {
      lastSeg = seg;
      pointer.classList.add('tick');
      setTimeout(() => pointer.classList.remove('tick'), 90);
      beep({ freq: 700 + Math.random() * 150, duration: 0.035, type: 'square', gain: 0.06 });
    }
    if (unwrapped < endRotation - 0.5) rafId = requestAnimationFrame(frame);
  });
  return () => cancelAnimationFrame(rafId);
}

async function doSpin() {
  const wheel = document.getElementById('wheel');
  const pointer = document.querySelector('.wheel-pointer');
  const result = document.getElementById('wheel-result');
  result.classList.remove('show');
  result.textContent = '';
  let spin;
  try {
    spin = await api(`/matches/${currentMatch.id}/spin`, { method: 'POST' });
  } catch (err) {
    return alert(err.message);
  }

  let idx = wheelGames.findIndex((g) => g.id === spin.spun_game.id);
  if (idx === -1) {
    // ponytail: pool is tracked client-side (start + local eliminations), not
    // fetched fresh per spin. If it ever drifts from the server, resync once.
    wheelGames = await loadWheelGamesForRoulette(currentMatch.roulette_id);
    renderWheel(wheelGames, wheelRotation);
    idx = wheelGames.findIndex((g) => g.id === spin.spun_game.id);
  }

  const segAngle = 360 / wheelGames.length;
  const targetCenter = idx * segAngle + segAngle / 2;
  const finalAngleMod = ((360 - targetCenter) % 360 + 360) % 360;
  const currentMod = ((wheelRotation % 360) + 360) % 360;
  let add = finalAngleMod - currentMod;
  if (add <= 0) add += 360;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const extraSpins = reduced ? 0 : 4 + Math.floor(Math.random() * 3);
  add += 360 * extraSpins;
  const duration = reduced ? 0.3 : 2.6 + Math.random() * 1;

  const startRotation = wheelRotation;
  wheelRotation += add;
  wheel.style.transitionDuration = `${duration}s`;
  wheel.style.transform = `rotate(${wheelRotation}deg)`;

  const stopTicking = reduced ? () => {} : runTickLoop(wheel, pointer, segAngle, startRotation, wheelRotation);
  await new Promise((resolve) => {
    wheel.addEventListener(
      'transitionend',
      (e) => {
        if (e.propertyName === 'transform') resolve();
      },
      { once: true }
    );
  });
  stopTicking();
  // Text upright/flip was drawn for the rotation at spin-start; redraw now
  // that the wheel has landed so the winning label (always at the pointer)
  // reads right-side up.
  renderWheel(wheelGames, wheelRotation);

  result.textContent = spin.spun_game.title;
  result.classList.add('show');
  document.getElementById('play-state').textContent = `Round ${spin.round_number} (${spin.round_type})`;
  renderResolveActions(spin);
}

async function loadPlayersForSkip() {
  const [players, match] = await Promise.all([api('/players'), api(`/matches/${currentMatch.id}`)]);
  const joinedIds = new Set(match.players.map((p) => p.id));
  return players.filter((p) => joinedIds.has(p.id));
}

async function renderResolveActions(spin) {
  const actions = document.getElementById('play-actions');
  actions.innerHTML = '';

  if (spin.round_type === 'elimination') {
    const eliminateBtn = document.createElement('button');
    eliminateBtn.textContent = `Eliminate "${spin.spun_game.title}"`;
    eliminateBtn.className = 'danger';
    eliminateBtn.onclick = () => resolveMatch({ outcome: 'eliminate' }, spin.spun_game);
    actions.appendChild(eliminateBtn);
  } else {
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = `Play "${spin.spun_game.title}"!`;
    confirmBtn.className = 'win';
    confirmBtn.onclick = () => resolveMatch({ outcome: 'confirm_win' });
    actions.appendChild(confirmBtn);
  }

  const players = await loadPlayersForSkip();
  const eligible = players.filter((p) => p.skips_remaining > 0);
  if (eligible.length) {
    const select = document.createElement('select');
    select.innerHTML = eligible.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.skips_remaining} left)</option>`).join('');
    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip (respin)';
    skipBtn.className = 'secondary';
    skipBtn.onclick = () => resolveMatch({ outcome: 'skip', skip_used_by: Number(select.value) });
    actions.appendChild(select);
    actions.appendChild(skipBtn);
  }
}

async function resolveMatch(payload, eliminatedGame) {
  currentMatch = await api(`/matches/${currentMatch.id}/resolve`, { method: 'POST', body: JSON.stringify(payload) });
  if (payload.outcome === 'skip') triggerSirenEffect();
  if (eliminatedGame) {
    wheelGames = wheelGames.filter((g) => g.id !== eliminatedGame.id);
    renderWheel(wheelGames, wheelRotation);
    triggerEliminateEffect();
  }
  document.getElementById('play-actions').innerHTML = '';
  if (currentMatch.status === 'complete') {
    document.getElementById('play-state').textContent = 'Match complete!';
    triggerWinEffect();
    updateCancelVisibility();
    const again = document.createElement('button');
    again.textContent = 'Play Another Roulette';
    again.onclick = resetPlayStage;
    document.getElementById('play-actions').appendChild(again);
  } else {
    document.getElementById('play-state').textContent = 'Resolved. Spin again!';
    renderPlayActions();
  }
}

// --- History ---
async function loadHistory() {
  const matches = await api('/matches');
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  document.getElementById('history-detail').innerHTML = '';
  document.getElementById('history-empty').classList.toggle('hidden', matches.length > 0);
  for (const m of matches) {
    const item = document.createElement('div');
    item.className = `history-item status-${m.status}`;
    item.textContent = `${m.roulette_name} — ${m.status} (${new Date(m.created_at).toLocaleString()})`;
    item.onclick = () => showHistoryDetail(m.id);
    list.appendChild(item);
  }
}
async function showHistoryDetail(id) {
  const m = await api(`/matches/${id}`);
  const detail = document.getElementById('history-detail');
  const rounds = m.rounds
    .map((r) => `<li>Round ${r.round_number} (${esc(r.round_type)}): ${esc(r.spun_game_title)} — ${esc(r.outcome)}${r.skip_used_by_name ? ` (skipped by ${esc(r.skip_used_by_name)})` : ''}</li>`)
    .join('');
  detail.innerHTML = `<h3>${esc(m.roulette_name)}</h3><p>Status: ${esc(m.status)}${m.result_game_title ? ` — Winner: ${esc(m.result_game_title)}` : ''}</p><ul>${rounds}</ul>`;
}

// initial load
bootstrap();
