/**
 * WebSocket client wrapper with event-emitter pattern.
 * Handles connection, reconnection, and message routing.
 */

export class GameNetwork {
  constructor(roomId) {
    this.roomId = roomId;
    this.handlers = {};
    this.ws = null;
    this.moveThrottle = 0;
    this._destroyed = false;
    this.connect();
  }

  connect() {
    if (this._destroyed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${location.host}/?roomId=${this.roomId}`);

    this.ws.onopen = () => this.emit('connected');

    this.ws.onclose = () => {
      this.emit('disconnected');
      if (!this._destroyed) {
        setTimeout(() => this.connect(), 2000);
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after this, triggering reconnect
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.emit(msg.type, msg);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };
  }

  on(type, handler) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(handler);
  }

  off(type, handler) {
    if (!this.handlers[type]) return;
    this.handlers[type] = this.handlers[type].filter(h => h !== handler);
  }

  emit(type, data) {
    (this.handlers[type] || []).forEach(h => h(data));
  }

  send(type, data = {}) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  /**
   * Throttled move send — max ~16 messages/sec to avoid flooding.
   */
  sendMove(pieceIndex, x, y) {
    const now = Date.now();
    if (now - this.moveThrottle >= 60) {
      this.send('move', { pieceIndex, x, y });
      this.moveThrottle = now;
    }
  }

  destroy() {
    this._destroyed = true;
    this.ws?.close();
    this.handlers = {};
  }
}
