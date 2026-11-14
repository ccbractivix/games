'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { freshState } = require('./engine');

async function createStore(env = process.env) {
  if (env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      ssl: env.DATABASE_SSL === 'true' ? true : false,
      max: 3,
    });
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS games_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const { rows } = await pool.query('SELECT state FROM games_state WHERE id = 1');
      return {
        state: validate(rows[0]?.state || freshState()),
        save: state => pool.query(`INSERT INTO games_state(id, state) VALUES (1, $1)
          ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`, [JSON.stringify(state)]),
        close: () => pool.end(),
      };
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  if (env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required in production.');
  const file = path.resolve(env.DATA_FILE || '.data/game.json');
  let state;
  try {
    state = validate(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = freshState();
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return {
    state,
    async save(next) {
      const temp = `${file}.tmp`;
      await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(temp, file);
    },
    async close() {},
  };
}

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.players) || !Array.isArray(state.usedWords) ||
    ['awards', 'pictureImages', 'disabledPictureImages', 'usedPictureImages', 'pictureBlockedTerms',
      'screengrabberImages', 'screengrabberQuestions', 'usedScreengrabberQuestions',
      'lineupImages', 'lineupQuestions', 'usedLineupQuestions']
      .some(key => state[key] !== undefined && !Array.isArray(state[key])) ||
    (state.pictureJudgeCounts !== undefined && (!state.pictureJudgeCounts || typeof state.pictureJudgeCounts !== 'object' ||
      Array.isArray(state.pictureJudgeCounts)))) {
    throw new Error('Unsupported or invalid saved game state. Restore a compatible backup.');
  }
  return state;
}

module.exports = { createStore };
