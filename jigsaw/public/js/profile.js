// ── Profile Page ──
const content = document.getElementById('profile-content');

async function init() {
  const params = new URLSearchParams(window.location.search);
  let userId = params.get('user');

  if (!userId) {
    try {
      const authRes = await fetch('/auth/me');
      const authData = await authRes.json();
      if (authData.user) {
        userId = authData.user.id;
      } else {
        showMessage('profile-error', 'Please log in or specify a user ID to view a profile.');
        return;
      }
    } catch {
      showMessage('profile-error', 'Failed to check authentication.');
      return;
    }
  }

  try {
    const [statsRes, historyRes, authRes] = await Promise.all([
      fetch('/api/stats/' + userId),
      fetch('/api/stats/' + userId + '/history'),
      fetch('/auth/me')
    ]);

    if (!statsRes.ok) {
      showMessage('profile-error', 'Player not found.');
      return;
    }

    const { user, stats } = await statsRes.json();
    const history = await historyRes.json();
    const authData = await authRes.json();
    const isOwnProfile = authData.user && authData.user.id === user.id;

    document.title = user.username + ' - Jigsaw Puzzle';
    renderProfile(user, stats, history, isOwnProfile);
  } catch {
    showMessage('profile-error', 'Failed to load profile.');
  }
}

function showMessage(cls, text) {
  content.textContent = '';
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  content.appendChild(div);
}

function el(tag, className, textContent) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

function createStatItem(value, label) {
  const item = el('div', 'stat-item');
  item.appendChild(el('div', 'stat-number', String(value)));
  item.appendChild(el('div', 'stat-label', label));
  return item;
}

function createStatCard(cardClass, iconHtml, title, items) {
  const card = el('div', 'stat-card ' + cardClass);
  const h3 = el('h3');
  const icon = el('span', 'card-icon');
  icon.textContent = iconHtml;
  h3.appendChild(icon);
  h3.appendChild(document.createTextNode(' ' + title));
  card.appendChild(h3);

  const values = el('div', 'stat-values');
  items.forEach(function(item) {
    values.appendChild(createStatItem(item[0], item[1]));
  });
  card.appendChild(values);
  return card;
}

function renderProfile(user, stats, history, isOwnProfile) {
  content.textContent = '';

  const joinDate = new Date(user.created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const rankedAvg = stats.ranked_puzzles_completed > 0
    ? Math.round(stats.ranked_pieces_placed / stats.ranked_puzzles_completed)
    : 0;
  const unrankedAvg = stats.unranked_puzzles_completed > 0
    ? Math.round(stats.unranked_pieces_placed / stats.unranked_puzzles_completed)
    : 0;

  const totalHours = Math.floor(stats.total_time_played / 3600);
  const totalMinutes = Math.floor((stats.total_time_played % 3600) / 60);
  const timeStr = totalHours > 0
    ? totalHours + 'h ' + totalMinutes + 'm'
    : totalMinutes + 'm';

  // User info
  const userInfo = el('div', 'user-info');

  const avatar = el('div', 'user-avatar');
  if (user.avatar_url) {
    const img = document.createElement('img');
    img.src = user.avatar_url;
    img.alt = 'Avatar';
    avatar.appendChild(img);
  } else {
    avatar.textContent = user.username.charAt(0).toUpperCase();
  }
  userInfo.appendChild(avatar);

  const details = el('div', 'user-details');
  details.appendChild(el('h2', null, user.username));
  details.appendChild(el('div', 'join-date', 'Joined ' + joinDate));
  userInfo.appendChild(details);

  if (isOwnProfile) {
    const editLink = document.createElement('a');
    editLink.href = '#';
    editLink.className = 'edit-profile-link';
    editLink.textContent = 'Edit Profile';
    userInfo.appendChild(editLink);
  }

  content.appendChild(userInfo);

  // Stat cards row
  const statCards = el('div', 'stat-cards');
  statCards.appendChild(createStatCard('ranked', '\u2605', 'Ranked Stats', [
    [stats.ranked_pieces_placed, 'Pieces Placed'],
    [stats.ranked_puzzles_completed, 'Puzzles Done'],
    [rankedAvg, 'Avg Pieces/Puzzle']
  ]));
  statCards.appendChild(createStatCard('unranked', '\u2606', 'Unranked Stats', [
    [stats.unranked_pieces_placed, 'Pieces Placed'],
    [stats.unranked_puzzles_completed, 'Puzzles Done'],
    [unrankedAvg, 'Avg Pieces/Puzzle']
  ]));
  content.appendChild(statCards);

  // Total card
  const totalCards = el('div', 'stat-cards');
  totalCards.style.gridTemplateColumns = '1fr';
  totalCards.style.marginTop = '-0.75rem';
  totalCards.appendChild(createStatCard('total', '\u23F2', 'Total Time Played', [
    [timeStr, 'Play Time'],
    [stats.ranked_pieces_placed + stats.unranked_pieces_placed, 'Total Pieces'],
    [stats.ranked_puzzles_completed + stats.unranked_puzzles_completed, 'Total Puzzles']
  ]));
  content.appendChild(totalCards);

  // History section
  const histSection = el('div', 'history-section');
  histSection.appendChild(el('h3', null, 'Recent Puzzles'));

  const tableWrap = el('div', 'history-table-wrap');

  if (history.length === 0) {
    tableWrap.appendChild(el('div', 'history-empty', 'No puzzle history yet.'));
  } else {
    const table = el('table', 'history-table');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Image', 'Pieces', 'Score', 'Mode', 'Type', 'Date'].forEach(function(text) {
      headerRow.appendChild(el('th', null, text));
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    history.forEach(function(h) {
      const row = document.createElement('tr');
      const date = new Date(h.completed_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });

      row.appendChild(el('td', null, h.image_name || 'Unknown'));
      row.appendChild(el('td', null, String(h.piece_count)));
      row.appendChild(el('td', null, h.pieces_placed + ' / ' + h.piece_count));

      const modeCell = el('td');
      const modeBadge = el('span', 'badge ' + (h.mode === 'coop' ? 'badge-coop' : 'badge-race'),
        h.mode === 'coop' ? 'Co-op' : 'Race');
      modeCell.appendChild(modeBadge);
      row.appendChild(modeCell);

      const typeCell = el('td');
      const typeBadge = el('span', 'badge ' + (h.is_ranked ? 'badge-ranked' : 'badge-unranked'),
        h.is_ranked ? 'Ranked' : 'Unranked');
      typeCell.appendChild(typeBadge);
      row.appendChild(typeCell);

      row.appendChild(el('td', null, date));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  histSection.appendChild(tableWrap);
  content.appendChild(histSection);
}

init();
