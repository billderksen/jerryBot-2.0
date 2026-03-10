// ── State ──
let currentUser = null;
let images = [];
let selectedImageId = null;

// ── DOM refs ──
const authArea = document.getElementById('auth-area');
const roomGrid = document.getElementById('room-grid');
const emptyState = document.getElementById('empty-state');
const createRoomBtn = document.getElementById('create-room-btn');
const modalBackdrop = document.getElementById('modal-backdrop');
const createForm = document.getElementById('create-room-form');
const imagePicker = document.getElementById('image-picker');
const imageUpload = document.getElementById('image-upload');
const guestFields = document.getElementById('guest-fields');
const formError = document.getElementById('form-error');

// ── Init ──
async function init() {
  await checkAuth();
  renderAuthArea();
  await Promise.all([loadRooms(), loadImages()]);

  // Auto-refresh rooms every 5 seconds
  setInterval(loadRooms, 5000);
}

// ── Auth ──
async function checkAuth() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    currentUser = data.user || null;
  } catch {
    currentUser = null;
  }
}

function renderAuthArea() {
  // Clear existing content
  authArea.textContent = '';

  if (currentUser) {
    const span = document.createElement('span');
    span.className = 'username';
    span.textContent = 'Logged in as ';
    const strong = document.createElement('strong');
    strong.textContent = currentUser.username;
    span.appendChild(strong);

    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.textContent = 'Logout';
    btn.addEventListener('click', logout);

    authArea.appendChild(span);
    authArea.appendChild(btn);
  } else {
    const loginLink = document.createElement('a');
    loginLink.href = '/login.html';
    loginLink.className = 'btn btn-secondary';
    loginLink.textContent = 'Login';

    const regLink = document.createElement('a');
    regLink.href = '/register.html';
    regLink.className = 'btn btn-primary';
    regLink.textContent = 'Register';

    authArea.appendChild(loginLink);
    authArea.appendChild(regLink);
  }
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  currentUser = null;
  renderAuthArea();
}

// ── Rooms ──
async function loadRooms() {
  try {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
    renderRooms(rooms);
  } catch {
    // Silently retry on next interval
  }
}

function createRoomCard(room) {
  const progress = room.progress || 0;
  const modeLabel = room.mode === 'coop' ? 'Co-op' : 'Race';
  const pieceCount = room.piece_count || room.pieceCount || '?';
  const playerCount = room.player_count || room.playerCount || 0;
  const hostName = room.host_name || room.hostName || 'Unknown';

  const card = document.createElement('div');
  card.className = 'room-card';

  // Header
  const header = document.createElement('div');
  header.className = 'room-card-header';
  const headerInner = document.createElement('div');
  const nameEl = document.createElement('div');
  nameEl.className = 'room-name';
  nameEl.textContent = room.name;
  const hostEl = document.createElement('div');
  hostEl.className = 'room-host';
  hostEl.textContent = 'Hosted by ' + hostName;
  headerInner.appendChild(nameEl);
  headerInner.appendChild(hostEl);
  header.appendChild(headerInner);
  card.appendChild(header);

  // Badges
  const badges = document.createElement('div');
  badges.className = 'room-badges';

  const pieceBadge = document.createElement('span');
  pieceBadge.className = 'badge badge-pieces';
  pieceBadge.textContent = pieceCount + ' pieces';
  badges.appendChild(pieceBadge);

  const modeBadge = document.createElement('span');
  modeBadge.className = 'badge ' + (room.mode === 'coop' ? 'badge-coop' : 'badge-race');
  modeBadge.textContent = modeLabel;
  badges.appendChild(modeBadge);

  const rankedBadge = document.createElement('span');
  rankedBadge.className = 'badge ' + (room.ranked ? 'badge-ranked' : 'badge-unranked');
  rankedBadge.textContent = room.ranked ? 'Ranked' : 'Unranked';
  badges.appendChild(rankedBadge);

  card.appendChild(badges);

  // Info row (players + progress)
  const info = document.createElement('div');
  info.className = 'room-info';

  const players = document.createElement('span');
  players.className = 'room-players';
  const playerSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  playerSvg.setAttribute('width', '14');
  playerSvg.setAttribute('height', '14');
  playerSvg.setAttribute('viewBox', '0 0 24 24');
  playerSvg.setAttribute('fill', 'currentColor');
  playerSvg.style.verticalAlign = '-2px';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z');
  playerSvg.appendChild(path);
  players.appendChild(playerSvg);
  const playerText = document.createTextNode(' ' + playerCount + ' player' + (playerCount !== 1 ? 's' : ''));
  players.appendChild(playerText);
  info.appendChild(players);

  const progressWrap = document.createElement('div');
  progressWrap.className = 'progress-wrap';
  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'progress-fill';
  progressFill.style.width = progress + '%';
  progressBar.appendChild(progressFill);
  progressWrap.appendChild(progressBar);
  const progressText = document.createElement('span');
  progressText.className = 'progress-text';
  progressText.textContent = progress + '%';
  progressWrap.appendChild(progressText);
  info.appendChild(progressWrap);

  card.appendChild(info);

  // Footer with join button
  const footer = document.createElement('div');
  footer.className = 'room-card-footer';
  const joinBtn = document.createElement('button');
  joinBtn.className = 'btn btn-success';
  joinBtn.textContent = 'Join';
  joinBtn.addEventListener('click', () => joinRoom(room.id));
  footer.appendChild(joinBtn);
  card.appendChild(footer);

  return card;
}

function renderRooms(rooms) {
  if (!rooms || rooms.length === 0) {
    roomGrid.textContent = '';
    emptyState.style.display = 'block';
    return;
  }

  emptyState.style.display = 'none';
  roomGrid.textContent = '';
  rooms.forEach(room => {
    roomGrid.appendChild(createRoomCard(room));
  });
}

// ── Join Room ──
function joinRoom(roomId) {
  if (currentUser) {
    window.location.href = '/game.html?room=' + roomId;
  } else {
    const name = sessionStorage.getItem('guestName');
    if (name) {
      window.location.href = '/game.html?room=' + roomId + '&guest=' + encodeURIComponent(name);
    } else {
      promptGuestName(roomId);
    }
  }
}

function promptGuestName(roomId) {
  const name = prompt('Enter a guest name to join:');
  if (name && name.trim()) {
    sessionStorage.setItem('guestName', name.trim());
    window.location.href = '/game.html?room=' + roomId + '&guest=' + encodeURIComponent(name.trim());
  }
}

// ── Images ──
async function loadImages() {
  try {
    const res = await fetch('/api/images');
    images = await res.json();
    renderImagePicker();
  } catch {
    images = [];
  }
}

function renderImagePicker() {
  imagePicker.textContent = '';

  if (images.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--text-secondary);font-size:0.85rem;padding:1rem';
    p.textContent = 'No images available. Upload one below.';
    imagePicker.appendChild(p);
    return;
  }

  images.forEach(img => {
    const src = img.is_builtin ? '/puzzle-images/' + img.filename : '/uploads/' + img.filename;

    const div = document.createElement('div');
    div.className = 'image-option' + (img.id === selectedImageId ? ' selected' : '');
    div.title = img.display_name || img.filename;
    div.addEventListener('click', () => selectImage(img.id));

    const imgEl = document.createElement('img');
    imgEl.src = src;
    imgEl.alt = img.display_name || img.filename;
    imgEl.loading = 'lazy';
    div.appendChild(imgEl);

    const label = document.createElement('span');
    label.className = 'image-label';
    label.textContent = img.display_name || img.filename;
    div.appendChild(label);

    imagePicker.appendChild(div);
  });
}

function selectImage(id) {
  selectedImageId = id;
  renderImagePicker();
}

// ── Upload ──
imageUpload.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('image', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      showFormError(err.error || 'Upload failed');
      return;
    }
    const data = await res.json();
    await loadImages();
    selectedImageId = data.imageId;
    renderImagePicker();
  } catch {
    showFormError('Upload failed');
  }

  imageUpload.value = '';
});

// ── Create Room Modal ──
createRoomBtn.addEventListener('click', () => {
  if (currentUser) {
    guestFields.style.display = 'none';
  } else {
    guestFields.style.display = 'block';
    const saved = sessionStorage.getItem('guestName');
    if (saved) document.getElementById('guest-name').value = saved;
  }
  hideFormError();
  modalBackdrop.classList.add('open');
});

function closeModal() {
  modalBackdrop.classList.remove('open');
}

modalBackdrop.addEventListener('click', (e) => {
  if (e.target === modalBackdrop) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ── Submit Create Room ──
createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideFormError();

  const name = document.getElementById('room-name').value.trim();
  const pieceCount = parseInt(document.getElementById('piece-count').value);
  const mode = document.getElementById('room-mode').value;

  if (!name) { showFormError('Room name is required'); return; }
  if (!selectedImageId) { showFormError('Please select an image'); return; }

  const body = { name, pieceCount, mode, imageId: selectedImageId };

  if (!currentUser) {
    const guestName = document.getElementById('guest-name').value.trim();
    if (!guestName) { showFormError('Guest name is required'); return; }
    body.guestName = guestName;
    sessionStorage.setItem('guestName', guestName);
  }

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      showFormError(err.error || 'Failed to create room');
      return;
    }

    const data = await res.json();
    const guestParam = !currentUser && body.guestName ? '&guest=' + encodeURIComponent(body.guestName) : '';
    window.location.href = '/game.html?room=' + data.roomId + guestParam;
  } catch {
    showFormError('Failed to create room');
  }
});

// ── Helpers ──
function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.add('visible');
}

function hideFormError() {
  formError.classList.remove('visible');
}

// ── Start ──
init();
