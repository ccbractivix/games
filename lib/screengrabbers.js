'use strict';

const { randomUUID } = require('node:crypto');
const { GameError, requireThat } = require('./game-error');

function validateQuestion(data, images) {
  requireThat(images.some(image => image.id === data.imageId), 'Choose an image from the Screengrabbers album.');
  requireThat(typeof data.prompt === 'string' && data.prompt.trim() && data.prompt.length <= 240,
    'Enter a question of 1 to 240 characters.');
  requireThat(Array.isArray(data.options) && data.options.length >= 2 && data.options.length <= 6 &&
    data.options.every(option => typeof option === 'string' && option.trim() && option.length <= 120),
  'Provide 2 to 6 answer choices, each 1 to 120 characters.');
  const options = data.options.map(option => option.trim());
  requireThat(new Set(options.map(option => option.toLowerCase())).size === options.length,
    'Answer choices must be distinct.');
  requireThat(Number.isInteger(data.correctChoice) && data.correctChoice >= 0 && data.correctChoice < options.length,
    'Mark one answer choice as correct.');
  return { imageId: data.imageId, prompt: data.prompt.trim(), options, correctChoice: data.correctChoice };
}

class Screengrabbers {
  constructor(engine) { this.engine = engine; }
  get state() { return this.engine.state; }
  get round() { return this.state.round; }

  libraryCommand(action, data) {
    if (action === 'save-screengrabber-question') {
      const question = validateQuestion(data, this.state.screengrabberImages);
      if (data.questionId) {
        const existing = this.state.screengrabberQuestions.find(item => item.id === data.questionId);
        requireThat(existing, 'Choose an existing question to edit.');
        Object.assign(existing, question);
      } else {
        requireThat(this.state.screengrabberQuestions.length < 1000, 'The question library is full (1,000 questions). Edit existing questions instead.');
        this.state.screengrabberQuestions.push({ id: randomUUID(), enabled: true, ...question });
      }
      return;
    }
    const imageAction = action === 'set-screengrabber-image';
    const items = imageAction ? this.state.screengrabberImages : this.state.screengrabberQuestions;
    const item = items.find(entry => entry.id === (imageAction ? data.imageId : data.questionId));
    requireThat(item, imageAction ? 'Choose an image from the album.' : 'Choose a question from the library.');
    requireThat(typeof data.enabled === 'boolean', 'Choose whether this library item is enabled.');
    item.enabled = data.enabled;
  }

  startRound() {
    const online = this.engine.online();
    const participants = this.state.players.filter(player => online.has(player.id)).map(player => player.id);
    requireThat(participants.length >= 2 && participants.length <= 100,
      'Screengrabbers needs 2 to 100 connected players.', 'NEED_PLAYERS');
    const images = this.state.screengrabberImages.filter(image => image.enabled);
    let available = this.state.screengrabberQuestions.filter(question =>
      question.enabled && images.some(image => image.id === question.imageId));
    requireThat(available.length, 'Upload an image and save at least one enabled question in the Screengrabbers library.');
    const unused = available.filter(question => !this.state.usedScreengrabberQuestions.includes(question.id));
    if (unused.length) available = unused;
    else {
      this.state.usedScreengrabberQuestions = [];
      if (available.length > 1) available = available.filter(question => question.id !== this.round?.question.id);
    }
    const question = available[this.engine.random(available.length)];
    const image = images.find(item => item.id === question.imageId);
    this.state.usedScreengrabberQuestions.push(question.id);
    this.state.round = {
      id: randomUUID(), number: (this.round?.number || 0) + 1,
      question: structuredClone(question),
      image: { id: image.id, alt: image.alt, credit: image.credit,
        url: `/api/screengrabber-images/${encodeURIComponent(image.id)}/file` },
      stage: 'loading', deadline: null, participants, ready: [], submissions: [], results: [], awarded: false,
    };
    this.state.game.status = 'active';
    this.state.display = 'round';
  }

  hostCommand(action, _data, now) {
    if (action === 'start-screengrabber-timer') {
      const round = this.engine.roundIn('loading');
      round.stage = 'answering';
      round.deadline = now + this.engine.timing.screengrabbers;
    } else if (action === 'close-screengrabber-answers') {
      const round = this.engine.roundIn('answering');
      round.stage = 'awaiting-reveal';
      round.deadline = null;
    } else if (action === 'reveal') {
      const round = this.engine.roundIn('awaiting-reveal');
      requireThat(!round.awarded, 'This round has already been scored.');
      round.results = round.submissions.filter(entry => entry.choice === round.question.correctChoice)
        .map((entry, index) => {
          const points = 1 + Math.max(0, 5 - index);
          this.engine.award(entry.playerId, points, 'screengrabber-answer');
          return { playerId: entry.playerId, rank: index + 1, points, receivedAt: entry.receivedAt };
        });
      round.awarded = true;
      round.stage = 'revealed';
      round.deadline = null;
    } else throw new GameError('Unknown Screengrabbers host action.');
    this.state.display = 'round';
  }

  tick(now) {
    if (this.round?.stage !== 'answering' || now < this.round.deadline) return false;
    this.hostCommand('close-screengrabber-answers', {}, now);
    return true;
  }

  playerCommand(id, action, data, now) {
    requireThat(this.state.game.status !== 'ended', 'This game has ended.');
    const round = this.engine.roundIn('loading', 'answering');
    requireThat(data.roundId === round.id, 'This question has changed. Refresh before answering.');
    requireThat(round.participants.includes(id), 'You can answer starting next round.');
    if (action === 'screengrabber-ready') {
      if (!round.ready.includes(id)) round.ready.push(id);
      return;
    }
    requireThat(action === 'submit-screengrabber-answer', 'Unknown Screengrabbers player action.');
    requireThat(round.stage === 'answering' && now < round.deadline, 'Answers are not open.');
    requireThat(!round.submissions.some(entry => entry.playerId === id), 'Your first answer is final and already recorded.');
    requireThat(Number.isInteger(data.choice) && data.choice >= 0 && data.choice < round.question.options.length,
      'Choose one of the displayed answers.');
    round.submissions.push({ playerId: id, choice: data.choice, receivedAt: now });
  }

  view(role, id) {
    const round = this.round;
    if (!round) return { round: null, me: {}, leaders: [] };
    const revealed = ['revealed', 'results'].includes(round.stage);
    const visible = role === 'host' || round.stage !== 'loading';
    const own = round.submissions.find(entry => entry.playerId === id);
    return {
      me: {
        participant: round.participants.includes(id), imageReady: round.ready.includes(id),
        submitted: Boolean(own), answerChoice: own?.choice ?? null,
        canSubmit: round.stage === 'answering' && round.participants.includes(id) && !own,
        correct: revealed ? own?.choice === round.question.correctChoice : null,
      },
      round: {
        id: round.id, number: round.number, stage: round.stage, deadline: round.deadline,
        image: { id: round.image.id, url: round.image.url,
          alt: visible ? round.image.alt : 'The next Screengrabbers image',
          ...(revealed || role === 'host' ? { credit: round.image.credit } : {}) },
        prompt: visible ? round.question.prompt : null,
        options: visible ? [...round.question.options] : [],
        correctChoice: revealed || role === 'host' ? round.question.correctChoice : null,
        submissionCount: round.submissions.length, participantCount: round.participants.length,
        readyCount: round.ready.length,
      },
      leaders: revealed ? round.results.map(entry => ({
        id: entry.playerId, name: this.engine.player(entry.playerId).name, rank: entry.rank, score: entry.points,
      })) : [],
    };
  }
}

module.exports = { Screengrabbers, validateQuestion };
