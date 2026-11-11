'use strict';

const { randomUUID } = require('node:crypto');
const { GameError, requireThat } = require('./game-error');
const { moderateCaption } = require('./caption-filter');
const { imageLibrary, imageInfo } = require('./picture-images');

class PictureGame {
  constructor(engine) {
    this.engine = engine;
  }

  get state() { return this.engine.state; }
  get round() { return this.state.round; }

  shuffle(items) {
    for (let index = items.length - 1; index > 0; index--) {
      const other = this.engine.random(index + 1);
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
  }

  startRound(data) {
    const online = this.engine.online();
    const participants = this.state.players.filter(player => online.has(player.id)).map(player => player.id);
    requireThat(participants.length >= 2 && participants.length <= 100,
      'Get The Picture needs 2 to 100 connected players.', 'NEED_PLAYERS');
    let available = imageLibrary(this.state).filter(image => image.enabled);
    requireThat(available.length, 'Enable or upload at least one image.');
    if (data.imageId) {
      available = available.filter(image => image.id === data.imageId);
      requireThat(available.length, 'Choose an enabled image from the library.');
    } else {
      const unused = available.filter(image => !this.state.usedPictureImages.includes(image.id));
      if (unused.length) available = unused;
      else {
        this.state.usedPictureImages = [];
        if (available.length > 1) available = available.filter(image => image.id !== this.round?.image.id);
      }
    }
    const image = available[this.engine.random(available.length)];
    this.state.usedPictureImages.push(image.id);
    const groups = [];
    if (this.state.game.pictureMode === 'poolside') {
      const count = Math.ceil(participants.length / 10);
      const previous = new Set(this.round?.groups.map(group => group.judgeId) || []);
      const selected = new Set();
      for (let index = 0; index < count; index++) {
        const fresh = participants.filter(id => !selected.has(id) && !previous.has(id));
        const eligible = fresh.length ? fresh : participants.filter(id => !selected.has(id));
        const least = Math.min(...eligible.map(id => this.state.pictureJudgeCounts[id] || 0));
        const pool = eligible.filter(id => (this.state.pictureJudgeCounts[id] || 0) === least);
        const judgeId = pool[this.engine.random(pool.length)];
        selected.add(judgeId);
        this.state.pictureJudgeCounts[judgeId] = (this.state.pictureJudgeCounts[judgeId] || 0) + 1;
        groups.push({ id: randomUUID(), members: [judgeId], judgeId, selectedId: null });
      }
      this.shuffle(participants.filter(id => !selected.has(id)))
        .forEach((id, index) => groups[index % count].members.push(id));
    }
    this.state.round = {
      id: randomUUID(), number: (this.round?.number || 0) + 1, image: imageInfo(image),
      stage: 'loading', deadline: null, participants, ready: [], groups, submissions: [], votes: [],
      results: [], awarded: false,
    };
    this.state.game.status = 'active';
    this.state.display = 'round';
  }

  startCaptions(now) {
    const round = this.engine.roundIn('loading');
    round.stage = 'captioning';
    round.deadline = now + this.engine.timing.submissions;
    this.state.display = 'round';
  }

  closeSubmissions(now) {
    const round = this.engine.roundIn('captioning');
    round.deadline = null;
    if (!round.submissions.length) {
      round.stage = 'cancelled';
    } else if (this.state.game.pictureMode === 'small') {
      this.openVoting(now);
    } else if (this.state.game.pictureMode === 'large') {
      round.stage = 'reviewing';
    } else {
      round.stage = 'judging';
      round.deadline = now + this.engine.timing.judging;
    }
  }

  openVoting(now) {
    const round = this.engine.roundIn('captioning', 'reviewing', 'judging');
    let entries;
    if (this.state.game.pictureMode === 'large') entries = round.submissions.filter(entry => entry.approved && !entry.removed);
    else if (this.state.game.pictureMode === 'poolside') {
      const nominees = new Set(round.groups.map(group => group.selectedId));
      entries = round.submissions.filter(entry => nominees.has(entry.id) && !entry.removed);
    } else entries = round.submissions.filter(entry => !entry.removed);
    round.finalistIds = this.shuffle(entries.map(entry => entry.id));
    round.stage = entries.length ? 'voting' : 'cancelled';
    round.deadline = entries.length ? now + this.engine.timing.voting : null;
    this.state.display = 'round';
  }

  closeVoting() {
    const round = this.engine.roundIn('voting');
    const results = round.submissions.filter(entry => round.finalistIds.includes(entry.id) && !entry.removed)
      .map(entry => ({ ...entry, votes: round.votes.filter(vote => vote.submissionId === entry.id).length }))
      .sort((a, b) => b.votes - a.votes);
    let rank = 0;
    let previous = null;
    round.results = results.map((entry, index) => {
      if (entry.votes !== previous) rank = index + 1;
      previous = entry.votes;
      const points = entry.votes > 0 ? Math.max(0, 6 - rank) : 0;
      if (points) this.engine.award(entry.playerId, points, 'caption-vote');
      return { ...entry, rank, points };
    });
    round.stage = 'revealed';
    round.deadline = null;
    round.awarded = true;
    this.state.display = 'round';
  }

  tick(now) {
    if (!this.round || this.round.deadline === null || now < this.round.deadline) return false;
    if (this.round.stage === 'captioning') this.closeSubmissions(now);
    else if (this.round.stage === 'judging') this.openVoting(now);
    else if (this.round.stage === 'voting') this.closeVoting();
    else return false;
    return true;
  }

  hostCommand(action, data, now) {
    switch (action) {
      case 'start-caption-timer': return this.startCaptions(now);
      case 'close-submissions': return this.closeSubmissions(now);
      case 'open-picture-voting':
        this.engine.roundIn('reviewing', 'judging');
        return this.openVoting(now);
      case 'close-voting': return this.closeVoting();
      case 'review-caption': {
        const round = this.engine.roundIn('captioning', 'reviewing', 'judging', 'voting');
        const entry = round.submissions.find(item => item.id === data.submissionId);
        requireThat(entry, 'Choose an existing caption.');
        requireThat(['approve', 'remove'].includes(data.decision), 'Choose approve or remove.');
        if (data.decision === 'approve') {
          requireThat(this.state.game.pictureMode === 'large' && ['captioning', 'reviewing'].includes(round.stage) && !entry.removed,
            'Only pending large-audience captions can be approved.');
          entry.approved = true;
        } else {
          entry.removed = true;
          entry.approved = false;
          // A withdrawn ballot may be recast, but cannot count toward a removed entry.
          round.votes = round.votes.filter(vote => vote.submissionId !== entry.id);
          round.groups.forEach(group => { if (group.selectedId === entry.id) group.selectedId = null; });
        }
        return;
      }
      default: throw new GameError('Unknown caption-game host action.');
    }
  }

  playerCommand(id, action, data, now) {
    requireThat(this.state.game.status !== 'ended', 'This game has ended.');
    if (action === 'picture-ready') {
      const round = this.engine.roundIn('loading', 'captioning');
      requireThat(round.participants.includes(id), 'You can submit starting next round.');
      if (!round.ready.includes(id)) round.ready.push(id);
      return;
    }
    if (action === 'submit-caption') {
      const round = this.engine.roundIn('captioning');
      requireThat(now < round.deadline, 'Captions have closed.');
      requireThat(round.participants.includes(id), 'You can submit starting next round.');
      requireThat(!round.submissions.some(entry => entry.playerId === id), 'Your caption is already submitted.');
      requireThat(typeof data.text === 'string' && data.text.trim().length > 0 && data.text.length <= 160 &&
        !/[\u0000-\u001f\u007f]/.test(data.text), 'Enter a caption of 1 to 160 characters on one line.');
      const rejection = moderateCaption(data.text, this.state.pictureBlockedTerms);
      if (rejection) throw new GameError(rejection, 400, 'CAPTION_REJECTED');
      round.submissions.push({ id: randomUUID(), playerId: id, text: data.text.trim(), approved: false, removed: false });
      return;
    }
    if (action === 'nominate-caption') {
      const round = this.engine.roundIn('judging');
      requireThat(now < round.deadline, 'Judging has closed.');
      const group = round.groups.find(item => item.judgeId === id);
      requireThat(group && !group.selectedId, 'Only the selected judge can nominate once for this group.');
      const entry = round.submissions.find(item => item.id === data.submissionId && !item.removed);
      requireThat(entry && group.members.includes(entry.playerId) && entry.playerId !== id,
        'Choose another player’s caption from your group.');
      group.selectedId = entry.id;
      const done = round.groups.every(item => item.selectedId || !round.submissions.some(entry =>
        !entry.removed && item.members.includes(entry.playerId) && entry.playerId !== item.judgeId));
      if (done) this.openVoting(now);
      return;
    }
    if (action === 'vote-caption') {
      const round = this.engine.roundIn('voting');
      requireThat(now < round.deadline, 'Voting has closed.');
      requireThat(!round.votes.some(vote => vote.playerId === id), 'Your vote is already recorded.');
      const entry = round.submissions.find(item => item.id === data.submissionId && !item.removed &&
        round.finalistIds.includes(item.id));
      requireThat(entry, 'Choose one of the finalist captions.');
      requireThat(entry.playerId !== id, 'You cannot vote for your own caption.');
      round.votes.push({ playerId: id, submissionId: entry.id });
      return;
    }
    throw new GameError('Unknown caption-game player action.');
  }

  view(role, id) {
    const round = this.round;
    if (!round) return { round: null, me: {}, leaders: [] };
    const revealed = ['revealed', 'results'].includes(round.stage);
    const own = round.submissions.find(entry => entry.playerId === id);
    const group = round.groups.find(item => item.members.includes(id));
    const visible = round.submissions.filter(entry => !entry.removed);
    const expose = entry => ({ id: entry.id, text: entry.text });
    const publicEntries = ['voting', 'revealed', 'results'].includes(round.stage) ?
      (round.finalistIds || []).map(key => visible.find(entry => entry.id === key)).filter(Boolean) : [];
    return {
      me: {
        canSubmit: round.stage === 'captioning' && round.participants.includes(id),
        submitted: Boolean(own), ownCaption: own?.text || null, captionRemoved: Boolean(own?.removed),
        ownSubmissionId: own?.id || null, votedFor: round.votes.find(vote => vote.playerId === id)?.submissionId || null,
        imageReady: round.ready.includes(id), participant: round.participants.includes(id),
        groupNumber: group ? round.groups.indexOf(group) + 1 : null,
        isJudge: group?.judgeId === id, nominated: Boolean(group?.selectedId),
        judgeChoices: round.stage === 'judging' && group?.judgeId === id ?
          visible.filter(entry => group.members.includes(entry.playerId) && entry.playerId !== id).map(expose) : [],
      },
      round: {
        id: round.id, number: round.number, stage: round.stage, deadline: round.deadline, image: round.image,
        submissionCount: visible.length, voteCount: round.votes.length,
        readyCount: round.ready.length, participantCount: round.participants.length,
        nominatedCount: round.groups.filter(item => item.selectedId).length, groupCount: round.groups.length,
        finalists: publicEntries.map(entry => ({
          ...expose(entry),
          ...(revealed ? {
            name: this.engine.player(entry.playerId).name,
            votes: round.results.find(result => result.id === entry.id).votes,
            points: round.results.find(result => result.id === entry.id).points,
          } : {}),
        })),
        ...(role === 'host' ? {
          review: round.submissions.map(entry => ({ ...expose(entry), approved: entry.approved, removed: entry.removed })),
          groups: round.groups.map((item, index) => ({
            number: index + 1, judge: this.engine.player(item.judgeId).name, nominated: Boolean(item.selectedId),
            choiceCount: visible.filter(entry => item.members.includes(entry.playerId) && entry.playerId !== item.judgeId).length,
          })),
        } : {}),
      },
      leaders: revealed ? round.results.filter(entry => entry.points > 0).map(entry => ({
        id: entry.playerId, name: this.engine.player(entry.playerId).name, score: entry.points, rank: entry.rank,
      })) : [],
    };
  }
}

module.exports = { PictureGame };
