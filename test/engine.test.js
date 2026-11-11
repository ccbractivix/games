'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, GameError } = require('../lib/engine');
const WORDS = require('../lib/words');
const CARDS = require('../lib/family-cards.json');

const STROKE = { points: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }], color: '#111111', width: 0.008 };

function fixture(count = 8, mode = 'standalone') {
  const online = new Set();
  const engine = new Engine({ random: () => 0, online: () => online, timing: { selection: 10, drawing: 30, guessing: 30 } });
  const host = (action, data = {}, now = 1000) => engine.command('host', null, action, data, now);
  host('new-event', { mode });
  const players = Array.from({ length: count }, () => {
    const player = engine.join({ room: '1104', canDraw: true });
    online.add(player.id);
    return player;
  });
  host('start-game');
  host('start-round');
  const playerCommand = (index, action, data = {}, now = 1011) => engine.command('player', players[index].id, action, data, now);
  function select() {
    host('select-players');
    engine.tick(1010);
  }
  function approve() {
    select();
    for (const index of [0, 1]) {
      playerCommand(index, 'stroke', { stroke: STROKE });
      playerCommand(index, 'finish');
      host('approve', { slot: index }, 1012);
    }
    host('show', {}, 1020);
  }
  return { engine, players, online, host, playerCommand, select, approve };
}

function cardFixture(count = 8, mode = 'standalone') {
  const online = new Set();
  const engine = new Engine({ random: () => 0, online: () => online, timing: { submissions: 30, voting: 30 } });
  const host = (action, data = {}, now = 1000) => engine.command('host', null, action, data, now);
  host('new-event', { mode });
  const players = Array.from({ length: count }, () => {
    const player = engine.join({ room: '1104', canDraw: false });
    online.add(player.id);
    return player;
  });
  host('start-game', { type: 'family-cards' });
  host('start-round');
  const command = (index, action, data, now = 1001) =>
    engine.command('player', players[index].id, action, data, now);
  const submit = (index, now = 1001) => command(index, 'submit-card', {
    cardId: engine.view('player', players[index].id).me.hand[0].id,
  }, now);
  return { engine, online, players, host, command, submit };
}

test('60 card players have ten private cards each, with no drawing requirement or leaked hands', () => {
  const { engine, players, online, host } = cardFixture(60);
  for (const player of players) {
    const view = engine.view('player', player.id);
    assert.equal(view.me.hand.length, 10);
    assert.equal(new Set(view.me.hand.map(card => card.id)).size, 10);
    assert.ok(view.me.hand.every(card => card.text === CARDS.answers[card.id]));
    assert.equal(view.players.some(other => Object.hasOwn(other, 'hand')), false);
  }
  for (const role of ['host', 'display']) {
    const view = engine.view(role);
    assert.equal(view.me, null);
    assert.ok(!Object.hasOwn(view, 'cards'));
    assert.ok(!JSON.stringify(view).includes('"hands"'));
  }
  assert.equal(engine.state.round.deadline, 1030);
  host('cancel-round');
  online.clear();
  online.add(players[0].id);
  assert.throws(() => host('start-round'), error => error.code === 'NEED_PLAYERS');
});

test('only the first five distinct valid card submissions become anonymous shuffled finalists', () => {
  const { engine, players, command, submit } = cardFixture(60);
  assert.throws(() => command(0, 'submit-card', { cardId: 504 }), /from your hand/);
  const original = engine.view('player', players[0].id).me.hand[0].id;
  submit(0);
  assert.throws(() => submit(0), /already submitted/);
  assert.equal(engine.view().round.finalists.length, 0);
  assert.ok(!engine.view('player', players[0].id).me.hand.some(card => card.id === original));
  for (let index = 1; index < 5; index++) submit(index, 1001 + index);
  assert.equal(engine.state.round.stage, 'voting');
  assert.equal(engine.state.round.deadline, 1035);
  assert.throws(() => submit(5), /stage/);
  const publicState = engine.view();
  assert.equal(publicState.round.finalists.length, 5);
  assert.deepEqual(new Set(engine.state.round.submissions.map(item => item.playerId)),
    new Set(players.slice(0, 5).map(player => player.id)));
  assert.notEqual(engine.state.round.submissions[0].playerId, players[0].id);
  for (const finalist of publicState.round.finalists) {
    assert.deepEqual(Object.keys(finalist).sort(), ['id', 'text']);
  }
  assert.equal(publicState.leaderboards.round.length, 0);
  assert.equal(engine.state.awards.length, 0);
  const late = engine.join({ room: '1104', canDraw: false });
  assert.equal(engine.view('player', late.id).me.hand.length, 10);
});

test('every registered guest can cast one vote, but never for their own answer', () => {
  const { engine, players, command, submit, host } = cardFixture();
  submit(0);
  submit(1);
  host('close-submissions', {}, 1002);
  const own = engine.state.round.submissions.find(item => item.playerId === players[0].id);
  const other = engine.state.round.submissions.find(item => item.playerId === players[1].id);
  assert.throws(() => command(0, 'vote-card', { submissionId: own.id }, 1003), /own answer/);
  assert.throws(() => command(2, 'vote-card', { submissionId: 'invalid' }, 1003), /finalist/);
  command(0, 'vote-card', { submissionId: other.id }, 1003);
  assert.throws(() => command(0, 'vote-card', { submissionId: own.id }, 1004), /already recorded/);
  command(2, 'vote-card', { submissionId: own.id }, 1004);
  const late = engine.join({ room: '1104', canDraw: false });
  engine.command('player', late.id, 'vote-card', { submissionId: own.id }, 1005);
  assert.equal(engine.view('player', players[0].id).me.votedFor, other.id);
  assert.equal(engine.view().round.voteCount, 3);
  assert.ok(engine.view().round.finalists.every(item => !Object.hasOwn(item, 'votes')));
  assert.throws(() => command(3, 'vote-card', { submissionId: own.id }, 1032), /closed/);
});

test('ranked votes award 5/4/3/2/1 with competition ties, zero-vote exclusion and one-time scoring', () => {
  const { engine, players, command, submit, host } = cardFixture(12);
  for (let index = 0; index < 5; index++) submit(index);
  const finalists = players.slice(0, 5).map(player =>
    engine.state.round.submissions.find(item => item.playerId === player.id).id);
  // Vote counts 3/3/1/0/0 produce ranks 1/1/3/4/4 and points 5/5/3/0/0.
  [0, 0, 0, 1, 1, 1, 2].forEach((answer, index) =>
    command(index + 5, 'vote-card', { submissionId: finalists[answer] }, 1002));
  assert.equal(engine.state.awards.length, 0);
  engine.tick(1031);
  assert.equal(engine.state.round.stage, 'revealed');
  assert.deepEqual(players.slice(0, 5).map(player => player.gameScore), [5, 5, 3, 0, 0]);
  assert.deepEqual(engine.view().leaderboards.round.map(item => item.rank), [1, 1, 3]);
  assert.ok(engine.view().round.finalists.every(item => Object.hasOwn(item, 'name')));
  assert.equal(engine.state.awards.length, 3);
  assert.equal(engine.tick(2000), false);
  assert.throws(() => host('close-voting'), /stage/);
  assert.equal(engine.state.awards.length, 3);
  host('round-results');
  host('start-round', {}, 2001);
  assert.equal(players[0].eventScore, 5);
  assert.equal(engine.state.round.number, 2);
});

test('card deadlines handle fewer finalists, empty rounds, early close, cancellation and late joins', () => {
  const { engine, online, host, submit, command } = cardFixture();
  const late = engine.join({ room: '1104', canDraw: false });
  online.add(late.id);
  assert.throws(() => engine.command('player', late.id, 'submit-card', { cardId: 0 }, 1001), /next round/);
  assert.throws(() => command(0, 'submit-card', { cardId: 0 }, 1030), /closed/);
  submit(0);
  engine.tick(1030);
  assert.equal(engine.state.round.stage, 'voting');
  assert.equal(engine.view().round.finalists.length, 1);
  host('close-voting', {}, 1031);
  assert.equal(engine.state.awards.length, 0);
  assert.equal(engine.state.round.results[0].points, 0);
  host('start-round', {}, 2000);
  assert.equal(engine.view('player', late.id).me.canSubmit, true);
  engine.tick(2030);
  assert.equal(engine.state.round.stage, 'cancelled');
  assert.equal(engine.state.awards.length, 0);
  host('start-round', {}, 3000);
  submit(1, 3001);
  host('close-submissions', {}, 3002);
  host('cancel-round', {}, 3003);
  assert.equal(engine.tick(9000), false);
  assert.equal(engine.state.awards.length, 0);
});

test('card recovery preserves hands and ballots, processes expired deadlines, and does not score twice', () => {
  const { engine, players, submit, command } = cardFixture();
  submit(0);
  engine.tick(1030);
  command(1, 'vote-card', { submissionId: engine.state.round.submissions[0].id }, 1031);
  const recovered = new Engine({ state: structuredClone(engine.state) });
  assert.deepEqual(recovered.view('player', players[1].id).me.hand, engine.view('player', players[1].id).me.hand);
  recovered.tick(2000);
  assert.equal(recovered.player(players[0].id).eventScore, 5);
  const twice = new Engine({ state: structuredClone(recovered.state) });
  assert.equal(twice.tick(3000), false);
  assert.equal(twice.state.awards.length, 1);
  const expiredSubmissions = cardFixture();
  expiredSubmissions.submit(0);
  const restore = new Engine({ state: structuredClone(expiredSubmissions.engine.state) });
  restore.tick(2000);
  assert.equal(restore.state.round.stage, 'voting');
  assert.equal(restore.state.round.deadline, 32000);
});

test('default card submission and voting periods each last exactly thirty seconds', () => {
  const { engine, players, online, host } = cardFixture();
  host('cancel-round');
  const production = new Engine({ state: structuredClone(engine.state), online: () => online });
  production.command('host', null, 'start-round', {}, 2000);
  assert.equal(production.state.round.deadline, 32000);
  const id = players[0].id;
  production.command('player', id, 'submit-card', { cardId: production.view('player', id).me.hand[0].id }, 2001);
  assert.equal(production.tick(31999), false);
  assert.equal(production.tick(32000), true);
  assert.equal(production.state.round.stage, 'voting');
  assert.equal(production.state.round.deadline, 62000);
  production.command('player', players[1].id, 'vote-card', {
    submissionId: production.state.round.submissions[0].id,
  }, 32001);
  assert.equal(production.tick(61999), false);
  assert.equal(production.tick(62000), true);
  assert.equal(production.state.round.stage, 'revealed');
  assert.equal(production.player(id).eventScore, 5);
});

test('Variety Show switches between Big Draw and cards without losing names, identity or event points', () => {
  const { engine, players, host, submit, command } = cardFixture(8, 'variety');
  submit(0);
  host('close-submissions', {}, 1002);
  command(1, 'vote-card', { submissionId: engine.state.round.submissions[0].id }, 1003);
  host('close-voting', {}, 1004);
  const identities = players.map(player => [player.id, player.token, player.name]);
  host('end-game', { allowTie: true });
  host('start-game', { type: 'pictionary' });
  assert.equal(engine.state.cards, null);
  assert.deepEqual(engine.state.players.map(player => [player.id, player.token, player.name]), identities);
  assert.equal(players[0].eventScore, 5);
  assert.equal(players[0].gameScore, 0);
  host('end-game', { allowTie: true });
  host('start-game', { type: 'family-cards' });
  assert.equal(engine.view('player', players[0].id).me.hand.length, 10);
  assert.equal(engine.state.awards.length, 1);
  host('new-event', { mode: 'standalone' });
  assert.equal(engine.state.cards, null);
  assert.deepEqual(engine.state.usedCardPrompts, []);
});

test('card prompts exhaust and recycle without immediately repeating or resetting hands', () => {
  const { engine, host, players } = cardFixture();
  const seen = new Set([engine.state.round.promptId]);
  for (let index = 1; index < CARDS.prompts.length; index++) {
    host('cancel-round');
    host('start-round');
    assert.ok(!seen.has(engine.state.round.promptId));
    seen.add(engine.state.round.promptId);
  }
  const previous = engine.state.round.promptId;
  const hand = engine.view('player', players[0].id).me.hand;
  host('cancel-round');
  host('start-round');
  assert.notEqual(engine.state.round.promptId, previous);
  assert.deepEqual(engine.view('player', players[0].id).me.hand, hand);
});
test('room validation, unlimited same-room participation, unique names and reconnect identity', () => {
  const { engine, players } = fixture(65);
  assert.equal(engine.state.players.length, 65);
  assert.equal(new Set(players.map(player => player.name)).size, 65);
  assert.equal(engine.join({ room: 'invalid' }, players[0].id), players[0]);
  assert.throws(() => engine.join({ room: '9999', canDraw: true }), /valid resort room/);
  assert.throws(() => engine.join({ room: '1105', canDraw: true }), /valid resort room/);
  assert.doesNotThrow(() => engine.join({ room: '1105 A+B', canDraw: false }));
});

test('selection requires two connected volunteers, never guess-only guests or duplicate artists', () => {
  const { engine, players, online, host } = fixture(3);
  players[0].canDraw = false;
  online.delete(players[1].id);
  assert.throws(() => host('select-players'), error => error.code === 'NEED_ARTISTS');
  online.add(players[1].id);
  host('select-players');
  const chosen = engine.state.round.slots.map(slot => slot.playerId);
  assert.equal(new Set(chosen).size, 2);
  assert.ok(!chosen.includes(players[0].id));
});

test('prompts and drawings stay private until Show, including public host display', () => {
  const { engine, players, host, select, playerCommand } = fixture();
  select();
  playerCommand(0, 'stroke', { stroke: STROKE });
  const publicState = engine.view();
  assert.equal(publicState.round.answer, null);
  assert.equal(publicState.round.slots[0].part, null);
  assert.equal(publicState.round.slots[0].drawing.length, 0);
  assert.ok(!JSON.stringify(publicState).includes(players[0].token));
  assert.ok(!Object.hasOwn(publicState.players[0], 'room'));
  const artist = engine.view('player', players[0].id);
  assert.equal(artist.round.slots[0].part, 'sun');
  assert.equal(artist.round.slots[1].part, null);
  assert.equal(artist.round.answer, null);
  assert.equal(engine.view('host').round.slots[0].drawing.length, 1);
  assert.throws(() => host('show'), /stage/);
});

test('nonblank drawings automatically submit at zero; first blank retries, second excludes and replaces', () => {
  const { engine, players, select, playerCommand, host } = fixture();
  select();
  playerCommand(1, 'stroke', { stroke: STROKE });
  engine.tick(1040);
  assert.equal(engine.state.round.slots[0].attempt, 2);
  assert.equal(engine.state.round.slots[0].status, 'drawing');
  assert.equal(engine.state.round.slots[1].status, 'review');
  host('approve', { slot: 1 }, 1041);
  engine.tick(1070);
  assert.equal(players[0].excluded, true);
  assert.equal(engine.state.round.slots[0].playerId, players[2].id);
  assert.equal(engine.state.round.slots[0].status, 'selecting');
  assert.equal(engine.state.round.slots[1].status, 'approved');
  assert.equal(engine.state.round.slots[1].drawing.length, 1);
});

test('two host rejections replace artist; no eligible replacement explicitly waits for one or cancellation', () => {
  const { engine, players, select, playerCommand, host } = fixture(2);
  select();
  playerCommand(0, 'stroke', { stroke: STROKE });
  playerCommand(0, 'finish');
  host('reject', { slot: 0 }, 1012);
  playerCommand(0, 'stroke', { stroke: STROKE }, 1013);
  playerCommand(0, 'finish', {}, 1013);
  host('reject', { slot: 0 }, 1014);
  assert.equal(players[0].excluded, true);
  assert.equal(engine.state.round.slots[0].playerId, null);
  assert.throws(() => host('replace-artist', { slot: 0 }, 1015), error => error.code === 'NEED_ARTISTS');
  host('cancel-round', {}, 1015);
  assert.equal(engine.state.round.stage, 'cancelled');
  assert.equal(players[0].eventScore, 0);
});

test('60-player guessing scores exactly 5,4,3,2,1 plus one per artist; only Reveal awards once', () => {
  const { engine, players, approve, playerCommand, host } = fixture(60);
  approve();
  assert.throws(() => playerCommand(0, 'guess', { answer: 'sunflower' }, 1021), /Artists cannot guess/);
  playerCommand(2, 'guess', { answer: 'wrong' }, 1021);
  assert.equal(engine.view('player', players[2].id).me.correct, false);
  for (let index = 3; index < 60; index++) {
    playerCommand(index, 'guess', { answer: ' SUN-FLOWER ' }, 1022 + index % 20);
  }
  assert.throws(() => playerCommand(3, 'guess', { answer: 'sunflower' }, 1048), /already/);
  assert.throws(() => playerCommand(2, 'guess', { answer: 'sunflower' }, 1050), /ended/);
  assert.equal(engine.view().leaderboards.round.length, 0);
  assert.equal(players.reduce((sum, player) => sum + player.eventScore, 0), 0);
  engine.tick(1050);
  assert.equal(engine.state.round.stage, 'awaiting-reveal');
  host('reveal', {}, 1051);
  assert.deepEqual(players.slice(3, 8).map(player => player.eventScore), [5, 4, 3, 2, 1]);
  assert.equal(players[0].eventScore, 1);
  assert.equal(players[1].eventScore, 1);
  assert.equal(players.reduce((sum, player) => sum + player.eventScore, 0), 17);
  assert.equal(engine.state.awards.reduce((sum, award) => sum + award.points, 0), 17);
  assert.equal(engine.state.awards.length, 7);
  assert.equal(engine.view().round.answer, 'sunflower');
  assert.deepEqual(engine.view().leaderboards.round.map(entry => entry.score), [5, 4, 3, 2, 1]);
  assert.throws(() => host('reveal', {}, 1052), /stage/);
});

test('drawing points, color, size and wrong-role actions are validated', () => {
  const { playerCommand, select } = fixture();
  select();
  assert.throws(() => playerCommand(0, 'new-event', {}), /Unknown player action/);
  assert.throws(() => playerCommand(2, 'stroke', { stroke: STROKE }), /active drawing/);
  assert.throws(() => playerCommand(0, 'stroke', { stroke: { ...STROKE, color: 'url(secret)' } }), /Invalid/);
  assert.throws(() => playerCommand(0, 'stroke', { stroke: { ...STROKE, points: [{ x: -1, y: 0 }] } }), /inside/);
  assert.throws(() => playerCommand(0, 'stroke', { stroke: { ...STROKE, points: Array(513).fill({ x: 0, y: 0 }) } }), /Invalid/);
});

test('Variety Show preserves event identity and points, while new games reset game scores and eligibility', () => {
  const { engine, players, host, approve, playerCommand } = fixture(8, 'variety');
  approve();
  playerCommand(2, 'guess', { answer: 'sunflower' }, 1021);
  engine.tick(1050);
  host('reveal', {}, 1051);
  host('end-game', { allowTie: true }, 1052);
  assert.equal(engine.state.event.status, 'active');
  assert.equal(engine.state.display, 'game-final');
  const oldIdentity = players.map(player => [player.id, player.token, player.name, player.room]);
  players[0].excluded = true;
  host('start-game', {}, 1053);
  assert.deepEqual(players.map(player => [player.id, player.token, player.name, player.room]), oldIdentity);
  assert.equal(players[2].eventScore, 5);
  assert.equal(players[2].gameScore, 0);
  assert.equal(players[0].excluded, false);
  assert.equal(engine.state.awards.length, 3);
  host('new-event', { mode: 'standalone' }, 1054);
  assert.equal(engine.state.players.length, 0);
  assert.equal(engine.state.game, null);
  assert.equal(engine.state.round, null);
});

test('podium ties require confirmation and include every participant at tied cutoffs', () => {
  const { engine, host } = fixture(8);
  assert.throws(() => host('end-game'), error => error instanceof GameError && error.code === 'TIE_CONFIRMATION');
  assert.equal(engine.view().leaderboards.event.filter(entry => entry.rank <= 3).length, 8);
  host('end-game', { allowTie: true });
  assert.equal(engine.state.event.status, 'ended');
  assert.equal(engine.state.display, 'event-final');
});

test('prompts do not repeat before the pack is exhausted, and every word has two parts', () => {
  assert.equal(new Set(WORDS.map(word => word[0])).size, WORDS.length);
  for (const [answer, left, right] of WORDS) assert.equal(answer, left + right);
  const { engine, host } = fixture();
  const first = engine.state.round.answer;
  host('cancel-round');
  host('start-round');
  assert.notEqual(engine.state.round.answer, first);
});

test('a long event can recycle the word pack without wiping players or repeating the previous word', () => {
  const { engine, host, players } = fixture();
  const id = engine.state.event.id;
  for (let index = 0; index < WORDS.length + 2; index++) {
    const previous = engine.state.round.answer;
    host('cancel-round');
    host('start-round');
    assert.notEqual(engine.state.round.answer, previous);
  }
  assert.equal(engine.state.event.id, id);
  assert.equal(engine.state.players[0].id, players[0].id);
});

test('restart closes expired guesses without awarding prematurely or extending deadline', () => {
  const { engine, approve } = fixture();
  approve();
  const resumed = new Engine({ state: structuredClone(engine.state) });
  assert.equal(resumed.tick(9999), true);
  assert.equal(resumed.state.round.stage, 'awaiting-reveal');
  assert.equal(resumed.state.round.awarded, false);
});

test('production timers enforce four-second selection and exactly thirty seconds for drawing and guessing', () => {
  const { engine, host, players } = fixture();
  engine.timing = { selection: 4000, drawing: 30000, guessing: 30000 };
  host('select-players', {}, 1000);
  assert.equal(engine.state.round.slots[0].deadline, 5000);
  assert.equal(engine.tick(4999), false);
  engine.tick(5000);
  assert.equal(engine.state.round.slots[0].deadline, 35000);
  for (const index of [0, 1]) engine.command('player', players[index].id, 'stroke', { stroke: STROKE }, 34999);
  assert.equal(engine.tick(34999), false);
  engine.tick(35000);
  assert.equal(engine.state.round.stage, 'review');
  for (const index of [0, 1]) host('approve', { slot: index }, 35001);
  host('show', {}, 35002);
  assert.equal(engine.state.round.deadline, 65002);
  engine.command('player', players[2].id, 'guess', { answer: 'sunflower' }, 65001);
  assert.throws(() => engine.command('player', players[3].id, 'guess', { answer: 'sunflower' }, 65002), /ended/);
  assert.equal(engine.tick(65001), false);
  engine.tick(65002);
  assert.equal(engine.state.round.stage, 'awaiting-reveal');
});
