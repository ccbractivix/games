'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { createApplication } = require('../server');
const { Engine, freshState } = require('../lib/engine');
const { createStore } = require('../lib/store');
const sharp = require('sharp');
const { createImageStorage, prepareImage } = require('../lib/image-storage');

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

test('60 connected phones accept exactly five card answers, vote anonymously and persist ranked event points', { timeout: 20000 }, async t => {
  const { engine, transact, post, base, snapshots } = await service(t, {
    timing: { submissions: 60000, voting: 60000 },
  });
  const { cookie: hostCookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  const host = (action, data = {}) => post('/api/command', { action, data }, hostCookie);
  await host('new-event', { mode: 'variety' });
  const phones = [];
  for (let index = 0; index < 60; index++) {
    const joined = await post('/api/join', { room: '1104', canDraw: false });
    assert.equal(joined.status, 200);
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, {
      origin: base, headers: { Cookie: joined.cookie },
    });
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'state') socket.lastState = message.state;
    });
    await once(socket, 'message');
    phones.push({ socket, cookie: joined.cookie, id: joined.body.me.id });
  }
  assert.equal(engine.online().size, 60);
  assert.equal((await host('start-game', { type: 'family-cards' })).status, 200);
  assert.equal((await host('start-round')).status, 200);
  const responses = await Promise.all(phones.map(phone => post('/api/command', {
    action: 'submit-card',
    data: { cardId: engine.view('player', phone.id).me.hand[0].id },
  }, phone.cookie)));
  assert.equal(responses.filter(response => response.status === 200).length, 5);
  assert.equal(responses.filter(response => response.status === 400).length, 55);
  assert.equal(engine.state.round.submissions.length, 5);
  assert.equal(engine.state.round.stage, 'voting');
  const publicSocket = new WebSocket(`${base.replace('http', 'ws')}/ws?display=1`, {
    origin: base, headers: { Cookie: hostCookie },
  });
  const [raw] = await once(publicSocket, 'message');
  const publicState = JSON.parse(raw).state;
  assert.equal(publicState.me, null);
  assert.equal(publicState.round.finalists.length, 5);
  assert.ok(publicState.round.finalists.every(answer => Object.keys(answer).sort().join() === 'id,text'));
  assert.ok(!Object.hasOwn(publicState, 'cards'));
  const finalists = engine.state.round.submissions;
  const finalistIds = new Set(finalists.map(answer => answer.playerId));
  const audience = phones.filter(phone => !finalistIds.has(phone.id));
  const ballots = [];
  let nextVoter = 0;
  [19, 14, 9, 7, 6].forEach((count, answer) => {
    for (let index = 0; index < count; index++) {
      ballots.push({ phone: audience[nextVoter++], submissionId: finalists[answer].id });
    }
  });
  finalists.forEach((answer, index) => {
    ballots.push({
      phone: phones.find(phone => phone.id === answer.playerId),
      submissionId: finalists[(index + 1) % 5].id,
    });
  });
  const voted = await Promise.all(ballots.map(ballot => post('/api/command', {
    action: 'vote-card', data: { submissionId: ballot.submissionId },
  }, ballot.phone.cookie)));
  assert.ok(voted.every(response => response.status === 200));
  assert.equal(engine.state.round.votes.length, 60);
  assert.equal(engine.state.awards.length, 0);
  assert.equal((await post('/api/command', {
    action: 'vote-card', data: { submissionId: ballots[0].submissionId },
  }, ballots[0].phone.cookie)).status, 400);
  await transact(() => engine.tick(engine.state.round.deadline));
  assert.deepEqual(engine.view().round.finalists.map(answer => answer.votes), [20, 15, 10, 8, 7]);
  assert.deepEqual(engine.view().leaderboards.round.map(answer => answer.score), [5, 4, 3, 2, 1]);
  const saved = snapshots.at(-1);
  assert.equal(saved.awards.length, 5);
  assert.equal(saved.awards.reduce((total, award) => total + award.points, 0), 15);
  assert.ok(saved.awards.every(award => award.reason === 'audience-vote'));
  assert.equal((await host('end-game', { allowTie: true })).status, 200);
  assert.equal((await host('start-game', { type: 'pictionary' })).status, 200);
  assert.equal(engine.state.players.reduce((total, player) => total + player.eventScore, 0), 15);
  assert.ok(engine.state.players.every(player => player.gameScore === 0));
  assert.equal((await post('/api/join', { room: '1104', canDraw: false }, phones[0].cookie)).body.me.id, phones[0].id);
  publicSocket.close();
  await once(publicSocket, 'close');
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

test('a saved card ballot survives service restart and expired voting is scored only once', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'resort-cards-test-'));
  const file = path.join(directory, 'state.json');
  t.after(async () => {
    await fs.unlink(file);
    await fs.rmdir(directory);
  });
  const engine = new Engine();
  engine.command('host', null, 'new-event', { mode: 'variety' });
  const players = Array.from({ length: 2 }, () => engine.join({ room: '1104', canDraw: false }));
  engine.online = () => new Set(players.map(player => player.id));
  engine.command('host', null, 'start-game', { type: 'family-cards' });
  engine.command('host', null, 'start-round', {}, 1000);
  engine.command('player', players[0].id, 'submit-card', {
    cardId: engine.view('player', players[0].id).me.hand[0].id,
  }, 1001);
  engine.command('host', null, 'close-submissions', {}, 1002);
  engine.command('player', players[1].id, 'vote-card', {
    submissionId: engine.state.round.submissions[0].id,
  }, 1003);
  const hand = engine.view('player', players[1].id).me.hand;
  const store = await createStore({ DATA_FILE: file });
  await store.save(engine.state);
  await store.close();
  for (let restart = 0; restart < 2; restart++) {
    const recovered = await createApplication({ env: ENV, store: await createStore({ DATA_FILE: file }) });
    assert.equal(recovered.engine.state.round.stage, 'revealed');
    assert.equal(recovered.engine.state.awards.length, 1);
    assert.equal(recovered.engine.player(players[0].id).eventScore, 5);
    assert.equal(recovered.engine.player(players[1].id).token, players[1].token);
    assert.deepEqual(recovered.engine.view('player', players[1].id).me.hand, hand);
    await recovered.close();
  }
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

test('100 connected caption players complete poolside nominations and anonymous voting with persisted scores', { timeout: 30000 }, async t => {
  const { engine, transact, post, base, snapshots } = await service(t, {
    random: () => 0, timing: { submissions: 60000, judging: 60000, voting: 60000 },
  });
  const { cookie: hostCookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  const host = (action, data = {}) => post('/api/command', { action, data }, hostCookie);
  assert.equal((await host('new-event', { mode: 'variety' })).status, 200);
  const phones = [];
  for (let index = 0; index < 100; index++) {
    const joined = await post('/api/join', { room: '1104', canDraw: false });
    assert.equal(joined.status, 200);
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, {
      origin: base, headers: { Cookie: joined.cookie },
    });
    await once(socket, 'message');
    phones.push({ socket, cookie: joined.cookie, id: joined.body.me.id });
  }
  assert.equal(engine.online().size, 100);
  assert.equal((await host('start-game', { type: 'get-the-picture', pictureMode: 'poolside' })).status, 200);
  assert.equal((await host('start-round')).status, 200);
  const imageURL = engine.view().round.image.url;
  assert.match((await fetch(`${base}${imageURL}`)).headers.get('content-type'), /svg/);
  assert.equal((await host('start-caption-timer')).status, 200);
  const rejected = await post('/api/command', {
    action: 'submit-caption', data: { text: 'Florida is stupid' },
  }, phones[0].cookie);
  assert.equal(rejected.body.code, 'CAPTION_REJECTED');
  assert.equal(engine.state.round.submissions.length, 0);
  const submitted = await Promise.all(phones.map(phone => post('/api/command', {
    action: 'submit-caption', data: { text: 'The duck requested another snack break.' },
  }, phone.cookie)));
  assert.ok(submitted.every(response => response.status === 200));
  assert.equal(engine.state.round.submissions.length, 100);
  const before = await (await fetch(`${base}/api/state?display=1`, { headers: { Cookie: hostCookie } })).json();
  assert.deepEqual(before.round.finalists, []);
  assert.equal(before.round.review, undefined);
  assert.ok(!JSON.stringify(before).includes('requested another snack break'));
  await transact(() => engine.tick(engine.state.round.deadline));
  assert.equal(engine.state.round.stage, 'judging');
  for (const group of engine.state.round.groups) {
    const judge = phones.find(phone => phone.id === group.judgeId);
    const state = await (await fetch(`${base}/api/state`, { headers: { Cookie: judge.cookie } })).json();
    assert.equal(state.me.judgeChoices.length, 9);
    assert.ok(!state.me.judgeChoices.some(entry => entry.id === state.me.ownSubmissionId));
    const nominee = state.me.judgeChoices[0];
    assert.equal((await post('/api/command', {
      action: 'nominate-caption', data: { submissionId: nominee.id },
    }, judge.cookie)).status, 200);
  }
  assert.equal(engine.state.round.stage, 'voting');
  assert.equal(engine.view().round.finalists.length, 10);
  assert.ok(engine.view().round.finalists.every(entry => Object.keys(entry).sort().join() === 'id,text'));
  const [first, second] = engine.state.round.finalistIds.map(id => engine.state.round.submissions.find(entry => entry.id === id));
  const votes = await Promise.all(phones.map(phone => post('/api/command', {
    action: 'vote-caption', data: { submissionId: phone.id === first.playerId ? second.id : first.id },
  }, phone.cookie)));
  assert.ok(votes.every(response => response.status === 200));
  assert.equal(engine.state.round.votes.length, 100);
  await transact(() => engine.tick(engine.state.round.deadline));
  assert.deepEqual(engine.state.round.results.slice(0, 2).map(entry => [entry.votes, entry.points]), [[99, 5], [1, 4]]);
  assert.equal(snapshots.at(-1).awards.length, 2);
  assert.equal(snapshots.at(-1).players.reduce((sum, player) => sum + player.eventScore, 0), 9);
  assert.equal((await host('end-game', { allowTie: true })).status, 200);
  assert.equal((await host('start-game', { type: 'family-cards' })).status, 200);
  assert.equal(engine.state.players.reduce((sum, player) => sum + player.eventScore, 0), 9);
  assert.ok(engine.state.players.every(player => player.gameScore === 0));
  phones.forEach(phone => phone.socket.terminate());
});

test('host image uploads re-encode safely, stay private until selected and preserve metadata across events', async t => {
  const uploaded = [];
  const imageStorage = {
    configured: true, imageOrigin: 'https://storage.example.test',
    async upload(body) { uploaded.push(body); return 'get-the-picture/test.webp'; },
    async url() { return 'https://storage.example.test/test.webp?temporary=signature'; },
    async remove() {}, close() {},
  };
  const { engine, base, post } = await service(t, { imageStorage });
  const { cookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  const host = (action, data = {}) => post('/api/command', { action, data }, cookie);
  const buffer = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#ffcc66' } })
    .jpeg().toBuffer();
  const upload = (body, auth = cookie, type = 'image/jpeg', permission = 'true') =>
    fetch(`${base}/api/picture-images?${new URLSearchParams({
      title: 'Test photo', alt: 'A golden rectangle', credit: 'Operator-owned test', permission,
    })}`, { method: 'POST', headers: { Cookie: auth, Origin: base, 'Content-Type': type }, body });
  assert.equal((await upload(buffer, '')).status, 401);
  assert.equal((await upload(buffer, cookie, 'image/jpeg', 'false')).status, 400);
  assert.equal((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), cookie, 'image/png')).status, 400);
  assert.equal((await upload(Buffer.from('not an image'))).status, 400);
  assert.equal((await upload(Buffer.alloc(5 * 1024 * 1024 + 1))).status, 400);
  const result = await upload(buffer);
  assert.equal(result.status, 200);
  const state = await result.json();
  assert.equal(state.pictureUploadsEnabled, true);
  assert.equal(uploaded.length, 1);
  const metadata = await sharp(uploaded[0]).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);
  assert.equal(metadata.exif, undefined);
  const image = engine.state.pictureImages[0];
  assert.equal(image.credit, 'Operator-owned test');
  assert.equal(state.pictureImages.at(-1).key, undefined);
  const file = `/api/picture-images/${image.id}/file`;
  assert.equal((await fetch(`${base}${file}`, { redirect: 'manual' })).status, 404);
  const preview = await fetch(`${base}${file}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(preview.status, 307);
  assert.match(preview.headers.get('location'), /^https:\/\/storage\.example\.test\//);
  assert.match(preview.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/storage.example.test/);
  await host('new-event', { mode: 'standalone' });
  assert.equal(engine.state.pictureImages.length, 1);
  const players = [engine.join({ room: '1104', canDraw: false }), engine.join({ room: '1104', canDraw: false })];
  engine.online = () => new Set(players.map(player => player.id));
  await host('start-game', { type: 'get-the-picture', pictureMode: 'large' });
  await host('start-round', { imageId: image.id });
  assert.equal((await fetch(`${base}${file}`, { redirect: 'manual' })).status, 307);
  await host('set-picture-image', { imageId: image.id, enabled: false });
  // Disabling future selection cannot break an image already in a live round.
  assert.equal((await fetch(`${base}${file}`, { redirect: 'manual' })).status, 307);
});

test('R2 configuration is explicit, private viewing URLs are signed, and failed saves clean up uploads', async t => {
  assert.equal(createImageStorage({}).configured, false);
  assert.throws(() => createImageStorage({ R2_BUCKET_NAME: 'games' }), /requires all/);
  const config = {
    R2_ACCOUNT_ID: 'a'.repeat(32), R2_BUCKET_NAME: 'games-images',
    R2_ACCESS_KEY_ID: 'test-access-key', R2_SECRET_ACCESS_KEY: 'test-only-storage-secret',
  };
  const storage = createImageStorage(config);
  t.after(() => storage.close());
  const url = new URL(await storage.url('get-the-picture/example.webp'));
  assert.equal(url.origin, `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  assert.ok(url.searchParams.get('X-Amz-Signature'));
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(!url.href.includes(config.R2_SECRET_ACCESS_KEY));
  await assert.rejects(prepareImage(Buffer.from('broken image')), /could not be decoded/);
  const removed = [];
  const imageStorage = {
    configured: true, imageOrigin: null,
    async upload() { return 'get-the-picture/orphan.webp'; },
    async remove(key) { removed.push(key); }, close() {},
  };
  const store = {
    state: freshState(),
    async save() { throw new Error('Simulated image metadata outage'); },
    async close() {},
  };
  const { base, post, engine } = await service(t, { imageStorage, store });
  const { cookie } = await post('/api/host/login', { password: ENV.HOST_PASSWORD });
  const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const response = await fetch(`${base}/api/picture-images?title=Photo&alt=Square&credit=Operator&permission=true`, {
    method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'image/png' }, body: buffer,
  });
  assert.equal(response.status, 503);
  assert.deepEqual(removed, ['get-the-picture/orphan.webp']);
  assert.equal(engine.state.pictureImages.length, 0);
  const unavailable = await service(t);
  const login = await unavailable.post('/api/host/login', { password: ENV.HOST_PASSWORD });
  assert.equal(login.body.pictureUploadsEnabled, false);
  assert.equal((await unavailable.post('/api/picture-images', {}, login.cookie)).body.code, 'IMAGE_STORAGE_UNAVAILABLE');
});
