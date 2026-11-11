'use strict';

require('dotenv').config();
const http = require('node:http');
const path = require('node:path');
const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');
const { Engine, GameError } = require('./lib/engine');
const { createStore } = require('./lib/store');

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookies(request) {
  const result = {};
  for (const item of (request.headers.cookie || '').split(';')) {
    const separator = item.indexOf('=');
    if (separator > 0) result[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return result;
}

async function createApplication({ env = process.env, store: suppliedStore, timing, random } = {}) {
  if (!env.HOST_PASSWORD || env.HOST_PASSWORD.length < 12) throw new Error('HOST_PASSWORD must be at least 12 characters.');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  if (env.DATABASE_SSL && !['true', 'false'].includes(env.DATABASE_SSL)) throw new Error('DATABASE_SSL must be true or false.');
  const production = env.NODE_ENV === 'production';
  let canonical = null;
  if (env.PUBLIC_BASE_URL) {
    canonical = new URL(env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(canonical.protocol) || canonical.username || canonical.password ||
      canonical.pathname !== '/' || canonical.search || canonical.hash || (production && canonical.protocol !== 'https:')) {
      throw new Error('PUBLIC_BASE_URL must be an origin URL, using HTTPS in production.');
    }
  }
  const store = suppliedStore || await createStore(env);
  const app = express();
  app.set('trust proxy', 1);
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const sockets = new Map();
  const online = () => new Set([...sockets.values()].filter(identity => identity.playerId).map(identity => identity.playerId));
  const engine = new Engine({ state: store.state, online, timing, random });
  let queue = Promise.resolve();
  let healthy = true;
  let stopping = false;
  const rates = new Map();

  function originOf(request) {
    return canonical?.origin || `${production ? 'https' : request.protocol || 'http'}://${request.headers.host}`;
  }

  function sameOrigin(request) {
    return request.headers.origin === originOf(request);
  }

  function sign(value) {
    return createHmac('sha256', env.SESSION_SECRET).update(value).digest('hex');
  }

  function identity(request) {
    if (new URL(request.url, 'http://localhost').searchParams.get('display') === '1') {
      return { role: 'display', playerId: null };
    }
    const jar = cookies(request);
    if (jar.games_host) {
      const [expires, nonce, signature] = jar.games_host.split('.');
      if (/^\d+$/.test(expires || '') && nonce && signature &&
        Number(expires) > Date.now() && equal(signature, sign(`${expires}.${nonce}`))) {
        return { role: 'host', playerId: null, expires: Number(expires) };
      }
    }
    const player = engine.state.players.find(item => item.token === jar.games_player);
    return player ? { role: 'player', playerId: player.id } : { role: 'display', playerId: null };
  }

  function freshIdentity(current) {
    if (current.role === 'host' && current.expires > Date.now()) return current;
    if (current.role === 'player' && engine.player(current.playerId)) return current;
    return { role: 'display', playerId: null };
  }

  function broadcast(scope = null) {
    for (const [socket, current] of sockets) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const auth = freshIdentity(current);
      if (scope && auth.playerId !== scope.playerId && !(scope.hosts && auth.role === 'host')) continue;
      if (socket.bufferedAmount > 1_000_000) {
        socket.close(1013, 'Connection cannot keep up; reconnect.');
        continue;
      }
      socket.send(JSON.stringify({ type: 'state', state: engine.view(auth.role, auth.playerId) }));
    }
  }

  function transact(operation) {
    const pending = queue.then(async () => {
      if (stopping) throw new GameError('Server is restarting. Please reconnect.', 503, 'RESTARTING');
      const before = structuredClone(engine.state);
      try {
        const result = operation();
        if (result !== false) {
          await store.save(engine.state);
          healthy = true;
          broadcast(result && typeof result === 'object' ? result : null);
        }
        return result;
      } catch (error) {
        engine.state = before;
        if (!(error instanceof GameError)) {
          healthy = false;
          console.error('Game persistence or processing failed:', error);
        }
        throw error;
      }
    });
    queue = pending.catch(() => {});
    return pending;
  }

  function rate(key, limit, window = 60000) {
    const now = Date.now();
    let entry = rates.get(key);
    if (!entry || entry.until <= now) {
      entry = { count: 0, until: now + window };
      rates.set(key, entry);
    }
    if (++entry.count > limit) throw new GameError('Too many requests. Please wait and retry.', 429, 'RATE_LIMITED');
  }

  function setCookie(response, name, value, age) {
    response.cookie(name, value, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: age, path: '/' });
  }

  function processCommand(auth, action, data, received) {
    const timerChanged = engine.tick(received);
    engine.command(auth.role, auth.playerId, action, data, received);
    if (!timerChanged && auth.role === 'player') {
      if (action === 'guess') return { playerId: auth.playerId, hosts: false };
      if (['stroke', 'undo', 'clear'].includes(action)) return { playerId: auth.playerId, hosts: true };
    }
  }

  app.use((request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (production) response.set('Strict-Transport-Security', 'max-age=31536000');
    if (request.path.startsWith('/api/')) response.set('Cache-Control', 'no-store');
    if (request.method === 'POST' && !sameOrigin(request)) {
      return response.status(403).json({ error: 'Requests must come from this game site.', code: 'ORIGIN_REQUIRED' });
    }
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  const route = handler => (request, response, next) => Promise.resolve(handler(request, response)).catch(next);

  app.get('/health', (_request, response) => response.status(healthy && !stopping ? 200 : 503).json({ status: healthy && !stopping ? 'ok' : 'unavailable' }));
  app.get('/api/state', route(async (request, response) => {
    await queue;
    const auth = identity(request);
    response.json(engine.view(auth.role, auth.playerId));
  }));
  app.get('/api/qr', route(async (request, response) => {
    const svg = await QRCode.toString(`${originOf(request)}/`, { type: 'svg', margin: 2, width: 240 });
    response.type('image/svg+xml').send(svg);
  }));
  app.post('/api/host/login', route(async (request, response) => {
    rate(`login:${request.ip}`, 10);
    if (typeof request.body?.password !== 'string' || !equal(request.body.password, env.HOST_PASSWORD)) {
      throw new GameError('Incorrect host password.', 401, 'UNAUTHORIZED');
    }
    const expires = Date.now() + 12 * 60 * 60 * 1000;
    const nonce = randomBytes(16).toString('hex');
    setCookie(response, 'games_host', `${expires}.${nonce}.${sign(`${expires}.${nonce}`)}`, 12 * 60 * 60 * 1000);
    response.json(engine.view('host'));
  }));
  app.post('/api/host/logout', (request, response) => {
    response.clearCookie('games_host', { path: '/', secure: production, sameSite: 'strict', httpOnly: true });
    const jar = cookies(request);
    const expires = jar.games_host?.split('.')[0];
    for (const [socket, auth] of sockets) {
      if (auth.role === 'host' && String(auth.expires) === expires) socket.close(1008, 'Host signed out.');
    }
    response.json(engine.view());
  });
  app.post('/api/join', route(async (request, response) => {
    rate(`join:${request.ip}`, 120);
    const auth = identity(request);
    let player;
    await transact(() => { player = engine.join(request.body, auth.playerId); });
    setCookie(response, 'games_player', player.token, 7 * 24 * 60 * 60 * 1000);
    response.json(engine.view('player', player.id));
  }));
  app.post('/api/command', route(async (request, response) => {
    const received = Date.now();
    const auth = identity(request);
    rate(`command:${auth.playerId || request.ip}`, auth.role === 'host' ? 240 : 180);
    await transact(() => processCommand(auth, request.body?.action, request.body?.data, received));
    response.json(engine.view(auth.role, auth.playerId));
  }));

  app.use('/shared', express.static(path.join(__dirname, 'shared')));
  app.get('/host', (_request, response) => response.sendFile(path.join(__dirname, 'public/host.html')));
  app.get('/display', (_request, response) => response.sendFile(path.join(__dirname, 'public/display.html')));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((error, _request, response, _next) => {
    if (error instanceof GameError) return response.status(error.status).json({ error: error.message, code: error.code });
    if (error.type === 'entity.too.large' || error instanceof SyntaxError) {
      return response.status(400).json({ error: 'Invalid or oversized request.', code: 'INVALID_REQUEST' });
    }
    console.error('Request failed:', error);
    response.status(503).json({ error: 'Unable to save or process the game. Please retry; the host should check server logs.', code: 'SERVICE_ERROR' });
  });

  server.on('upgrade', (request, socket, head) => {
    if (new URL(request.url, 'http://localhost').pathname !== '/ws' || !sameOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      rate(`socket:${request.socket.remoteAddress}`, 240);
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    } catch (error) {
      console.warn('WebSocket connection rejected:', error.message);
      socket.destroy();
    }
  });
  wss.on('connection', (socket, request) => {
    sockets.set(socket, identity(request));
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    queue.then(() => broadcast());
    socket.on('message', async raw => {
      let message;
      try {
        message = JSON.parse(raw);
        if (!message || message.type !== 'command' || typeof message.requestId !== 'string' || message.requestId.length > 80) {
          throw new GameError('Invalid real-time command.');
        }
        const received = Date.now();
        const auth = freshIdentity(sockets.get(socket));
        rate(`ws:${auth.playerId || request.socket.remoteAddress}`, 360);
        await transact(() => processCommand(auth, message.action, message.data, received));
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', requestId: message.requestId, ok: true }));
      } catch (error) {
        if (!(error instanceof GameError) && !(error instanceof SyntaxError)) console.error('Real-time command failed:', error);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
          type: 'ack', requestId: typeof message?.requestId === 'string' ? message.requestId : null,
          ok: false, error: error instanceof GameError ? error.message : 'Unable to process the drawing. Retry or contact the host.',
          code: error instanceof GameError ? error.code : 'SERVICE_ERROR',
        }));
      }
    });
    socket.on('close', () => { sockets.delete(socket); queue.then(() => broadcast()); });
    socket.on('error', error => console.warn('WebSocket error:', error.message));
  });

  await transact(() => engine.tick(Date.now()));
  const ticker = setInterval(() => {
    transact(() => engine.tick(Date.now())).catch(error => console.error('Timer update failed:', error.message));
  }, 250);
  const heartbeat = setInterval(() => {
    for (const socket of sockets.keys()) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false;
      socket.ping();
    }
    for (const [key, entry] of rates) if (entry.until <= Date.now()) rates.delete(key);
  }, 15000);
  ticker.unref();
  heartbeat.unref();

  async function close() {
    clearInterval(ticker);
    clearInterval(heartbeat);
    await queue;
    stopping = true;
    for (const socket of sockets.keys()) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await store.close();
  }
  return { app, server, engine, close, transact };
}

if (require.main === module) {
  createApplication().then(application => {
    application.server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log('Games service listening on port', process.env.PORT || 3000));
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => application.close().then(() => process.exit(0)).catch(error => {
        console.error('Shutdown failed:', error);
        process.exit(1);
      }));
    }
  }).catch(error => {
    console.error('Games startup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { createApplication };
