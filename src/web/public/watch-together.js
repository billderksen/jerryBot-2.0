/**
 * Watch Together -- YouTube video player synced to server playback
 * Self-contained IIFE module. Injects own CSS and exposes window.WatchTogether.
 *
 * Replaces album art with an embedded YouTube player that stays in sync
 * with the server's playback position. Video starts muted; users can
 * unmute via YouTube's built-in controls.
 *
 * Includes theater mode for a larger viewing experience.
 *
 * All DOM mutations use textContent (never innerHTML) to prevent XSS.
 */
(function () {
  'use strict';

  var STYLE_ID = 'watch-together-styles';
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      /* -- Normal mode: expand container to fill column with 16:9 ratio -- */
      '.album-art-container.wt-active {',
      '  max-width: 100% !important;',
      '  aspect-ratio: 16 / 9;',
      '  border-radius: 12px;',
      '  overflow: hidden;',
      '}',
      '.album-art-container.wt-active .album-art,',
      '.album-art-container.wt-active .placeholder { display: none !important; }',
      '',
      /* -- Player wrapper -- */
      '.wt-player-wrap {',
      '  position: absolute; inset: 0; z-index: 2;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: #000; border-radius: inherit;',
      '}',
      '.wt-player-wrap iframe {',
      '  width: 100%; height: 100%; border-radius: inherit;',
      '}',
      '',
      /* -- Theater mode overlay -- */
      '.wt-theater-backdrop {',
      '  position: fixed; inset: 0; z-index: 9998;',
      '  background: rgba(0,0,0,0.85);',
      '  display: flex; align-items: center; justify-content: center;',
      '  animation: wtFadeIn 0.2s ease-out;',
      '}',
      '@keyframes wtFadeIn { from { opacity: 0; } to { opacity: 1; } }',
      '.wt-theater-player {',
      '  width: 90vw; max-width: 1280px; aspect-ratio: 16 / 9;',
      '  position: relative; border-radius: 12px; overflow: hidden;',
      '  box-shadow: 0 0 80px rgba(0,0,0,0.6);',
      '}',
      '.wt-theater-player iframe { width: 100%; height: 100%; }',
      '.wt-theater-close {',
      '  position: absolute; top: -40px; right: 0;',
      '  background: none; border: none; color: #aaa;',
      '  font-size: 14px; cursor: pointer; padding: 8px 12px;',
      '  transition: color 0.15s;',
      '}',
      '.wt-theater-close:hover { color: #fff; }',
      '',
      /* -- Loading / error -- */
      '.wt-loading {',
      '  position: absolute; inset: 0; z-index: 3;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: rgba(0,0,0,0.8); border-radius: inherit;',
      '}',
      '.wt-spinner {',
      '  width: 36px; height: 36px;',
      '  border: 3px solid rgba(255,255,255,0.15);',
      '  border-top-color: var(--accent, #1db954);',
      '  border-radius: 50%;',
      '  animation: wtSpin 0.8s linear infinite;',
      '}',
      '@keyframes wtSpin { to { transform: rotate(360deg); } }',
      '.wt-error {',
      '  position: absolute; inset: 0; z-index: 3;',
      '  display: flex; align-items: center; justify-content: center;',
      '  background: rgba(0,0,0,0.8); border-radius: inherit;',
      '  color: var(--text-muted, #727272);',
      '  font-size: 13px; text-align: center; padding: 20px;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // --- State ---
  var containerId = null;
  var player = null;         // YouTube player instance
  var playerReady = false;
  var active = false;
  var theaterMode = false;
  var currentVideoId = null;
  var apiLoaded = false;
  var apiLoading = false;
  var pendingVideoId = null;
  var lastSyncPosition = null;
  var lastSyncPlaying = null;
  var lastSyncPaused = null;

  var DRIFT_TOLERANCE = 1; // seconds

  var LS_KEY = 'watchTogetherEnabled';

  // --- YouTube IFrame API loader ---
  function loadYouTubeAPI(cb) {
    if (apiLoaded) { cb(null); return; }
    if (apiLoading) {
      var check = setInterval(function () {
        if (apiLoaded) { clearInterval(check); cb(null); }
      }, 100);
      return;
    }
    apiLoading = true;

    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      apiLoaded = true;
      apiLoading = false;
      if (prev) prev();
      cb(null);
    };

    var script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = function () {
      apiLoading = false;
      cb(new Error('Failed to load YouTube API'));
    };
    document.head.appendChild(script);
  }

  // --- DOM helpers ---
  function getContainer() {
    return containerId ? document.getElementById(containerId) : null;
  }

  function showLoading() {
    var c = getContainer();
    if (!c) return;
    removeByClass(c, 'wt-loading');
    removeByClass(c, 'wt-error');
    var wrap = document.createElement('div');
    wrap.className = 'wt-loading';
    var spinner = document.createElement('div');
    spinner.className = 'wt-spinner';
    wrap.appendChild(spinner);
    c.appendChild(wrap);
  }

  function hideLoading() {
    var c = getContainer();
    if (c) removeByClass(c, 'wt-loading');
  }

  function showError(msg) {
    var c = getContainer();
    if (!c) return;
    removeByClass(c, 'wt-loading');
    removeByClass(c, 'wt-error');
    var wrap = document.createElement('div');
    wrap.className = 'wt-error';
    wrap.textContent = msg;
    c.appendChild(wrap);
  }

  function removeByClass(parent, cls) {
    var els = parent.querySelectorAll('.' + cls);
    for (var i = 0; i < els.length; i++) els[i].remove();
  }

  function updateTheaterButton() {
    var btn = document.getElementById('theaterBtn');
    if (btn) btn.style.display = active ? '' : 'none';
  }

  // --- Theater mode ---
  function enterTheater() {
    if (theaterMode || !player || !playerReady) return;
    theaterMode = true;

    // Get current position before moving player
    var currentTime = player.getCurrentTime();
    var wasPaused = player.getPlayerState() === YT.PlayerState.PAUSED;

    // Destroy inline player
    try { player.destroy(); } catch (e) {}
    player = null;
    playerReady = false;
    var c = getContainer();
    if (c) removeByClass(c, 'wt-player-wrap');

    // Create theater overlay
    var backdrop = document.createElement('div');
    backdrop.className = 'wt-theater-backdrop';
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) exitTheater();
    });

    var wrap = document.createElement('div');
    wrap.className = 'wt-theater-player';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'wt-theater-close';
    closeBtn.textContent = 'ESC  \u2715  Close';
    closeBtn.addEventListener('click', exitTheater);
    wrap.appendChild(closeBtn);

    var playerDiv = document.createElement('div');
    playerDiv.id = 'wt-yt-player';
    wrap.appendChild(playerDiv);
    backdrop.appendChild(wrap);
    document.body.appendChild(backdrop);

    player = new YT.Player('wt-yt-player', {
      videoId: currentVideoId,
      playerVars: {
        autoplay: 1,
        mute: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        disablekb: 1,
        fs: 0,
        start: Math.floor(currentTime)
      },
      events: {
        onReady: function () {
          playerReady = true;
          player.seekTo(currentTime, true);
          if (wasPaused || lastSyncPaused || lastSyncPlaying === false) {
            player.pauseVideo();
          }
        },
        onError: function () {
          exitTheater();
        }
      }
    });

    // ESC key handler
    backdrop._escHandler = function (e) {
      if (e.key === 'Escape') exitTheater();
    };
    document.addEventListener('keydown', backdrop._escHandler);
  }

  function exitTheater() {
    if (!theaterMode) return;
    theaterMode = false;

    var currentTime = 0;
    var wasPaused = false;
    if (player && playerReady) {
      currentTime = player.getCurrentTime();
      wasPaused = player.getPlayerState() === YT.PlayerState.PAUSED;
    }

    // Destroy theater player
    if (player) {
      try { player.destroy(); } catch (e) {}
      player = null;
      playerReady = false;
    }

    // Remove backdrop
    var backdrop = document.querySelector('.wt-theater-backdrop');
    if (backdrop) {
      if (backdrop._escHandler) document.removeEventListener('keydown', backdrop._escHandler);
      backdrop.remove();
    }

    // Recreate inline player
    if (active && currentVideoId) {
      createPlayer(currentVideoId, currentTime, wasPaused);
    }
  }

  // --- Player management ---
  function createPlayer(videoId, startAt, startPaused) {
    var c = getContainer();
    if (!c) return;

    destroyPlayer();
    currentVideoId = videoId;
    playerReady = false;

    showLoading();
    c.classList.add('wt-active');

    // Player wrapper
    var wrap = document.createElement('div');
    wrap.className = 'wt-player-wrap';
    var playerDiv = document.createElement('div');
    playerDiv.id = 'wt-yt-player';
    wrap.appendChild(playerDiv);
    c.appendChild(wrap);

    var seekTo = (startAt != null && startAt > 0) ? startAt : lastSyncPosition;

    player = new YT.Player('wt-yt-player', {
      videoId: videoId,
      playerVars: {
        autoplay: 1,
        mute: 1,
        controls: 1,
        modestbranding: 1,
        rel: 0,
        disablekb: 1,
        fs: 0
      },
      events: {
        onReady: function () {
          playerReady = true;
          hideLoading();
          if (seekTo != null && seekTo > 0) {
            player.seekTo(seekTo, true);
          }
          if (startPaused || lastSyncPaused || lastSyncPlaying === false) {
            player.pauseVideo();
          }
        },
        onError: function () {
          hideLoading();
          showError('Could not load YouTube video');
        }
      }
    });

    updateTheaterButton();
  }

  function destroyPlayer() {
    playerReady = false;
    if (player) {
      try { player.destroy(); } catch (e) {}
      player = null;
    }
    var c = getContainer();
    if (c) {
      removeByClass(c, 'wt-player-wrap');
      removeByClass(c, 'wt-loading');
      removeByClass(c, 'wt-error');
      c.classList.remove('wt-active');
    }
    currentVideoId = null;
  }

  // --- Public API ---
  function init(id) {
    containerId = id;
    var saved = localStorage.getItem(LS_KEY);
    if (saved === 'true') {
      active = true;
    }
  }

  function loadVideo(videoId) {
    if (!videoId) {
      if (active) {
        if (theaterMode) exitTheater();
        destroyPlayer();
      }
      pendingVideoId = null;
      currentVideoId = null;
      updateTheaterButton();
      return;
    }

    if (active) {
      if (videoId === currentVideoId && player && playerReady) return;
      pendingVideoId = null;
      if (theaterMode) exitTheater();
      loadYouTubeAPI(function (err) {
        if (err) {
          showError('Could not load YouTube player');
          return;
        }
        createPlayer(videoId);
      });
    } else {
      pendingVideoId = videoId;
    }
  }

  function syncState(position, isPlaying, isPaused) {
    lastSyncPosition = position;
    lastSyncPlaying = isPlaying;
    lastSyncPaused = isPaused;

    if (!active || !player || !playerReady) return;

    // Pause/play mirroring
    if (!isPlaying || isPaused) {
      var ytState = player.getPlayerState();
      if (ytState === YT.PlayerState.PLAYING) {
        player.pauseVideo();
      }
      return;
    }

    // Resume if paused
    var ytState2 = player.getPlayerState();
    if (ytState2 === YT.PlayerState.PAUSED || ytState2 === YT.PlayerState.CUED) {
      player.playVideo();
    }

    // Position sync
    if (position != null) {
      var iframePos = player.getCurrentTime();
      if (Math.abs(iframePos - position) > DRIFT_TOLERANCE) {
        player.seekTo(position, true);
      }
    }
  }

  function destroy() {
    if (theaterMode) exitTheater();
    destroyPlayer();
    active = false;
    localStorage.setItem(LS_KEY, 'false');
    pendingVideoId = null;
    lastSyncPosition = null;
    lastSyncPlaying = null;
    lastSyncPaused = null;
    updateTheaterButton();
  }

  function isActive() {
    return active;
  }

  function toggle() {
    if (active) {
      pendingVideoId = currentVideoId || pendingVideoId;
      if (theaterMode) exitTheater();
      destroyPlayer();
      active = false;
      localStorage.setItem(LS_KEY, 'false');
      updateTheaterButton();
    } else {
      active = true;
      localStorage.setItem(LS_KEY, 'true');
      var vid = pendingVideoId || currentVideoId;
      if (vid) {
        loadVideo(vid);
      }
      updateTheaterButton();
    }
  }

  function toggleTheater() {
    if (theaterMode) {
      exitTheater();
    } else {
      enterTheater();
    }
  }

  window.WatchTogether = {
    init: init,
    loadVideo: loadVideo,
    syncState: syncState,
    destroy: destroy,
    isActive: isActive,
    toggle: toggle,
    toggleTheater: toggleTheater
  };
})();
