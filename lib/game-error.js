'use strict';

class GameError extends Error {
  constructor(message, status = 400, code = 'INVALID_ACTION') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireThat(condition, message, code) {
  if (!condition) throw new GameError(message, 400, code);
}

module.exports = { GameError, requireThat };
