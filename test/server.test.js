'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createApplication } = require('../server');
const { freshState } = require('../lib/engine');
const { createStore } = require('../lib/store');

const ENV = { HOST_PASSWORD: 'test-only-host-password', SESSION_SECRET: 'test-only-session-secret-at-least-32-characters' };

async function service(t, options = {}) {
  const snapshots = [];
  const store = {
    state: freshState(),
    async save(state) { snapshots.push(structuredClone(state)); },
    async close() {},
  };
  const application = await createApplication({ env: ENV, store, ...options });
  application.server.listen(0, '127.0.0.1');
  await once(application.server, 'listening');
  t.after(() => application.close());
  const base = `http://127.0.0.1:${application.server.address().port}`;
  const post = async (url, body, cookie = '', origin = base) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  return { ...application, base, post, snapshots };
}

test('host protection, same-origin enforcement, joins, privacy and QR endpoint', async t => {
  const { base, post } = await service(t);
  assert.equal((await post('/api/host/login', { password: 'wrong' })).status, 401);
  const login = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /^games_host=/);
  assert.equal((await post('/api/command', { action: 'new-event', data: { mode: 'standalone' } })).status, 400);
  assert.equal((await post('/api/command', { action: 'new-event', data: { mode: 'standalone' } }, login.cookie, 'https://other.example')).status, 403);
  assert.equal((await post('/api/command', { action: 'new-event', data: { mode: 'variety' } }, login.cookie)).status, 200);
  const join = await post('/api/join', { room: '1105 A', canDraw: false });
  assert.equal(join.status, 200);
  assert.equal(join.body.me.room, '1105 A');
  assert.equal((await post('/api/join', { room: '1104', canDraw: true }, join.cookie)).body.me.id, join.body.me.id);
  const publicState = await (await fetch(`${base}/api/state?display=1`, { headers: { Cookie: login.cookie } })).json();
  assert.equal(publicState.role, 'display');
  assert.equal(publicState.me, null);
  assert.ok(!Object.hasOwn(publicState.players[0], 'room'));
  const qr = await fetch(`${base}/api/qr`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
  assert.match(await qr.text(), /<svg/);
});

test('WebSocket public view stays sanitized even with a host cookie and rejects foreign origins', async t => {
  const { base, post } = await service(t);
  const { cookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  await post('/api/command', { action: 'new-event', data: { mode: 'standalone' } }, cookie);
  await post('/api/command', { action: 'start-game' }, cookie);
  await post('/api/command', { action: 'start-round' }, cookie);
  const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?display=1`, { origin: base, headers: { Cookie: cookie } });
  const [raw] = await once(socket, 'message');
  const message = JSON.parse(raw);
  assert.equal(message.state.role, 'display');
  assert.equal(message.state.round.answer, null);
  assert.equal(message.state.round.slots[0].part, null);
  socket.close();
  await once(socket, 'close');
  const foreign = new WebSocket(`${base.replace('http', 'ws')}/ws`, { origin: 'https://other.example' });
  const [error] = await once(foreign, 'error');
  assert.match(error.message, /403/);
});

test('failed persistence rolls back changes and returns an explicit error', async t => {
  let fail = false;
  const store = {
    state: freshState(),
    async save() { if (fail) throw new Error('Simulated database outage'); },
    async close() {},
  };
  const { base, post } = await service(t, { store });
  const { cookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  fail = true;
  const result = await post('/api/command', { action: 'new-event', data: { mode: 'standalone' } }, cookie);
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'SERVICE_ERROR');
  assert.equal((await (await fetch(`${base}/api/state`)).json()).event, null);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await fetch(`${base}/health`)).status, 503);
});

test('local store survives restart and refuses malformed snapshots', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resort-games-test-'));
  const file = path.join(directory, 'state.json');
  t.after(async () => {
    await fs.unlink(file);
    await fs.rmdir(directory);
  });
  const store = await createStore({ DATA_FILE: file });
  const state = freshState();
  state.event = { id: 'saved-event', title: 'Saved', mode: 'variety', status: 'lobby' };
  await store.save(state);
  await store.close();
  const restored = await createStore({ DATA_FILE: file });
  assert.deepEqual(restored.state, state);
  await restored.close();
  await fs.writeFile(file, '{"version":999}');
  await assert.rejects(createStore({ DATA_FILE: file }), /Unsupported/);
});

test('production refuses missing persistence and startup refuses missing credentials', async () => {
  await assert.rejects(createStore({ NODE_ENV: 'production' }), /DATABASE_URL/);
  await assert.rejects(createApplication({ env: {} }), /HOST_PASSWORD/);
  await assert.rejects(createApplication({ env: { HOST_PASSWORD: ENV.HOST_PASSWORD } }), /SESSION_SECRET/);
});

test('60 connected phones complete a round with private previews and exactly 17 persisted points', { timeout: 15000 }, async t => {
  const { engine, transact, post, base, snapshots } = await service(t, {
    random: () => 0, timing: { selection: 10, drawing: 10000, guessing: 10000 },
  });
  const { cookie: hostCookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  const host = (action, data = {}) => post('/api/command', { action, data }, hostCookie);
  await host('new-event', { mode: 'variety' });
  const phones = [];
  for (let index = 0; index < 60; index++) {
    const joined = await post('/api/join', { room: '1104', canDraw: index < 2 });
    assert.equal(joined.status, 200);
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, { origin: base, headers: { Cookie: joined.cookie } });
    const firstMessage = once(socket, 'message');
    socket.updates = 0;
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'state') { socket.lastState = message.state; socket.updates++; }
    });
    await firstMessage;
    phones.push({ socket, cookie: joined.cookie, id: joined.body.me.id });
  }
  assert.equal(engine.online().size, 60);
  await host('start-game');
  await host('start-round');
  assert.equal((await host('select-players')).status, 200);
  await transact(() => engine.tick(Math.max(...engine.state.round.slots.map(slot => slot.deadline))));
  const stroke = { points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }], width: 0.008, color: '#111111' };
  for (const [index, phone] of phones.slice(0, 2).entries()) {
    const ack = new Promise(resolve => {
      const listener = raw => {
        const message = JSON.parse(raw);
        if (message.type === 'ack' && message.requestId === 'stroke') {
          phone.socket.off('message', listener);
          resolve(message);
        }
      };
      phone.socket.on('message', listener);
    });
    phone.socket.send(JSON.stringify({ type: 'command', requestId: 'stroke', action: 'stroke', data: { stroke } }));
    assert.equal((await ack).ok, true);
    assert.equal((await post('/api/command', { action: 'finish' }, phone.cookie)).status, 200);
    assert.equal((await host('approve', { slot: index })).status, 200);
  }
  const beforeShow = await (await fetch(`${base}/api/state`, { headers: { Cookie: phones[2].cookie } })).json();
  assert.equal(beforeShow.round.slots[0].drawing.length, 0);
  assert.equal(beforeShow.round.answer, null);
  assert.equal((await host('show')).status, 200);
  await Promise.all(phones.map(({ socket }) => socket.lastState?.round?.stage === 'guessing' ? Promise.resolve() :
    new Promise(resolve => {
      const listener = raw => {
        const message = JSON.parse(raw);
        if (message.type === 'state' && message.state.round?.stage === 'guessing') {
          socket.off('message', listener);
          resolve();
        }
      };
      socket.on('message', listener);
    })));
  const baseline = phones.map(phone => phone.socket.updates);
  const guesses = await Promise.all(phones.slice(2).map(phone => post('/api/command',
    { action: 'guess', data: { answer: 'sunflower' } }, phone.cookie)));
  assert.ok(guesses.every(result => result.status === 200));
  // A private guess must not rebroadcast both frozen canvases to the whole audience.
  assert.equal(phones[0].socket.updates, baseline[0]);
  assert.equal(phones[1].socket.updates, baseline[1]);
  assert.ok(phones.slice(2).every((phone, index) => phone.socket.updates <= baseline[index + 2] + 1));
  await transact(() => engine.tick(engine.state.round.deadline));
  assert.equal((await host('reveal')).status, 200);
  assert.equal(engine.state.players.reduce((sum, player) => sum + player.eventScore, 0), 17);
  assert.equal(snapshots.at(-1).players.reduce((sum, player) => sum + player.eventScore, 0), 17);
  assert.deepEqual(engine.view().leaderboards.round.map(entry => entry.score), [5, 4, 3, 2, 1]);
  await host('round-results');
  await host('end-game', { allowTie: true });
  await host('start-game');
  assert.equal(engine.state.players.length, 60);
  assert.equal(engine.state.players.reduce((sum, player) => sum + player.eventScore, 0), 17);
  assert.equal(engine.state.players.reduce((sum, player) => sum + player.gameScore, 0), 0);
  for (const phone of phones) phone.socket.terminate();
});
