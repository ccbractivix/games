'use strict';

const { randomUUID } = require('node:crypto');
const { requireThat } = require('./game-error');
const { Screengrabbers } = require('./screengrabbers');

function validateQuestion(data, images) {
  requireThat(typeof data.prompt === 'string' && data.prompt.trim() && data.prompt.length <= 240,
    'Enter a headline of 1 to 240 characters.');
  requireThat(Array.isArray(data.choices) && data.choices.length >= 2 && data.choices.length <= 4,
    'Choose 2 to 4 face images.');
  requireThat(data.choices.every(choice => choice && images.some(image => image.id === choice.imageId) &&
    Number.isFinite(choice.x) && choice.x >= 0 && choice.x <= 100 &&
    Number.isFinite(choice.y) && choice.y >= 0 && choice.y <= 100),
  'Choose an album image and a focal position between 0 and 100 for every panel.');
  requireThat(new Set(data.choices.map(choice => choice.imageId)).size === data.choices.length,
    'Use a different image in each panel.');
  requireThat(Number.isInteger(data.correctChoice) && data.correctChoice >= 0 && data.correctChoice < data.choices.length,
    'Click a preview photo to mark the correct answer.');
  requireThat(data.revealName === undefined || (typeof data.revealName === 'string' && data.revealName.length <= 120),
    'The reveal name must be at most 120 characters.');
  requireThat(data.explanation === undefined || (typeof data.explanation === 'string' && data.explanation.length <= 600),
    'The reveal explanation must be at most 600 characters.');
  return {
    prompt: data.prompt.trim(),
    choices: data.choices.map(({ imageId, x, y }) => ({ imageId, x, y })),
    correctChoice: data.correctChoice, revealName: (data.revealName || '').trim(),
    explanation: (data.explanation || '').trim(),
  };
}

class Lineup extends Screengrabbers {
  constructor(engine) { super(engine, 'Lineup', 'lineup'); }
  get choiceCount() { return this.round.question.choices.length; }

  libraryCommand(action, data) {
    if (action === 'save-lineup-question') {
      const question = validateQuestion(data, this.state.lineupImages);
      if (data.questionId) {
        const existing = this.state.lineupQuestions.find(item => item.id === data.questionId);
        requireThat(existing, 'Choose an existing question to edit.');
        Object.assign(existing, question);
      } else {
        requireThat(this.state.lineupQuestions.length < 1000, 'The question library is full (1,000 questions). Edit existing questions instead.');
        this.state.lineupQuestions.push({ id: randomUUID(), enabled: true, ...question });
      }
      return;
    }
    const imageAction = action === 'set-lineup-image';
    const items = imageAction ? this.state.lineupImages : this.state.lineupQuestions;
    const item = items.find(entry => entry.id === (imageAction ? data.imageId : data.questionId));
    requireThat(item, imageAction ? 'Choose an image from the album.' : 'Choose a question from the library.');
    requireThat(typeof data.enabled === 'boolean', 'Choose whether this library item is enabled.');
    item.enabled = data.enabled;
  }

  startRound() {
    const online = this.engine.online();
    const participants = this.state.players.filter(player => online.has(player.id)).map(player => player.id);
    requireThat(participants.length >= 2 && participants.length <= 100, 'Lineup needs 2 to 100 connected players.', 'NEED_PLAYERS');
    let available = this.state.lineupQuestions.filter(question => question.enabled &&
      question.choices.every(choice => this.state.lineupImages.some(image => image.id === choice.imageId && image.enabled)));
    requireThat(available.length, 'Save an enabled Lineup question with 2 to 4 enabled face images first.');
    const unused = available.filter(question => !this.state.usedLineupQuestions.includes(question.id));
    if (unused.length) available = unused;
    else {
      this.state.usedLineupQuestions = [];
      if (available.length > 1) available = available.filter(question => question.id !== this.round?.question.id);
    }
    const question = available[this.engine.random(available.length)];
    const images = question.choices.map(choice => {
      const image = this.state.lineupImages.find(item => item.id === choice.imageId);
      return { id: image.id, alt: image.alt, credit: image.credit, x: choice.x, y: choice.y,
        url: `/api/lineup-images/${encodeURIComponent(image.id)}/file` };
    });
    this.state.usedLineupQuestions.push(question.id);
    this.state.round = {
      id: randomUUID(), number: (this.round?.number || 0) + 1,
      question: structuredClone(question), images, stage: 'loading', deadline: null,
      participants, ready: [], submissions: [], results: [], awarded: false,
    };
    this.state.game.status = 'active';
    this.state.display = 'round';
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
        images: round.images.map((image, index) => ({
          id: image.id, url: image.url, x: image.x, y: image.y,
          alt: visible ? image.alt : `The next Lineup photo ${index + 1}`,
          ...(revealed || role === 'host' ? { credit: image.credit } : {}),
        })),
        prompt: visible ? round.question.prompt : null,
        correctChoice: revealed || role === 'host' ? round.question.correctChoice : null,
        ...(revealed || role === 'host' ? {
          revealName: round.question.revealName, explanation: round.question.explanation,
        } : {}),
        submissionCount: round.submissions.length, participantCount: round.participants.length,
        readyCount: round.ready.length,
      },
      leaders: revealed ? round.results.map(entry => ({
        id: entry.playerId, name: this.engine.player(entry.playerId).name, rank: entry.rank, score: entry.points,
      })) : [],
    };
  }
}

module.exports = { Lineup, validateQuestion };
