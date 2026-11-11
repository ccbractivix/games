'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const { VALID_VILLAS } = require('../shared/rooms');
const WORDS = require('./words');
const CARDS = require('./family-cards.json');

const ADJECTIVES = ['Wobbly', 'Disco', 'Bouncy', 'Noodle', 'Sparkly', 'Giggle', 'Dancing', 'Dizzy',
  'Jolly', 'Fluffy', 'Zippy', 'Wiggly', 'Snazzy', 'Silly', 'Peppy', 'Bubbly'];
const NOUNS = ['Wombat', 'Pickle', 'Penguin', 'Pancake', 'Otter', 'Mango', 'Nugget', 'Turtle',
  'Potato', 'Llama', 'Doodle', 'Banana', 'Walrus', 'Noodle', 'Marshmallow', 'Jellybean'];
const COLORS = new Set(['#111111', '#000000', '#ef4444', '#2563eb', '#16a34a', '#9333ea']);
const FINISHED = new Set(['ready', 'revealed', 'results', 'cancelled']);

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

function freshState() {
  return { version: 1, event: null, players: [], game: null, round: null, display: 'lobby', usedWords: [], awards: [],
    cards: null, usedCardPrompts: [] };
}

function normalize(answer) {
  return answer.toLowerCase().replace(/[\s-]+/g, '').trim();
}

function ranked(players, scoreOf) {
  const entries = players.map(player => ({ id: player.id, name: player.name, score: scoreOf(player) }));
  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let rank = 0;
  let previous = null;
  return entries.map((entry, index) => {
    if (entry.score !== previous) rank = index + 1;
    previous = entry.score;
    return { ...entry, rank };
  });
}

class Engine {
  constructor({ state = freshState(), online = () => new Set(), random = randomInt, timing = {} } = {}) {
    this.state = state;
    this.state.awards ??= [];
    this.state.usedCardPrompts ??= [];
    this.online = online;
    this.random = random;
    this.timing = { selection: 4000, drawing: 30000, guessing: 30000, submissions: 30000, voting: 30000, ...timing };
  }

  player(id) {
    return this.state.players.find(player => player.id === id);
  }

  join(data, existingId) {
    const { event } = this.state;
    requireThat(event && event.status !== 'ended', 'The host has not opened an event.');
    const existing = this.player(existingId);
    if (existing) return existing;
    requireThat(data && VALID_VILLAS.has(data.room), 'Please select a valid resort room.');
    requireThat(typeof data.canDraw === 'boolean', 'Choose whether you would like to draw.');
    const occupied = new Set(this.state.players.map(player => player.name));
    const base = `${ADJECTIVES[this.random(ADJECTIVES.length)]} ${NOUNS[this.random(NOUNS.length)]}`;
    let name = base;
    let suffix = 2;
    while (occupied.has(name)) name = `${base} ${suffix++}`;
    const player = {
      id: randomUUID(), token: randomUUID(), name, room: data.room, canDraw: data.canDraw,
      excluded: false, eventScore: 0, gameScore: 0,
    };
    this.state.players.push(player);
    if (this.state.game?.type === 'family-cards' && this.state.game.status !== 'ended') this.dealHand(player.id);
    return player;
  }

  availableArtists() {
    const used = new Set(this.state.round?.contributors || []);
    const online = this.online();
    return this.state.players.filter(player => player.canDraw && !player.excluded &&
      online.has(player.id) && !used.has(player.id));
  }

  roundIn(...stages) {
    requireThat(this.state.round && stages.includes(this.state.round.stage),
      'That action is not available at this stage of the round.');
    return this.state.round;
  }

  assign(slotIndex, now) {
    const eligible = this.availableArtists();
    const slot = this.state.round.slots[slotIndex];
    if (!eligible.length) {
      slot.playerId = null;
      slot.status = 'review';
      slot.deadline = null;
      return false;
    }
    const player = eligible[this.random(eligible.length)];
    this.state.round.contributors.push(player.id);
    Object.assign(slot, {
      playerId: player.id, status: 'selecting', deadline: now + this.timing.selection,
      attempt: 1, drawing: [],
    });
    return true;
  }

  fail(slotIndex, now) {
    const round = this.state.round;
    const slot = round.slots[slotIndex];
    if (slot.attempt === 1) {
      Object.assign(slot, {
        attempt: 2, status: 'drawing', drawing: [], deadline: now + this.timing.drawing,
      });
    } else {
      this.player(slot.playerId).excluded = true;
      slot.drawing = [];
      this.assign(slotIndex, now);
    }
    this.updateDrawingStage();
  }

  updateDrawingStage() {
    const round = this.state.round;
    if (round.slots.some(slot => ['drawing', 'selecting'].includes(slot.status))) {
      round.stage = round.slots.every(slot => slot.status === 'selecting') ? 'selecting' : 'drawing';
    } else {
      round.stage = 'review';
    }
    round.deadline = null;
  }

  tick(now) {
    const round = this.state.round;
    if (!round) return false;
    if (this.state.game?.type === 'family-cards') {
      if (round.deadline === null || now < round.deadline) return false;
      if (round.stage === 'submitting') this.closeCardSubmissions(now);
      else if (round.stage === 'voting') this.closeCardVoting();
      else return false;
      return true;
    }
    let changed = false;
    if (['selecting', 'drawing', 'review'].includes(round.stage)) {
      for (const [index, slot] of round.slots.entries()) {
        if (slot.deadline === null || now < slot.deadline) continue;
        if (slot.status === 'selecting') {
          // A recovered event grants a full drawing attempt after selection, not an expired one.
          slot.status = 'drawing';
          slot.deadline = now + this.timing.drawing;
          changed = true;
        } else if (slot.status === 'drawing') {
          slot.deadline = null;
          if (slot.drawing.length) slot.status = 'review';
          else this.fail(index, now);
          changed = true;
        }
      }
      if (changed) this.updateDrawingStage();
    } else if (round.stage === 'guessing' && now >= round.deadline) {
      round.stage = 'awaiting-reveal';
      changed = true;
    }
    return changed;
  }

  dealHand(id) {
    const hands = this.state.cards.hands;
    const hand = hands[id] ??= [];
    while (hand.length < 10) {
      const available = CARDS.answers.map((_, index) => index).filter(index => !hand.includes(index));
      hand.push(available[this.random(available.length)]);
    }
    return hand;
  }

  startCardRound(now) {
    requireThat(this.state.players.filter(player => this.online().has(player.id)).length >= 2,
      'At least two connected players are needed.', 'NEED_PLAYERS');
    let available = CARDS.prompts.map((_, index) => index)
      .filter(index => !this.state.usedCardPrompts.includes(index));
    if (!available.length) {
      this.state.usedCardPrompts = [];
      available = CARDS.prompts.map((_, index) => index).filter(index => index !== this.state.round?.promptId);
    }
    const promptId = available[this.random(available.length)];
    this.state.usedCardPrompts.push(promptId);
    this.state.round = {
      id: randomUUID(), number: (this.state.round?.number || 0) + 1, promptId,
      stage: 'submitting', deadline: now + this.timing.submissions,
      participants: this.state.players.map(player => player.id), submissions: [], votes: [], results: [],
      awarded: false,
    };
    this.state.game.status = 'active';
    this.state.display = 'round';
  }

  closeCardSubmissions(now) {
    const round = this.roundIn('submitting');
    if (!round.submissions.length) {
      round.stage = 'cancelled';
      round.deadline = null;
      return;
    }
    for (let index = round.submissions.length - 1; index > 0; index--) {
      const other = this.random(index + 1);
      [round.submissions[index], round.submissions[other]] = [round.submissions[other], round.submissions[index]];
    }
    round.stage = 'voting';
    round.deadline = now + this.timing.voting;
    this.state.display = 'round';
  }

  closeCardVoting() {
    const round = this.roundIn('voting');
    const results = round.submissions.map(submission => ({
      ...submission, votes: round.votes.filter(vote => vote.submissionId === submission.id).length,
    })).sort((a, b) => b.votes - a.votes);
    let rank = 0;
    let previous = null;
    round.results = results.map((result, index) => {
      if (result.votes !== previous) rank = index + 1;
      previous = result.votes;
      const points = result.votes > 0 ? 6 - rank : 0;
      if (points) this.award(result.playerId, points, 'audience-vote');
      return { ...result, rank, points };
    });
    round.awarded = true;
    round.stage = 'revealed';
    round.deadline = null;
    this.state.display = 'round';
  }

  cardPlayerCommand(id, action, data, now) {
    requireThat(this.state.game.status !== 'ended', 'This game has ended.');
    if (action === 'submit-card') {
      const round = this.roundIn('submitting');
      requireThat(now < round.deadline, 'Submissions have closed.');
      requireThat(round.participants.includes(id), 'You can submit starting next round.');
      requireThat(!round.submissions.some(submission => submission.playerId === id), 'Your answer is already submitted.');
      const hand = this.state.cards.hands[id];
      requireThat(Number.isInteger(data.cardId) && hand?.includes(data.cardId), 'Choose a card from your hand.');
      round.submissions.push({ id: randomUUID(), playerId: id, cardId: data.cardId });
      // Draw before removing the played card so its replacement cannot be the same card.
      const available = CARDS.answers.map((_, index) => index).filter(index => !hand.includes(index));
      hand[hand.indexOf(data.cardId)] = available[this.random(available.length)];
      if (round.submissions.length === 5) this.closeCardSubmissions(now);
      return;
    }
    if (action === 'vote-card') {
      const round = this.roundIn('voting');
      requireThat(now < round.deadline, 'Voting has closed.');
      requireThat(!round.votes.some(vote => vote.playerId === id), 'Your vote is already recorded.');
      const submission = round.submissions.find(item => item.id === data.submissionId);
      requireThat(submission, 'Choose one of the finalist answers.');
      requireThat(submission.playerId !== id, 'You cannot vote for your own answer.');
      round.votes.push({ playerId: id, submissionId: submission.id });
      return;
    }
    throw new GameError('Unknown card-game player action.');
  }

  command(role, id, action, data = {}, now = Date.now()) {
    requireThat(data && typeof data === 'object' && !Array.isArray(data), 'Invalid command data.');
    if (role === 'host') return this.hostCommand(action, data, now);
    requireThat(role === 'player' && this.player(id), 'Join the event before playing.');
    return this.playerCommand(id, action, data, now);
  }

  hostCommand(action, data, now) {
    const state = this.state;
    switch (action) {
      case 'new-event': {
        requireThat(['standalone', 'variety'].includes(data.mode), 'Choose a valid event mode.');
        requireThat(data.title === undefined || typeof data.title === 'string', 'Event title must be text.');
        const title = data.title?.trim() || '';
        requireThat(title.length <= 80, 'Event title must be 80 characters or fewer.');
        this.state = freshState();
        this.state.event = {
          id: randomUUID(), title: title || (data.mode === 'variety' ? 'Variety Show' : 'Collaborative Sketch'),
          mode: data.mode, status: 'lobby',
        };
        return;
      }
      case 'start-game':
        requireThat(state.event && state.event.status !== 'ended', 'Open an event first.');
        requireThat(!state.game || state.game.status === 'ended', 'Conclude the current game first.');
        requireThat(!data.type || ['pictionary', 'family-cards'].includes(data.type), 'Choose an available game.');
        requireThat(!state.game || state.event.mode === 'variety', 'Start a new event for another standalone game.');
        state.game = { id: randomUUID(), type: data.type || 'pictionary', status: 'lobby', number: (state.game?.number || 0) + 1 };
        state.cards = state.game.type === 'family-cards' ? { hands: {} } : null;
        if (state.cards) state.players.forEach(player => this.dealHand(player.id));
        state.players.forEach(player => { player.gameScore = 0; player.excluded = false; });
        state.round = null;
        state.event.status = 'active';
        state.display = 'lobby';
        return;
      case 'start-round': {
        requireThat(state.game && state.game.status !== 'ended', 'Start a game first.');
        requireThat(!state.round || FINISHED.has(state.round.stage), 'Finish or cancel the current round first.');
        if (state.game.type === 'family-cards') return this.startCardRound(now);
        let words = WORDS.filter(word => !state.usedWords.includes(word[0]));
        if (!words.length) {
          state.usedWords = [];
          words = WORDS.filter(word => word[0] !== state.round?.answer);
        }
        const [answer, left, right] = words[this.random(words.length)];
        state.usedWords.push(answer);
        state.round = {
          id: randomUUID(), number: (state.round?.number || 0) + 1, stage: 'ready', deadline: null,
          answer, slots: [left, right].map(part => ({
            part, playerId: null, status: 'review', deadline: null, attempt: 1, drawing: [],
          })),
          contributors: [], guesses: [], guessActivity: {}, awarded: false,
        };
        state.game.status = 'active';
        state.display = 'round';
        return;
      }
      case 'select-players': {
        requireThat(state.game?.type === 'pictionary', 'Artist selection is only available in Big Draw.');
        const round = this.roundIn('ready');
        requireThat(this.availableArtists().length >= 2, 'At least two connected drawing volunteers are needed.', 'NEED_ARTISTS');
        this.assign(0, now);
        this.assign(1, now);
        round.stage = 'selecting';
        return;
      }
      case 'replace-artist':
        this.roundIn('review', 'drawing', 'selecting');
        requireThat(data.slot === 0 || data.slot === 1, 'Select a drawing half.');
        requireThat(!state.round.slots[data.slot].playerId, 'That half already has an artist.');
        requireThat(this.assign(data.slot, now), 'No connected eligible replacement is available.', 'NEED_ARTISTS');
        this.updateDrawingStage();
        return;
      case 'approve':
      case 'reject': {
        this.roundIn('drawing', 'review', 'selecting');
        requireThat(data.slot === 0 || data.slot === 1, 'Select a drawing half.');
        const slot = state.round.slots[data.slot];
        requireThat(slot.playerId && slot.status === 'review' && slot.drawing.length,
          'Only a submitted drawing can be reviewed.');
        if (action === 'approve') slot.status = 'approved';
        else this.fail(data.slot, now);
        this.updateDrawingStage();
        return;
      }
      case 'show': {
        const round = this.roundIn('review');
        requireThat(round.slots.every(slot => slot.status === 'approved'), 'Approve both drawings before showing them.');
        round.stage = 'guessing';
        round.deadline = now + this.timing.guessing;
        state.display = 'round';
        return;
      }
      case 'reveal': {
        const round = this.roundIn('awaiting-reveal');
        requireThat(!round.awarded, 'This round has already been scored.');
        round.guesses.slice(0, 5).forEach((guess, index) => this.award(guess.playerId, 5 - index, 'guess'));
        round.slots.forEach(slot => this.award(slot.playerId, 1, 'artist'));
        round.awarded = true;
        round.stage = 'revealed';
        state.display = 'round';
        return;
      }
      case 'round-results':
        this.roundIn('revealed', 'results').stage = 'results';
        state.display = 'round-results';
        return;
      case 'close-submissions':
        requireThat(state.game?.type === 'family-cards', 'Start the card game first.');
        return this.closeCardSubmissions(now);
      case 'close-voting':
        requireThat(state.game?.type === 'family-cards', 'Start the card game first.');
        return this.closeCardVoting();
      case 'scoreboard':
        requireThat(state.event, 'Open an event first.');
        state.display = 'scoreboard';
        return;
      case 'cancel-round':
        requireThat(state.round && !state.round.awarded && state.round.stage !== 'cancelled',
          'Only an unfinished, unscored round can be cancelled.');
        state.round.stage = 'cancelled';
        state.round.deadline = null;
        state.round.slots?.forEach(slot => { slot.deadline = null; });
        state.display = 'round';
        return;
      case 'end-game':
      case 'end-event': {
        requireThat(data.allowTie === undefined || typeof data.allowTie === 'boolean', 'Tie confirmation must be true or false.');
        requireThat(state.event && state.event.status !== 'ended', 'There is no active event to conclude.');
        if (action === 'end-game') requireThat(state.game && state.game.status !== 'ended', 'There is no active game to conclude.');
        requireThat(!state.round || FINISHED.has(state.round.stage), 'Reveal or cancel the round before concluding.');
        const eventFinal = action === 'end-event' || state.event.mode === 'standalone';
        const leaders = ranked(state.players, player => eventFinal ? player.eventScore : player.gameScore);
        const counts = new Map();
        leaders.filter(entry => entry.rank <= 3).forEach(entry => counts.set(entry.score, (counts.get(entry.score) || 0) + 1));
        if (!data.allowTie && [...counts.values()].some(count => count > 1)) {
          throw new GameError('Podium scores are tied. Conclude anyway or play one more round.', 409, 'TIE_CONFIRMATION');
        }
        if (state.game) state.game.status = 'ended';
        if (eventFinal) state.event.status = 'ended';
        state.display = eventFinal ? 'event-final' : 'game-final';
        return;
      }
      default:
        throw new GameError('Unknown host action.');
    }
  }

  award(id, points, reason) {
    const player = this.player(id);
    requireThat(player, 'Scoring participant is missing.');
    requireThat(!this.state.awards.some(award => award.roundId === this.state.round.id &&
      award.playerId === id && award.reason === reason), 'This contribution has already been scored.');
    this.state.awards.push({
      gameId: this.state.game.id, roundId: this.state.round.id, playerId: id, points, reason,
    });
    player.eventScore += points;
    player.gameScore += points;
  }

  playerCommand(id, action, data, now) {
    if (this.state.game?.type === 'family-cards') return this.cardPlayerCommand(id, action, data, now);
    if (action === 'guess') {
      const round = this.roundIn('guessing');
      requireThat(now < round.deadline, 'The answer period has ended.');
      requireThat(!round.contributors.includes(id), 'Artists cannot guess in a round whose word part they have seen.');
      requireThat(typeof data.answer === 'string' && data.answer.trim().length > 0 && data.answer.length <= 80,
        'Enter an answer of 80 characters or fewer.');
      requireThat(!round.guesses.some(guess => guess.playerId === id), 'Your correct answer has already been received.');
      const activity = round.guessActivity[id] || { count: 0, last: 0 };
      requireThat(now - activity.last >= 300 && activity.count < 60, 'Please wait before sending another answer.', 'RATE_LIMITED');
      round.guessActivity[id] = { count: activity.count + 1, last: now };
      if (normalize(data.answer) === normalize(round.answer)) round.guesses.push({ playerId: id, receivedAt: now });
      return;
    }
    const round = this.roundIn('drawing');
    const index = round.slots.findIndex(slot => slot.playerId === id && slot.status === 'drawing');
    requireThat(index !== -1, 'You do not have an active drawing attempt.');
    const slot = round.slots[index];
    requireThat(now < slot.deadline, 'Your drawing time has ended.');
    switch (action) {
      case 'stroke': {
        const stroke = data.stroke;
        requireThat(stroke && Array.isArray(stroke.points) && stroke.points.length >= 1 &&
          stroke.points.length <= 512 && COLORS.has(stroke.color) &&
          Number.isFinite(stroke.width) && stroke.width >= 0.003 && stroke.width <= 0.03,
        'Invalid drawing stroke.');
        requireThat(stroke.points.every(point => point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
          point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1), 'Drawing points must be inside the canvas.');
        requireThat(slot.drawing.length < 200 &&
          slot.drawing.reduce((sum, item) => sum + item.points.length, 0) + stroke.points.length <= 8000,
        'This drawing is full. Undo a stroke or submit it for review.');
        slot.drawing.push({
          points: stroke.points.map(({ x, y }) => ({ x, y })), color: stroke.color, width: stroke.width,
        });
        return;
      }
      case 'undo':
        slot.drawing.pop();
        return;
      case 'clear':
        slot.drawing = [];
        return;
      case 'finish':
        slot.deadline = null;
        if (slot.drawing.length) slot.status = 'review';
        else this.fail(index, now);
        this.updateDrawingStage();
        return;
      default:
        throw new GameError('Unknown player action.');
    }
  }

  view(role = 'display', id = null, now = Date.now()) {
    const state = this.state;
    const me = this.player(id);
    const publicDrawing = state.round && ['guessing', 'awaiting-reveal', 'revealed', 'results'].includes(state.round.stage);
    const revealed = state.round && ['revealed', 'results'].includes(state.round.stage);
    const exposePlayer = player => ({
      id: player.id, name: player.name, online: this.online().has(player.id),
      canDraw: player.canDraw, excluded: player.excluded,
      eventScore: player.eventScore, gameScore: player.gameScore,
      ...(role === 'host' ? { room: player.room } : {}),
    });
    const cardGame = state.game?.type === 'family-cards';
    const cardRevealed = cardGame && revealed;
    return {
      serverTime: now, role, event: state.event && { ...state.event },
      game: state.game && { ...state.game }, display: state.display,
      joinOpen: Boolean(state.event && state.event.status !== 'ended'),
      players: state.players.map(exposePlayer),
      me: me ? {
        ...exposePlayer(me), room: me.room,
        artistSlot: state.round?.slots?.findIndex(slot => slot.playerId === id) >= 0 ?
          state.round.slots.findIndex(slot => slot.playerId === id) : null,
        correct: Boolean(state.round?.guesses?.some(guess => guess.playerId === id)),
        hasContributed: Boolean(state.round?.contributors?.includes(id)),
        ...(cardGame ? {
          hand: (state.cards.hands[id] || []).map(cardId => ({ id: cardId, text: CARDS.answers[cardId] })),
          canSubmit: Boolean(state.round?.stage === 'submitting' && state.round.participants.includes(id)),
          submitted: Boolean(state.round?.submissions.some(submission => submission.playerId === id)),
          votedFor: state.round?.votes.find(vote => vote.playerId === id)?.submissionId || null,
          ownSubmissionId: state.round?.submissions.find(submission => submission.playerId === id)?.id || null,
        } : {}),
      } : null,
      round: state.round ? cardGame ? {
        id: state.round.id, number: state.round.number, stage: state.round.stage, deadline: state.round.deadline,
        prompt: CARDS.prompts[state.round.promptId],
        submissionCount: state.round.submissions.length, voteCount: state.round.votes.length,
        finalists: ['voting', 'revealed', 'results'].includes(state.round.stage) ?
          state.round.submissions.map(submission => ({
            id: submission.id, text: CARDS.answers[submission.cardId],
            ...(cardRevealed ? {
              name: this.player(submission.playerId).name,
              votes: state.round.results.find(result => result.id === submission.id).votes,
              points: state.round.results.find(result => result.id === submission.id).points,
            } : {}),
          })) : [],
      } : {
        id: state.round.id, number: state.round.number, stage: state.round.stage, deadline: state.round.deadline,
        answer: role === 'host' || revealed ? state.round.answer : null,
        slots: state.round.slots.map(slot => ({
          playerId: slot.playerId, name: this.player(slot.playerId)?.name || 'Replacement needed',
          status: slot.status, attempt: slot.attempt, deadline: slot.deadline,
          part: role === 'host' || (id && slot.playerId === id) ? slot.part : null,
          drawing: role === 'host' || publicDrawing || (id && slot.playerId === id) ? slot.drawing : [],
        })),
      } : null,
      leaderboards: {
        event: ranked(state.players, player => player.eventScore),
        game: ranked(state.players, player => player.gameScore),
        round: cardGame ? cardRevealed ? state.round.results.filter(result => result.points > 0).map(result => ({
          id: result.playerId, name: this.player(result.playerId).name, score: result.points, rank: result.rank,
        })) : [] : revealed ? state.round.guesses.slice(0, 5).map((guess, index) => ({
          id: guess.playerId, name: this.player(guess.playerId).name, score: 5 - index, rank: index + 1,
        })) : [],
      },
    };
  }
}

module.exports = { Engine, GameError, freshState, normalize, ranked };
