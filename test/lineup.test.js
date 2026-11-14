'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, freshState } = require('../lib/engine');

function fixture(count = 8, faces = 4) {
  const online = new Set();
  const engine = new Engine({ online: () => online, random: () => 0 });
  const host = (action, data = {}, now = 1000) => engine.command('host', null, action, data, now);
  host('new-event', { mode: 'variety' });
  engine.state.lineupImages = Array.from({ length: 4 }, (_, index) => ({
    id: `face-${index}`, key: `lineup/${index}.webp`, kind: 'r2', enabled: true,
    title: `Secret celebrity ${index}`, alt: 'A smiling person', credit: `Secret source ${index}`,
  }));
  const question = { prompt: 'Who is making headlines?', choices: engine.state.lineupImages.slice(0, faces)
    .map(image => ({ imageId: image.id, x: 25, y: 75 })), correctChoice: 1,
  revealName: 'Secret celebrity name', explanation: 'Secret explanation' };
  host('save-lineup-question', question);
  const players = Array.from({ length: count }, () => {
    const player = engine.join({ room: '1104', canDraw: false });
    online.add(player.id);
    return player;
  });
  host('start-game', { type: 'lineup' });
  host('start-round');
  const command = (index, action, data = {}, now = 1001) =>
    engine.command('player', players[index].id, action, { roundId: engine.state.round.id, ...data }, now);
  const submit = (index, choice = 1, now = 1001) => command(index, 'submit-lineup-answer', { choice }, now);
  return { engine, host, players, online, question, command, submit };
}

test('Lineup validates 2-4 different images, focal positions, correct photo and reveal fields', () => {
  for (const faces of [2, 3, 4]) assert.equal(fixture(2, faces).engine.state.round.images.length, faces);
  const { host, question } = fixture();
  for (const changes of [
    { prompt: '' }, { prompt: 'x'.repeat(241) }, { choices: null },
    { choices: question.choices.slice(0, 1) }, { choices: [...question.choices, question.choices[0]] },
    { choices: [question.choices[0], question.choices[0]] },
    { choices: [null, question.choices[0]] },
    { choices: [{ imageId: 'missing', x: 50, y: 50 }, question.choices[0]] },
    ...[-1, 101, Infinity, NaN, '50', undefined].map(x => ({
      choices: [{ ...question.choices[0], x }, question.choices[1]],
    })),
    { choices: [{ ...question.choices[0], y: -1 }, question.choices[1]] },
    { correctChoice: null }, { correctChoice: '1' }, { correctChoice: 4 },
    { revealName: 7 }, { revealName: 'x'.repeat(121) },
    { explanation: {} }, { explanation: 'x'.repeat(601) },
  ]) assert.throws(() => host('save-lineup-question', { ...question, ...changes }));
  host('save-lineup-question', { ...question, choices: [{ ...question.choices[0], x: 0, y: 100 }, question.choices[1]] });
});

test('preload conceals headlines and all answer metadata; readiness and locked choices stay private', () => {
  const { engine, host, command, submit, players } = fixture();
  assert.equal(engine.view().round.prompt, null);
  assert.equal(engine.tick(9000), false);
  assert.equal(engine.view('host').round.correctChoice, 1);
  assert.throws(() => submit(0), /not open/);
  command(0, 'lineup-ready');
  command(0, 'lineup-ready');
  assert.equal(engine.view('host').round.readyCount, 1);
  host('start-lineup-timer');
  assert.equal(engine.state.round.deadline, 31000);
  submit(0);
  submit(1, 0);
  for (const role of ['display', 'player']) {
    const view = engine.view(role, role === 'player' ? players[0].id : null);
    assert.equal(view.round.prompt, 'Who is making headlines?');
    assert.equal(view.round.correctChoice, null);
    assert.equal(view.lineupImages, undefined);
    assert.equal(view.lineupQuestions, undefined);
    assert.equal(view.round.revealName, undefined);
    assert.equal(view.round.explanation, undefined);
    assert.ok(!JSON.stringify(view).includes('Secret'));
    assert.ok(!Object.hasOwn(view.round, 'submissions'));
    assert.deepEqual(view.round.images.map(({ x, y }) => [x, y]), Array(4).fill([25, 75]));
    assert.deepEqual(view.leaderboards.round, []);
  }
  assert.equal(engine.view('player', players[0].id).me.correct, null);
  assert.equal(engine.view('player', players[0].id).me.answerChoice, 1);
  assert.throws(() => submit(0, 0), /first answer is final/);
  for (const choice of [-1, 4, '1', null]) assert.throws(() => submit(2, choice), /displayed/);
  assert.throws(() => command(2, 'submit-lineup-answer', { roundId: 'old', choice: 1 }), /changed/);
  assert.throws(() => command(2, 'submit-screengrabber-answer', { choice: 1 }), /Unknown/);
  host('close-lineup-answers');
  assert.equal(engine.view().round.revealName, undefined);
  host('reveal');
  assert.equal(engine.view().round.revealName, 'Secret celebrity name');
  assert.equal(engine.view().round.explanation, 'Secret explanation');
  assert.equal(engine.view().round.correctChoice, 1);
  assert.equal(engine.view('player', players[1].id).me.correct, false);
});

test('100 locked answers score by server receipt, survive restart, and cannot award twice', () => {
  const { engine, host, submit, players } = fixture(100);
  host('start-lineup-timer');
  for (let index = 0; index < 100; index++) submit(index, 1, 1002);
  assert.throws(() => submit(0, 1, 31000), /not open/);
  const recovered = new Engine({ state: structuredClone(engine.state) });
  assert.equal(recovered.tick(30999), false);
  assert.equal(recovered.tick(31000), true);
  assert.equal(recovered.state.awards.length, 0);
  recovered.command('host', null, 'reveal');
  assert.deepEqual(recovered.state.players.slice(0, 7).map(player => player.gameScore), [6, 5, 4, 3, 2, 1, 1]);
  assert.equal(recovered.state.awards.length, 100);
  assert.equal(recovered.state.players.reduce((sum, player) => sum + player.eventScore, 0), 115);
  assert.equal(recovered.view().leaderboards.round.length, 100);
  const again = new Engine({ state: structuredClone(recovered.state) });
  assert.throws(() => again.command('host', null, 'reveal'), /stage/);
  again.command('host', null, 'end-game', { allowTie: true });
  again.command('host', null, 'start-game', { type: 'screengrabbers' });
  assert.equal(again.player(players[0].id).name, players[0].name);
  assert.equal(again.player(players[0].id).eventScore, 6);
  assert.equal(again.player(players[0].id).gameScore, 0);
});

test('wrong answers do not consume speed places; late joins wait; cancelled rounds do not score', () => {
  const { engine, host, submit, online } = fixture();
  const late = engine.join({ room: '1104', canDraw: false });
  online.add(late.id);
  host('start-lineup-timer');
  assert.throws(() => engine.command('player', late.id, 'submit-lineup-answer',
    { roundId: engine.state.round.id, choice: 1 }, 1001), /next round/);
  submit(0, 0);
  submit(1, 1, 1002);
  submit(2, 1, 1002);
  online.clear();
  online.add(late.id);
  submit(3, 1, 1003);
  host('close-lineup-answers');
  host('reveal');
  assert.deepEqual(engine.state.players.slice(0, 4).map(player => player.gameScore), [0, 6, 5, 4]);
  assert.throws(() => host('start-round'), /2 to 100/);
  online.add(engine.state.players[0].id);
  host('start-round');
  assert.ok(engine.state.round.participants.includes(late.id));
  host('cancel-round');
  assert.equal(engine.tick(40000), false);
  assert.equal(engine.state.awards.length, 3);
});

test('editing crops and disabling images cannot change live rounds; libraries survive new events', () => {
  const { engine, host, question } = fixture();
  const id = engine.state.lineupQuestions[0].id;
  host('save-lineup-question', { ...question, questionId: id, prompt: 'Changed', correctChoice: 0,
    choices: question.choices.map(choice => ({ ...choice, x: 100 })) });
  host('set-lineup-image', { imageId: 'face-0', enabled: false });
  assert.equal(engine.state.round.question.prompt, question.prompt);
  assert.equal(engine.state.round.question.correctChoice, 1);
  assert.equal(engine.state.round.images[0].x, 25);
  host('cancel-round');
  assert.throws(() => host('start-round'), /enabled/);
  host('set-lineup-image', { imageId: 'face-0', enabled: true });
  host('set-lineup-question', { questionId: id, enabled: false });
  assert.throws(() => host('start-round'), /enabled/);
  host('new-event', { mode: 'standalone' });
  assert.equal(engine.state.lineupImages.length, 4);
  assert.equal(engine.state.lineupQuestions[0].enabled, false);
  assert.deepEqual(engine.state.usedLineupQuestions, []);
});

test('Lineup cycles headlines without immediate repeats and supports single-question libraries', () => {
  const { engine, host, question } = fixture();
  host('cancel-round');
  host('start-round');
  assert.equal(engine.state.round.question.prompt, question.prompt);
  host('cancel-round');
  host('save-lineup-question', { ...question, prompt: 'Second headline' });
  host('save-lineup-question', { ...question, prompt: 'Third headline' });
  const ids = new Set([engine.state.round.question.id]);
  for (let index = 0; index < 2; index++) {
    host('start-round');
    assert.ok(!ids.has(engine.state.round.question.id));
    ids.add(engine.state.round.question.id);
    host('cancel-round');
  }
  const previous = engine.state.round.question.id;
  host('start-round');
  assert.notEqual(engine.state.round.question.id, previous);
  assert.equal(engine.state.usedLineupQuestions.length, 1);
});

test('older snapshots acquire Lineup libraries; standalone Lineup ends the event', () => {
  const old = freshState();
  for (const key of ['lineupImages', 'lineupQuestions', 'usedLineupQuestions']) delete old[key];
  assert.deepEqual(new Engine({ state: old }).state.lineupQuestions, []);
  const { engine, host, online, question } = fixture();
  host('new-event', { mode: 'standalone' });
  for (let index = 0; index < 2; index++) online.add(engine.join({ room: '1104', canDraw: false }).id);
  host('start-game', { type: 'lineup' });
  host('start-round');
  assert.equal(engine.state.round.question.prompt, question.prompt);
  host('start-lineup-timer');
  host('close-lineup-answers');
  host('reveal');
  host('end-game', { allowTie: true });
  assert.equal(engine.state.event.status, 'ended');
});
