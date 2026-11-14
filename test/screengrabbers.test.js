'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, freshState } = require('../lib/engine');

function fixture(count = 8, mode = 'variety') {
  const online = new Set();
  const engine = new Engine({ online: () => online, random: () => 0 });
  const host = (action, data = {}, now = 1000) => engine.command('host', null, action, data, now);
  host('new-event', { mode });
  engine.state.screengrabberImages.push({
    id: 'movie-image', key: 'screengrabbers/test.webp', kind: 'r2', enabled: true,
    title: 'Private movie title', alt: 'A silhouette in a doorway', credit: 'Private source credit',
  });
  const question = { imageId: 'movie-image', prompt: 'Which movie is this?',
    options: ['First movie', 'Second movie', 'Third movie', 'Fourth movie'], correctChoice: 1 };
  host('save-screengrabber-question', question);
  const players = Array.from({ length: count }, () => {
    const player = engine.join({ room: '1104', canDraw: false });
    online.add(player.id);
    return player;
  });
  host('start-game', { type: 'screengrabbers' });
  host('start-round');
  const command = (index, action, data = {}, now = 1001) =>
    engine.command('player', players[index].id, action, { roundId: engine.state.round.id, ...data }, now);
  const submit = (index, choice = 1, now = 1001) => command(index, 'submit-screengrabber-answer', { choice }, now);
  return { engine, host, players, online, command, submit, question };
}

test('question validation rejects incomplete, duplicate and invalid choices; editing preserves the live question', () => {
  const { engine, host, question } = fixture();
  for (const changes of [
    { imageId: 'missing' }, { prompt: '' }, { prompt: 'x'.repeat(241) },
    { options: ['Only one'] }, { options: ['First', ' first '] },
    { options: ['Valid', ''] }, { options: ['Valid', 7] }, { options: Array(7).fill('choice') },
    { options: ['a', 'x'.repeat(121)] }, { correctChoice: 4 }, { correctChoice: '1' },
  ]) assert.throws(() => host('save-screengrabber-question', { ...question, ...changes }));
  assert.equal(engine.state.screengrabberQuestions.length, 1);
  const id = engine.state.screengrabberQuestions[0].id;
  host('save-screengrabber-question', { ...question, questionId: id, prompt: 'Revised question', correctChoice: 2 });
  assert.equal(engine.state.screengrabberQuestions[0].prompt, 'Revised question');
  assert.equal(engine.state.round.question.prompt, 'Which movie is this?');
  assert.equal(engine.state.round.question.correctChoice, 1);
  assert.throws(() => host('save-screengrabber-question', { ...question, questionId: 'missing' }), /existing/);
  host('set-screengrabber-image', { imageId: question.imageId, enabled: false });
  host('cancel-round');
  assert.throws(() => host('start-round'), /enabled question/);
  host('set-screengrabber-image', { imageId: question.imageId, enabled: true });
  host('set-screengrabber-question', { questionId: id, enabled: false });
  assert.throws(() => host('start-round'), /enabled question/);
});

test('preloading conceals the question; submissions and correctness remain private until host reveal', () => {
  const { engine, host, players, command, submit } = fixture();
  assert.equal(engine.state.round.stage, 'loading');
  assert.equal(engine.tick(9000), false);
  assert.equal(engine.view().round.prompt, null);
  assert.deepEqual(engine.view().round.options, []);
  assert.equal(engine.view('host').round.correctChoice, 1);
  assert.throws(() => submit(0), /not open/);
  command(0, 'screengrabber-ready');
  command(0, 'screengrabber-ready');
  assert.equal(engine.view('host').round.readyCount, 1);
  host('start-screengrabber-timer');
  assert.equal(engine.state.round.deadline, 31000);
  submit(0);
  submit(1, 0);
  for (const role of ['display', 'player']) {
    const view = engine.view(role, role === 'player' ? players[0].id : null);
    assert.equal(view.round.correctChoice, null);
    assert.equal(view.screengrabberQuestions, undefined);
    assert.equal(view.screengrabberImages, undefined);
    assert.equal(view.round.image.credit, undefined);
    assert.ok(!JSON.stringify(view).includes('Private movie title'));
    assert.ok(!Object.hasOwn(view.round, 'submissions'));
    assert.deepEqual(view.leaderboards.round, []);
  }
  assert.equal(engine.view('player', players[0].id).me.correct, null);
  assert.equal(engine.view('player', players[0].id).me.answerChoice, 1);
  assert.equal(engine.view('player', players[1].id).me.answerChoice, 0);
  assert.throws(() => submit(1, 1), /first answer is final/);
  assert.throws(() => submit(2, -1), /displayed/);
  assert.throws(() => submit(2, 4), /displayed/);
  assert.throws(() => submit(2, '1'), /displayed/);
  assert.throws(() => command(2, 'submit-screengrabber-answer', { roundId: 'old-round', choice: 1 }), /changed/);
  host('close-screengrabber-answers', {}, 1002);
  assert.equal(engine.view().round.correctChoice, null);
  assert.equal(engine.state.awards.length, 0);
  assert.throws(() => submit(2), /stage/);
  host('reveal');
  assert.equal(engine.view().round.correctChoice, 1);
  assert.equal(engine.view('player', players[0].id).me.correct, true);
  assert.equal(engine.view('player', players[1].id).me.correct, false);
});

test('all 100 correct answers score, the first five get bonuses, and recovery cannot award twice', () => {
  const { engine, host, players, submit } = fixture(100);
  host('start-screengrabber-timer');
  for (let index = 0; index < 100; index++) submit(index);
  assert.equal(engine.tick(30999), false);
  assert.throws(() => submit(0, 1, 31000), /not open/);
  const recovered = new Engine({ state: structuredClone(engine.state) });
  assert.equal(recovered.tick(31000), true);
  assert.equal(recovered.state.round.stage, 'awaiting-reveal');
  assert.equal(recovered.state.awards.length, 0);
  recovered.command('host', null, 'reveal');
  assert.deepEqual(recovered.state.players.slice(0, 7).map(player => player.gameScore), [6, 5, 4, 3, 2, 1, 1]);
  assert.ok(recovered.state.players.slice(5).every(player => player.gameScore === 1));
  assert.equal(recovered.state.awards.length, 100);
  assert.equal(recovered.state.awards.reduce((sum, award) => sum + award.points, 0), 115);
  assert.equal(recovered.view().leaderboards.round.length, 100);
  const again = new Engine({ state: structuredClone(recovered.state) });
  assert.equal(again.tick(90000), false);
  assert.throws(() => again.command('host', null, 'reveal'), /stage/);
  again.command('host', null, 'end-game', { allowTie: true });
  again.command('host', null, 'start-game', { type: 'family-cards' });
  assert.equal(again.player(players[0].id).name, players[0].name);
  assert.equal(again.player(players[0].id).eventScore, 6);
  assert.equal(again.player(players[0].id).gameScore, 0);
  assert.equal(again.state.screengrabberQuestions.length, 1);
});

test('incorrect answers do not take bonus places; cancelled and unanswered rounds earn no points', () => {
  const { engine, host, submit } = fixture();
  host('start-screengrabber-timer');
  submit(0, 0);
  submit(1, 1, 1002);
  submit(2, 1, 1002);
  host('close-screengrabber-answers');
  host('reveal');
  assert.deepEqual(engine.state.players.slice(0, 3).map(player => player.gameScore), [0, 6, 5]);
  host('start-round');
  host('start-screengrabber-timer');
  submit(3);
  host('cancel-round');
  assert.equal(engine.tick(31000), false);
  assert.equal(engine.state.awards.length, 2);
  host('start-round');
  host('start-screengrabber-timer');
  host('close-screengrabber-answers');
  host('reveal');
  assert.deepEqual(engine.state.round.results, []);
  assert.equal(engine.state.awards.length, 2);
});

test('questions cycle without repeating until exhausted, skip disabled questions, and survive new events', () => {
  const { engine, host, question } = fixture();
  host('cancel-round');
  host('save-screengrabber-question', { ...question, prompt: 'Second question' });
  host('save-screengrabber-question', { ...question, prompt: 'Third question' });
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
  assert.equal(engine.state.usedScreengrabberQuestions.length, 1);
  host('cancel-round');
  const firstId = engine.state.screengrabberQuestions[0].id;
  host('set-screengrabber-question', { questionId: firstId, enabled: false });
  for (let index = 0; index < 5; index++) {
    host('start-round');
    assert.notEqual(engine.state.round.question.id, firstId);
    host('cancel-round');
  }
  host('new-event', { mode: 'standalone' });
  assert.equal(engine.state.screengrabberImages.length, 1);
  assert.equal(engine.state.screengrabberQuestions.length, 3);
  assert.equal(engine.state.screengrabberQuestions[0].enabled, false);
  assert.deepEqual(engine.state.usedScreengrabberQuestions, []);
});

test('late joins wait for next question, single-item libraries repeat, and standalone conclusion ends the event', () => {
  const { engine, host, online, players, question } = fixture(2, 'standalone');
  const late = engine.join({ room: '1104', canDraw: false });
  online.add(late.id);
  host('start-screengrabber-timer');
  assert.throws(() => engine.command('player', late.id, 'submit-screengrabber-answer',
    { roundId: engine.state.round.id, choice: 1 }, 1001), /next round/);
  host('cancel-round');
  host('start-round');
  assert.ok(engine.state.round.participants.includes(late.id));
  assert.equal(engine.state.round.question.imageId, question.imageId);
  host('start-screengrabber-timer');
  host('close-screengrabber-answers');
  host('reveal');
  host('end-game', { allowTie: true });
  assert.equal(engine.state.event.status, 'ended');
  assert.equal(engine.state.display, 'event-final');
  assert.equal(engine.player(players[0].id).name, players[0].name);
});

test('all game types and lobbies enforce the 100-player event ceiling but permit existing-player rejoin', () => {
  for (const type of [null, 'pictionary', 'family-cards', 'get-the-picture', 'screengrabbers', 'lineup']) {
    const engine = new Engine({ random: () => 0 });
    engine.command('host', null, 'new-event', { mode: 'variety' });
    if (type) engine.command('host', null, 'start-game', { type, pictureMode: 'small' });
    for (let index = 0; index < 100; index++) engine.join({ room: '1104', canDraw: false });
    assert.throws(() => engine.join({ room: '1104', canDraw: false }), /100 registered/);
    assert.equal(engine.join({}, engine.state.players[0].id).id, engine.state.players[0].id);
  }
  const old = freshState();
  for (const key of ['screengrabberImages', 'screengrabberQuestions', 'usedScreengrabberQuestions']) delete old[key];
  const restored = new Engine({ state: old });
  assert.deepEqual(restored.state.screengrabberImages, []);
  assert.deepEqual(restored.state.screengrabberQuestions, []);
});
