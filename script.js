/* ============================================================
   MyTunes — script.js
   Reads a GitHub repo structure (Artist/Album/tracks) via API
   and builds a full music player.
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────
const state = {
  user: '', repo: '', path: 'music', token: '',
  library: [],        // [{ artist, albums: [{ name, coverUrl, tracks: [{ title, url, num }] }] }]
  currentArtist: null,
  currentAlbum: null,
  queue: [],          // flat array of { title, artist, album, url, coverUrl }
  queueIndex: -1,
  playing: false,
  shuffle: false,
  repeat: 'none',    // 'none' | 'one' | 'all'
};

// ── DOM REFS ─────────────────────────────────────────────────
const audio         = document.getElementById('audio-engine');
const configModal   = document.getElementById('config-modal');
const app           = document.getElementById('app');
const loadingOverlay= document.getElementById('loading-overlay');
const loadingMsg    = document.getElementById('loading-msg');
const modalError    = document.getElementById('modal-error');

// ── INIT ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // restore saved config
  const saved = localStorage.getItem('mytunes_config');
  if (saved) {
    const cfg = JSON.parse(saved);
    document.getElementById('gh-user').value  = cfg.user  || '';
    document.getElementById('gh-repo').value  = cfg.repo  || '';
    document.getElementById('gh-path').value  = cfg.path  || 'music';
    document.getElementById('gh-token').value = cfg.token || '';
  }

  document.getElementById('load-btn').addEventListener('click', startLoad);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('back-to-albums').addEventListener('click', () => showView('albums'));
  document.getElementById('play-all-btn').addEventListener('click', playAll);

  // audio events
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('loadedmetadata', onMetadata);
  audio.addEventListener('error', onAudioError);

  // volume
  audio.volume = 0.8;
});

// ── GITHUB API ───────────────────────────────────────────────
function ghHeaders() {
  const h = { Accept: 'application/vnd.github.v3+json' };
  if (state.token) h['Authorization'] = `token ${state.token}`;
  return h;
}

async function ghContents(path) {
  const url = `https://api.github.com/repos/${state.user}/${state.repo}/contents/${path}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.json();
}

function rawUrl(filePath) {
  return `https://raw.githubusercontent.com/${state.user}/${state.repo}/HEAD/${filePath}`;
}

// ── LIBRARY BUILDER ──────────────────────────────────────────
async function startLoad() {
  state.user  = document.getElementById('gh-user').value.trim();
  state.repo  = document.getElementById('gh-repo').value.trim();
  state.path  = document.getElementById('gh-path').value.trim() || 'music';
  state.token = document.getElementById('gh-token').value.trim();

  if (!state.user || !state.repo) {
    showModalError('Inserisci username e nome repository.');
    return;
  }

  localStorage.setItem('mytunes_config', JSON.stringify({
    user: state.user, repo: state.repo, path: state.path, token: state.token
  }));

  hideModalError();
  showLoading('Connessione al repository…');

  try {
    state.library = await buildLibrary();
  } catch (e) {
    hideLoading();
    showModalError(`Errore: ${e.message}`);
    return;
  }

  hideLoading();

  if (state.library.length === 0) {
    showModalError(`Nessun artista trovato in /${state.path}. Controlla la struttura del repo.`);
    return;
  }

  configModal.classList.add('hidden');
  app.classList.remove('hidden');
  renderArtists();
  showView('artists');
}

async function buildLibrary() {
  setLoadingMsg('Lettura artisti…');
  const artistDirs = (await ghContents(state.path)).filter(i => i.type === 'dir');

  const library = [];

  for (const artistDir of artistDirs) {
    setLoadingMsg(`Caricamento: ${artistDir.name}…`);
    const albumDirs = (await ghContents(artistDir.path)).filter(i => i.type === 'dir');
    const albums = [];

    for (const albumDir of albumDirs) {
      const contents = await ghContents(albumDir.path);

      // cover
      const coverFile = contents.find(f =>
        f.type === 'file' &&
        /^cover\.(jpg|jpeg|png|webp)$/i.test(f.name)
      );
      const coverUrl = coverFile ? rawUrl(coverFile.path) : null;

      // tracks
      const tracks = contents
        .filter(f => f.type === 'file' && /\.(mp3|flac|ogg|wav|aac|m4a)$/i.test(f.name))
        .map(f => {
          const num = parseInt(f.name.match(/^(\d+)/)?.[1] || '0', 10);
          const title = cleanTitle(f.name);
          return { title, url: rawUrl(f.path), num, filename: f.name };
        })
        .sort((a, b) => a.num - b.num || a.filename.localeCompare(b.filename));

      if (tracks.length > 0) {
        albums.push({ name: albumDir.name, coverUrl, tracks });
      }
    }

    if (albums.length > 0) {
      library.push({ artist: artistDir.name, albums });
    }
  }

  return library;
}

function cleanTitle(filename) {
  return filename
    .replace(/\.\w+$/, '')           // remove extension
    .replace(/^\d+[\s.\-_]+/, '')    // remove leading track number
    .trim();
}

// ── VIEWS ────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');

  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById(`nav-${name}`);
  if (navBtn) navBtn.classList.add('active');

  updateBreadcrumb(name);

  if (name === 'queue') renderQueue();
}

function updateBreadcrumb(view) {
  const bc = document.getElementById('breadcrumb');
  let html = `<div style="opacity:.5; font-size:.72rem; padding:4px 8px; line-height:1.8">`;
  html += `/ ${state.path}`;
  if (view === 'albums' && state.currentArtist) {
    html += `<br>/ ${state.currentArtist.artist}`;
  }
  if (view === 'tracks' && state.currentAlbum) {
    html += `<br>/ ${state.currentArtist?.artist || ''}`;
    html += `<br>/ ${state.currentAlbum.name}`;
  }
  html += '</div>';
  bc.innerHTML = html;
}

// ── RENDER ARTISTS ───────────────────────────────────────────
function renderArtists() {
  const grid = document.getElementById('artists-grid');
  document.getElementById('artists-heading').textContent =
    `Artisti (${state.library.length})`;

  grid.innerHTML = '';
  state.library.forEach(artist => {
    // pick first album cover as artist art
    const firstCover = artist.albums.find(a => a.coverUrl)?.coverUrl;
    const albumCount = artist.albums.length;
    const card = makeCard(
      artist.artist,
      `${albumCount} album`,
      firstCover,
      '🎤',
      () => openArtist(artist)
    );
    grid.appendChild(card);
  });
}

function filterItems() {
  const q = document.getElementById('search-input').value.toLowerCase();
  const grid = document.getElementById('artists-grid');
  grid.querySelectorAll('.card').forEach(card => {
    const name = card.querySelector('.card-name').textContent.toLowerCase();
    card.style.display = name.includes(q) ? '' : 'none';
  });
}

// ── RENDER ALBUMS ────────────────────────────────────────────
function openArtist(artist) {
  state.currentArtist = artist;
  document.getElementById('albums-heading').textContent = artist.artist;
  const grid = document.getElementById('albums-grid');
  grid.innerHTML = '';

  artist.albums.forEach(album => {
    const card = makeCard(
      album.name,
      `${album.tracks.length} tracce`,
      album.coverUrl,
      '💿',
      () => openAlbum(album)
    );
    grid.appendChild(card);
  });

  showView('albums');
}

// ── RENDER TRACKS ────────────────────────────────────────────
function openAlbum(album) {
  state.currentAlbum = album;

  document.getElementById('track-artist-name').textContent =
    state.currentArtist?.artist || '';
  document.getElementById('tracks-heading').textContent = album.name;
  document.getElementById('track-count').textContent =
    `${album.tracks.length} tracce`;

  const coverEl = document.getElementById('track-cover');
  if (album.coverUrl) {
    coverEl.innerHTML = `<img src="${album.coverUrl}" alt="cover" loading="lazy" />`;
  } else {
    coverEl.innerHTML = `<div class="placeholder-art">💿</div>`;
  }

  const list = document.getElementById('tracks-list');
  list.innerHTML = '';

  album.tracks.forEach((track, idx) => {
    const row = makeTrackRow(track, idx, () => {
      playAlbumFrom(album, idx);
    });
    list.appendChild(row);
  });

  showView('tracks');
}

function makeTrackRow(track, idx, onClick) {
  const row = document.createElement('div');
  row.className = 'track-row';
  row.dataset.idx = idx;

  const albumCover = state.currentAlbum?.coverUrl || '';
  const coverHtml = albumCover
    ? `<img src="${albumCover}" alt="" loading="lazy" />`
    : '';

  row.innerHTML = `
    <div class="track-num">
      <span class="track-num-val">${String(idx + 1).padStart(2, '0')}</span>
      <span class="track-play-icon">▶</span>
    </div>
    <div class="track-cover-sm">${coverHtml}</div>
    <div class="track-info">
      <div class="track-title">${escHtml(track.title)}</div>
      <div class="track-artist-sub">${escHtml(state.currentArtist?.artist || '')}</div>
    </div>
    <div class="track-duration" data-url="${escHtml(track.url)}">—</div>
  `;

  row.addEventListener('click', onClick);
  return row;
}

// ── QUEUE ────────────────────────────────────────────────────
function buildQueueFromAlbum(album) {
  return album.tracks.map(t => ({
    title: t.title,
    artist: state.currentArtist?.artist || '',
    album: album.name,
    url: t.url,
    coverUrl: album.coverUrl || null,
  }));
}

function playAlbumFrom(album, startIdx) {
  const q = buildQueueFromAlbum(album);
  state.queue = q;
  state.queueIndex = startIdx;
  loadAndPlay(startIdx);
  updateTrackHighlight();
}

function playAll() {
  if (state.currentAlbum) {
    playAlbumFrom(state.currentAlbum, 0);
  }
}

function renderQueue() {
  const list = document.getElementById('queue-list');
  list.innerHTML = '';

  if (state.queue.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎵</div>
        <p>Nessuna traccia in coda. Seleziona un album per ascoltare.</p>
      </div>`;
    return;
  }

  state.queue.forEach((track, idx) => {
    const savedArtist = state.currentArtist;
    const savedAlbum  = state.currentAlbum;

    const row = document.createElement('div');
    row.className = 'track-row' + (idx === state.queueIndex ? ' active' : '');
    row.dataset.idx = idx;

    const coverHtml = track.coverUrl
      ? `<img src="${track.coverUrl}" alt="" loading="lazy" />`
      : '';

    row.innerHTML = `
      <div class="track-num">
        <span class="track-num-val">${String(idx + 1).padStart(2, '0')}</span>
        <span class="track-play-icon">▶</span>
      </div>
      <div class="track-cover-sm">${coverHtml}</div>
      <div class="track-info">
        <div class="track-title">${escHtml(track.title)}</div>
        <div class="track-artist-sub">${escHtml(track.artist)}</div>
      </div>
      <div class="track-duration">—</div>
    `;

    row.addEventListener('click', () => {
      state.queueIndex = idx;
      loadAndPlay(idx);
      updateQueueHighlight();
    });

    list.appendChild(row);
  });
}

// ── PLAYER ───────────────────────────────────────────────────
function loadAndPlay(idx) {
  const track = state.queue[idx];
  if (!track) return;

  audio.src = track.url;
  audio.load();
  audio.play().catch(e => console.warn('Playback error:', e));
  state.playing = true;
  state.queueIndex = idx;

  updatePlayerUI(track);
  updatePlayBtn();
}

function updatePlayerUI(track) {
  document.getElementById('player-title').textContent  = track.title;
  document.getElementById('player-artist').textContent = `${track.artist} — ${track.album}`;

  const cover = document.getElementById('player-cover');
  cover.innerHTML = track.coverUrl
    ? `<img src="${track.coverUrl}" alt="cover" />`
    : '';

  // mini player
  document.getElementById('mini-title').textContent  = track.title;
  document.getElementById('mini-artist').textContent = track.artist;
  const miniCover = document.getElementById('mini-cover');
  miniCover.innerHTML = track.coverUrl ? `<img src="${track.coverUrl}" alt="" />` : '';
  document.getElementById('mini-player').classList.remove('hidden');

  // page title
  document.title = `${track.title} — MyTunes`;
}

function togglePlay() {
  if (!state.queue.length) return;
  if (audio.paused) {
    audio.play();
    state.playing = true;
  } else {
    audio.pause();
    state.playing = false;
  }
  updatePlayBtn();
}

function updatePlayBtn() {
  document.getElementById('btn-play').textContent = state.playing ? '⏸' : '▶';
}

function nextTrack() {
  if (!state.queue.length) return;
  let next;

  if (state.shuffle) {
    next = Math.floor(Math.random() * state.queue.length);
  } else {
    next = state.queueIndex + 1;
    if (next >= state.queue.length) {
      if (state.repeat === 'all') next = 0;
      else { audio.pause(); state.playing = false; updatePlayBtn(); return; }
    }
  }

  state.queueIndex = next;
  loadAndPlay(next);
  updateTrackHighlight();
  updateQueueHighlight();
}

function prevTrack() {
  if (!state.queue.length) return;

  // if past 3s → restart; else go back
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }

  let prev = state.queueIndex - 1;
  if (prev < 0) prev = state.repeat === 'all' ? state.queue.length - 1 : 0;

  state.queueIndex = prev;
  loadAndPlay(prev);
  updateTrackHighlight();
  updateQueueHighlight();
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  document.getElementById('btn-shuffle').classList.toggle('active', state.shuffle);
}

function toggleRepeat() {
  const modes = ['none', 'all', 'one'];
  const idx = modes.indexOf(state.repeat);
  state.repeat = modes[(idx + 1) % modes.length];
  const btn = document.getElementById('btn-repeat');
  btn.classList.toggle('active', state.repeat !== 'none');
  btn.title = { none: 'Ripeti: off', all: 'Ripeti tutto', one: 'Ripeti traccia' }[state.repeat];
  btn.textContent = state.repeat === 'one' ? '↻¹' : '↻';
}

function onEnded() {
  state.playing = false;
  if (state.repeat === 'one') {
    audio.play();
    state.playing = true;
    updatePlayBtn();
  } else {
    nextTrack();
  }
}

function onAudioError() {
  console.warn('Audio error:', audio.error);
}

// ── PROGRESS & SEEK ──────────────────────────────────────────
function onTimeUpdate() {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-thumb').style.left = pct + '%';
  document.getElementById('time-current').textContent = fmtTime(audio.currentTime);
}

function onMetadata() {
  document.getElementById('time-total').textContent = fmtTime(audio.duration);
  state.playing = true;
  updatePlayBtn();
}

function seekTo(e) {
  if (!audio.duration) return;
  const bar = document.getElementById('progress-bar');
  const rect = bar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  audio.currentTime = ratio * audio.duration;
}

function setVolume(v) {
  audio.volume = parseFloat(v);
}

// ── HIGHLIGHT HELPERS ─────────────────────────────────────────
function updateTrackHighlight() {
  const rows = document.querySelectorAll('#tracks-list .track-row');
  rows.forEach(r => r.classList.remove('active'));
  const current = state.queue[state.queueIndex];
  if (!current) return;

  rows.forEach((r, i) => {
    const albumTracks = state.currentAlbum?.tracks || [];
    if (albumTracks[i]?.url === current.url) {
      r.classList.add('active');
    }
  });
}

function updateQueueHighlight() {
  document.querySelectorAll('#queue-list .track-row').forEach((r, i) => {
    r.classList.toggle('active', i === state.queueIndex);
  });
}

// ── CARD FACTORY ──────────────────────────────────────────────
function makeCard(name, sub, imgUrl, emoji, onClick) {
  const card = document.createElement('div');
  card.className = 'card';

  let coverContent = `<span>${emoji}</span>`;
  if (imgUrl) {
    coverContent = `<img src="${imgUrl}" alt="${escHtml(name)}" loading="lazy" />`;
  }

  card.innerHTML = `
    <div class="card-cover">
      ${coverContent}
      <div class="play-hover">▶</div>
    </div>
    <div class="card-name">${escHtml(name)}</div>
    <div class="card-sub">${escHtml(sub)}</div>
  `;

  card.addEventListener('click', onClick);
  return card;
}

// ── SETTINGS ──────────────────────────────────────────────────
function openSettings() {
  app.classList.add('hidden');
  configModal.classList.remove('hidden');
  hideModalError();
}

// ── LOADING ───────────────────────────────────────────────────
function showLoading(msg) {
  loadingMsg.textContent = msg || 'Caricamento…';
  loadingOverlay.classList.remove('hidden');
}

function setLoadingMsg(msg) {
  loadingMsg.textContent = msg;
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// ── MODAL ERROR ───────────────────────────────────────────────
function showModalError(msg) {
  modalError.textContent = msg;
  modalError.classList.remove('hidden');
}

function hideModalError() {
  modalError.classList.add('hidden');
}

// ── UTILS ─────────────────────────────────────────────────────
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
