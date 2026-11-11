'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, freshState } = require('../lib/engine');
const { moderateCaption } = require('../lib/caption-filter');
const { imageLibrary } = require('../lib/picture-images');

function fixture(count = 12, mode = 'small') {
  const online = new Set();
  const engine = new Engine({ random: () => 0, online: () => online,
    timing: { submissions: 30, judging: 30, voting: 30 } });
  const host = (action, data = {}, now = 1000) => engine.command('host', null, action, data, now);
  host('new-event', { mode: 'variety' });
  const players = Array.from({ length: count }, () => {
    const player = engine.join({ room: '1104', canDraw: false });
    online.add(player.id);
    return player;
  });
  host('start-game', { type: 'get-the-picture', pictureMode: mode });
  host('start-round');
  const command = (index, action, data = {}, now = 1001) =>
    engine.command('player', players[index].id, action, data, now);
  const submit = (index, text = 'The duck requested another snack break.', now = 1001) =>
    command(index, 'submit-caption', { text }, now);
  return { engine, players, online, host, command, submit };
}

test('caption filtering rejects offensive obfuscations, politics and targeted insults but preserves harmless words', () => {
  for (const text of [
    'What the fuck!', 's.h.i.t', 'sh1t', 'f u c k', 'fuuuck', 'sh\u200bit', 'ｓｈｉｔ',
    'The President is on vacation.', 'D0nald Trump', 'POTUS has arrived', 'Marco Rubio at lunch',
    'Maria Cantwell on the beach', 'Sen. Jones likes this duck',
    'Florida is stupid', 'Timeshares are a scam', 'All salesmen are dishonest',
    'Those conservatives are brainwashed', 'Democrats love this duck',
    'Muslims are awful', 'Those Christians are idiots', 'Resorts are overpriced',
    'Black people are inferior', 'Asians are superior', 'Immigrants should leave',
    'go back where you came from',
  ]) assert.ok(moderateCaption(text), `Should reject: ${text}`);
  for (const text of [
    'A classic vacation assignment.', 'The raccoon packed a suitcase.', 'The duck requested another snack break.',
    'Florida sunshine looks good on you!', 'Salespeople deserve a vacation too.',
    'This timeshare has a beautiful pool.', 'Our church brought all the snacks.', 'A very conservative amount of sunscreen.',
  ]) assert.equal(moderateCaption(text), null, `Should allow: ${text}`);
  assert.ok(moderateCaption('The secret pineapple has arrived.', ['secret pineapple']));
  assert.equal(moderateCaption('A pineapple has arrived.', ['secret pineapple']), null);
});

test('images preload before a full caption timer; 100 accepted captions stay private until voting', () => {
  const { engine, players, host, command, submit } = fixture(100);
  assert.equal(engine.state.round.stage, 'loading');
  assert.equal(engine.state.round.deadline, null);
  assert.equal(engine.tick(9000), false);
  assert.throws(() => submit(0), /stage/);
  command(0, 'picture-ready');
  command(0, 'picture-ready');
  assert.equal(engine.view('host').round.readyCount, 1);
  host('start-caption-timer');
  assert.equal(engine.state.round.deadline, 1030);
  assert.throws(() => submit(0, 'Florida is stupid'), error => error.code === 'CAPTION_REJECTED');
  assert.equal(engine.state.round.submissions.length, 0);
  submit(0);
  assert.throws(() => submit(0), /already submitted/);
  for (let index = 1; index < 100; index++) submit(index);
  assert.equal(engine.state.round.stage, 'captioning');
  const publicView = engine.view();
  assert.equal(publicView.round.submissionCount, 100);
  assert.deepEqual(publicView.round.finalists, []);
  assert.ok(!JSON.stringify(publicView).includes('requested another snack'));
  assert.equal(engine.view('player', players[0].id).me.ownCaption, 'The duck requested another snack break.');
  engine.tick(1030);
  assert.equal(engine.state.round.stage, 'voting');
  assert.equal(engine.view().round.finalists.length, 100);
  assert.ok(engine.view().round.finalists.every(entry => Object.keys(entry).sort().join() === 'id,text'));
});

test('large-audience captions require explicit host approval and removed captions never become finalists', () => {
  const { engine, host, submit, command, players } = fixture(12, 'large');
  host('start-caption-timer');
  submit(0);
  submit(1);
  submit(2);
  const [first, second, third] = engine.state.round.submissions;
  host('review-caption', { submissionId: first.id, decision: 'approve' });
  engine.tick(1030);
  assert.equal(engine.state.round.stage, 'reviewing');
  assert.deepEqual(engine.view().round.finalists, []);
  assert.equal(engine.view('player', players[1].id).me.judgeChoices.length, 0);
  assert.ok(!Object.hasOwn(engine.view().round, 'review'));
  host('review-caption', { submissionId: second.id, decision: 'approve' });
  host('review-caption', { submissionId: second.id, decision: 'remove' });
  host('open-picture-voting', {}, 1031);
  assert.deepEqual(engine.view().round.finalists.map(entry => entry.id), [first.id]);
  assert.throws(() => command(3, 'vote-caption', { submissionId: third.id }, 1032), /finalist/);
  assert.throws(() => command(0, 'vote-caption', { submissionId: first.id }, 1032), /own caption/);
  command(3, 'vote-caption', { submissionId: first.id }, 1032);
  assert.throws(() => command(3, 'vote-caption', { submissionId: first.id }, 1032), /already recorded/);
  assert.ok(!Object.hasOwn(engine.view().round.finalists[0], 'votes'));
  host('review-caption', { submissionId: first.id, decision: 'remove' }, 1033);
  assert.equal(engine.state.round.votes.length, 0);
  assert.equal(engine.view('player', players[3].id).me.votedFor, null);
  assert.deepEqual(engine.view().round.finalists, []);
  assert.throws(() => host('review-caption', { submissionId: first.id, decision: 'approve' }), /pending/);
});

test('poolside balances partial groups and exposes only other group members’ captions to each judge', () => {
  const { engine, players, host, submit } = fixture(21, 'poolside');
  const groups = engine.state.round.groups;
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(group => group.members.length), [7, 7, 7]);
  assert.equal(new Set(groups.flatMap(group => group.members)).size, 21);
  host('start-caption-timer');
  players.forEach((_, index) => submit(index));
  engine.tick(1030);
  assert.equal(engine.state.round.stage, 'judging');
  assert.deepEqual(engine.view().round.finalists, []);
  for (const group of groups) {
    const judgeView = engine.view('player', group.judgeId);
    const own = engine.state.round.submissions.find(entry => entry.playerId === group.judgeId);
    const outsider = engine.state.round.submissions.find(entry => !group.members.includes(entry.playerId));
    assert.equal(judgeView.me.judgeChoices.length, 6);
    assert.ok(judgeView.me.judgeChoices.every(entry => entry.id !== own.id && entry.id !== outsider.id));
    assert.ok(judgeView.me.judgeChoices.every(entry => Object.keys(entry).sort().join() === 'id,text'));
    for (const bad of [own, outsider]) assert.throws(() =>
      engine.command('player', group.judgeId, 'nominate-caption', { submissionId: bad.id }, 1031), /another player/);
    const nominee = judgeView.me.judgeChoices[0];
    engine.command('player', group.judgeId, 'nominate-caption', { submissionId: nominee.id }, 1031);
    assert.throws(() => engine.command('player', group.judgeId, 'nominate-caption', { submissionId: nominee.id }, 1031));
  }
  assert.equal(engine.state.round.stage, 'voting');
  assert.equal(engine.view().round.finalists.length, 3);
  assert.ok(engine.view().round.finalists.every(entry => groups.some(group => group.selectedId === entry.id)));
});

test('poolside rotates all 100 judges before reuse and never repeats the preceding round’s judges', () => {
  const { engine, host } = fixture(100, 'poolside');
  const used = new Set();
  let previous = [];
  for (let round = 0; round < 11; round++) {
    const judges = engine.state.round.groups.map(group => group.judgeId);
    assert.equal(judges.length, 10);
    assert.ok(judges.every(id => !previous.includes(id)));
    if (round < 10) assert.ok(judges.every(id => !used.has(id)));
    judges.forEach(id => used.add(id));
    previous = judges;
    host('cancel-round');
    host('start-round');
  }
  assert.equal(used.size, 100);
});

test('poolside judging timeout advances only actual nominations; a lone judge caption cannot nominate itself', () => {
  const { engine, host, submit } = fixture(2, 'poolside');
  const judge = engine.state.round.groups[0].judgeId;
  const index = engine.state.players.findIndex(player => player.id === judge);
  host('start-caption-timer');
  submit(index);
  engine.tick(1030);
  assert.equal(engine.view('player', judge).me.judgeChoices.length, 0);
  engine.tick(1060);
  assert.equal(engine.state.round.stage, 'cancelled');
  assert.equal(engine.state.awards.length, 0);
});

test('poolside restart preserves groups, nominations and rotation counts through an expired judging timer', () => {
  const { engine, host, submit, players } = fixture(20, 'poolside');
  host('start-caption-timer');
  players.forEach((_, index) => submit(index));
  engine.tick(1030);
  const firstGroup = engine.state.round.groups[0];
  const choice = engine.view('player', firstGroup.judgeId).me.judgeChoices[0];
  engine.command('player', firstGroup.judgeId, 'nominate-caption', { submissionId: choice.id }, 1031);
  const recovered = new Engine({ state: structuredClone(engine.state) });
  assert.deepEqual(recovered.state.round.groups, engine.state.round.groups);
  assert.deepEqual(recovered.state.pictureJudgeCounts, engine.state.pictureJudgeCounts);
  assert.equal(recovered.view('player', firstGroup.judgeId).me.nominated, true);
  recovered.tick(1060);
  assert.equal(recovered.state.round.stage, 'voting');
  assert.deepEqual(recovered.view().round.finalists.map(entry => entry.id), [choice.id]);
  assert.equal(recovered.state.awards.length, 0);
});

test('ranked caption points stop at fifth place, exclude zero votes and score exactly once after recovery', () => {
  const { engine, host, submit, command, players } = fixture(40);
  host('start-caption-timer');
  for (let index = 0; index < 7; index++) submit(index);
  const entries = [...engine.state.round.submissions];
  engine.tick(1030);
  let voter = 7;
  [7, 6, 5, 4, 3, 2, 0].forEach((count, index) => {
    for (let vote = 0; vote < count; vote++) command(voter++, 'vote-caption', { submissionId: entries[index].id }, 1031);
  });
  assert.equal(engine.state.awards.length, 0);
  const recovered = new Engine({ state: structuredClone(engine.state) });
  assert.equal(recovered.tick(5000), true);
  assert.deepEqual(recovered.state.players.slice(0, 7).map(player => player.gameScore), [5, 4, 3, 2, 1, 0, 0]);
  assert.equal(recovered.state.awards.length, 5);
  const secondRestart = new Engine({ state: structuredClone(recovered.state) });
  assert.equal(secondRestart.tick(6000), false);
  assert.equal(secondRestart.state.awards.length, 5);
  assert.equal(secondRestart.player(players[0].id).token, players[0].token);
  secondRestart.command('host', null, 'end-game', { allowTie: true });
  secondRestart.command('host', null, 'start-game', { type: 'family-cards' });
  assert.equal(secondRestart.player(players[0].id).eventScore, 5);
  assert.equal(secondRestart.player(players[0].id).gameScore, 0);
});

test('caption ties share competition rank, and removal releases ballots for a different finalist', () => {
  const { engine, host, submit, command, players } = fixture(12);
  host('start-caption-timer');
  for (let index = 0; index < 4; index++) submit(index);
  const entries = [...engine.state.round.submissions];
  engine.tick(1030);
  command(4, 'vote-caption', { submissionId: entries[3].id }, 1031);
  host('review-caption', { submissionId: entries[3].id, decision: 'remove' }, 1032);
  [0, 0, 0, 1, 1, 1, 2].forEach((answer, index) =>
    command(index + 4, 'vote-caption', { submissionId: entries[answer].id }, 1033));
  host('close-voting', {}, 1034);
  assert.deepEqual(players.slice(0, 4).map(player => player.gameScore), [5, 5, 3, 0]);
  assert.deepEqual(engine.view().leaderboards.round.map(entry => entry.rank), [1, 1, 3]);
});

test('late joins, deadlines, cancellation, image selection and saved policy obey round boundaries', () => {
  const { engine, online, host, submit, command } = fixture();
  const late = engine.join({ room: '1104', canDraw: false });
  online.add(late.id);
  host('set-picture-policy', { terms: 'secret pineapple\nsecret pineapple' });
  host('start-caption-timer');
  assert.throws(() => submit(0, 'A secret pineapple arrived.'), error => error.code === 'CAPTION_REJECTED');
  assert.equal(engine.state.pictureBlockedTerms.length, 1);
  assert.throws(() => engine.command('player', late.id, 'submit-caption', { text: 'Vacation!' }, 1001), /next round/);
  assert.throws(() => submit(0, 'Vacation!', 1030), /closed/);
  submit(0);
  engine.tick(1030);
  const first = engine.state.round.submissions[0];
  engine.command('player', late.id, 'vote-caption', { submissionId: first.id }, 1031);
  assert.throws(() => command(1, 'vote-caption', { submissionId: first.id }, 1060), /closed/);
  host('cancel-round', {}, 1032);
  assert.equal(engine.tick(6000), false);
  assert.equal(engine.state.awards.length, 0);
  const imageId = engine.state.round.image.id;
  host('set-picture-image', { imageId, enabled: false });
  assert.throws(() => host('start-round', { imageId }), /enabled image/);
  host('start-round');
  assert.notEqual(engine.state.round.image.id, imageId);
  assert.ok(engine.state.round.participants.includes(late.id));
  host('cancel-round');
  engine.state.pictureImages.push({ id: 'uploaded', kind: 'r2', key: 'example.webp', title: 'Uploaded', alt: 'A duck', credit: 'Operator' });
  host('new-event', { mode: 'standalone' });
  assert.equal(engine.state.pictureImages.length, 1);
  assert.ok(engine.state.disabledPictureImages.includes(imageId));
  assert.deepEqual(engine.state.pictureBlockedTerms, ['secret pineapple']);
  assert.equal(engine.view().pictureImages, undefined);
  assert.equal(engine.view().pictureBlockedTerms, undefined);
});

test('default caption, judging and voting timers each last 30 seconds; images recycle without immediate repeats', () => {
  const { engine, host, submit } = fixture();
  engine.timing = { submissions: 30000, judging: 30000, voting: 30000 };
  host('start-caption-timer', {}, 2000);
  assert.equal(engine.state.round.deadline, 32000);
  submit(0, 'Vacation mode.', 2001);
  assert.equal(engine.tick(31999), false);
  engine.tick(32000);
  assert.equal(engine.state.round.deadline, 62000);
  host('cancel-round');
  for (let round = 0; round < 12; round++) {
    const previous = engine.state.round.image.id;
    host('start-round');
    assert.notEqual(engine.state.round.image.id, previous);
    host('cancel-round');
  }
  const pool = fixture(10, 'poolside');
  pool.engine.timing.judging = 30000;
  pool.host('start-caption-timer');
  pool.submit(1);
  pool.engine.tick(1030);
  assert.equal(pool.engine.state.round.deadline, 31030);
});

test('old snapshots gain picture defaults and invalid modes, capacities and image settings are rejected', () => {
  const state = freshState();
  for (const key of ['pictureImages', 'disabledPictureImages', 'usedPictureImages', 'pictureJudgeCounts', 'pictureBlockedTerms']) delete state[key];
  const restored = new Engine({ state });
  restored.command('host', null, 'new-event', { mode: 'standalone' });
  assert.throws(() => restored.command('host', null, 'start-game', { type: 'get-the-picture', pictureMode: 'invalid' }), /format/);
  const { engine, host } = fixture(100);
  assert.throws(() => engine.join({ room: '1104', canDraw: false }), /100 registered/);
  assert.throws(() => host('set-picture-image', { imageId: 'missing', enabled: false }), /library/);
  assert.throws(() => host('set-picture-policy', { terms: '!!!' }), /English/);
  assert.equal(imageLibrary(engine.state).length, 6);
});
