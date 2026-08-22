/* JerryBot 2.0 — shared frontend scaffolding (plain script, no modules).
 * Attaches everything to window.JB. Loaded before each page's own <script>. */
(function () {
  'use strict';

  var ICON_MUSIC = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24"><path fill="currentColor" d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';
  var ICON_STATS = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>';
  var ICON_PESTEN = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24"><path fill="currentColor" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l4.59-4.58L18 11l-6 6z"/></svg>';
  var ICON_PICTIONARY = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>';
  var ICON_TRIVIA = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var ICON_F1 = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>';
  var ICON_BIRTHDAYS = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="14" rx="2"/><path d="M12 8V5"/><path d="M8 8V5"/><path d="M16 8V5"/><circle cx="12" cy="3.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="8" cy="3.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="3.5" r="1.5" fill="currentColor" stroke="none"/></svg>';
  var ICON_PLAYLISTS = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-3-7 3V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
  var ICON_TWITCH = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2H3v16h5v4l4-4h5l4-4V2z"/><path d="M10 6v6"/><path d="M14 6v6"/></svg>';
  var ICON_RECAP = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  var ICON_OSRS = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';
  var ICON_ADMIN = '<svg style="width:16px;height:16px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';

  // Superset of every page's dropdown nav (built from index.html's, which was the most complete).
  var NAV_LINKS = [
    { page: 'home', href: '/', label: 'Music Player', icon: ICON_MUSIC },
    { page: 'stats', href: '/stats', label: 'Listening Stats', icon: ICON_STATS },
    { page: 'pesten', href: '/pesten', label: 'Pesten Card Game', icon: ICON_PESTEN },
    { page: 'pictionary', href: '/pictionary', label: 'Pictionary Game', icon: ICON_PICTIONARY },
    { page: 'trivia', href: '/trivia', label: 'Trivia', icon: ICON_TRIVIA },
    { page: 'f1', href: '/f1', label: 'F1 Predictions', icon: ICON_F1 },
    { page: 'birthdays', href: '/birthdays', label: 'Birthdays', icon: ICON_BIRTHDAYS },
    { page: 'playlists', href: '/playlists', label: 'My Playlists', icon: ICON_PLAYLISTS },
    { page: 'twitch', href: '/twitch', label: 'Twitch Alerts', icon: ICON_TWITCH },
    { page: 'recap', href: '/recap', label: 'Weekly Recap', icon: ICON_RECAP },
    { page: 'osrs', href: '/osrs', label: 'Runescape Tracker', icon: ICON_OSRS },
    { page: 'admin', href: '/admin', label: 'Bot Settings', icon: ICON_ADMIN, admin: true },
    { page: 'logout', href: '/logout', label: 'Logout', logout: true }
  ];

  var navToggleBound = false;
  function bindNavToggle() {
    if (navToggleBound) return;
    navToggleBound = true;
    document.addEventListener('click', function (e) {
      var trigger = e.target.closest ? e.target.closest('.user-profile') : null;
      document.querySelectorAll('.user-profile.open').forEach(function (p) {
        if (p !== trigger) p.classList.remove('open');
      });
      if (trigger) trigger.classList.toggle('open');
    });
  }

  window.JB = {
    escapeHtml: function (str) {
      return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },

    // Fetches /api/me once and caches the promise; rejects on a non-OK response (e.g. 401).
    me: function () {
      var self = this;
      if (!this._me) {
        this._me = fetch('/api/me').then(function (r) {
          if (!r.ok) throw new Error('auth');
          return r.json();
        }).catch(function (err) {
          self._me = null;
          throw err;
        });
      }
      return this._me;
    },

    // Injects a small self-contained toast (no page CSS dependency), auto-removed after ~4s.
    toast: function (message, type) {
      type = type || 'info';
      var el = document.createElement('div');
      el.className = 'jb-toast';
      el.textContent = message;
      var bg = type === 'error' ? '#ff4444' : type === 'success' ? 'var(--accent, #1db954)' : '#333';
      el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
        'padding:10px 20px;border-radius:8px;font-size:13px;z-index:10000;color:#fff;' +
        'background:' + bg + ';box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;' +
        'max-width:90vw;text-align:center;';
      document.body.appendChild(el);
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 300);
      }, 3700);
      return el;
    },

    // Reconnecting WebSocket wrapper. onMessage receives already-parsed JSON objects.
    // Backoff starts at 2s, doubles up to a 30s cap, and resets to 2s on a successful open.
    connectSocket: function (opts) {
      opts = opts || {};
      var onMessage = opts.onMessage;
      var onOpen = opts.onOpen;
      var onClose = opts.onClose;
      var ws = null;
      var delay = 2000;
      var MAX_DELAY = 30000;
      var closedByUser = false;
      var reconnectTimer = null;

      function open() {
        var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(protocol + '//' + window.location.host);

        ws.addEventListener('open', function () {
          delay = 2000;
          if (typeof onOpen === 'function') onOpen(ws);
        });

        ws.addEventListener('message', function (event) {
          if (typeof onMessage !== 'function') return;
          var data;
          try {
            data = JSON.parse(event.data);
          } catch (err) {
            console.error('JB.connectSocket: failed to parse message', err);
            return;
          }
          onMessage(data);
        });

        ws.addEventListener('close', function () {
          if (typeof onClose === 'function') onClose();
          if (closedByUser) return;
          reconnectTimer = setTimeout(open, delay);
          delay = Math.min(delay * 2, MAX_DELAY);
        });

        ws.addEventListener('error', function (err) {
          console.error('JB.connectSocket: WebSocket error', err);
        });
      }

      open();

      return {
        send: function (obj) {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
        },
        close: function () {
          closedByUser = true;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          if (ws) ws.close();
        }
      };
    },

    // Renders the shared dropdown nav into #jb-nav, marks activePage, and shows the Admin
    // link only when /api/me reports the control-panel flag. Redirects to /login on 401.
    initNav: function (activePage) {
      var mount = document.getElementById('jb-nav');
      if (!mount) return;
      mount.classList.add('user-dropdown');
      mount.innerHTML = NAV_LINKS.map(function (item) {
        var classes = 'user-dropdown-item';
        if (item.page === activePage) classes += ' active';
        if (item.logout) classes += ' logout';
        var idAttr = item.admin ? ' id="adminLink" style="display:none"' : '';
        var icon = item.icon || '';
        return '<a href="' + item.href + '" class="' + classes + '"' + idAttr + '>' + icon + item.label + '</a>';
      }).join('');

      bindNavToggle();

      this.me().then(function (user) {
        if (user && user.hasControlPanel) {
          var al = document.getElementById('adminLink');
          if (al) al.style.display = '';
        }
      }).catch(function () {
        window.location.href = '/login';
      });
    }
  };
})();
