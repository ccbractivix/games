/* Plain-browser client. The server owns names, roles, timings, eligibility and scores. */
(() => {
  'use strict';
  const page = document.body.dataset.page;
  const app = document.getElementById('app');
  const connection = document.getElementById('connection');
  const notice = document.getElementById('notice');
  const dialog = document.getElementById('confirm-dialog');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const publicStages = new Set(['guessing', 'awaiting-reveal', 'revealed', 'results']);
  let state = null;
  let socket = null;
  let offset = 0;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let noticeTimer = null;
  let busy = false;
  let signature = '';
  let picker = null;
  let draft = null;
  let optimistic = [];
  let requestSequence = 0;
  let fetchedSequence = 0;
  let stateRevision = 0;
  let captionDraft = { roundId: null, text: '' };
  let pictureModeChoice = 'small';
  let pictureImageChoice = '';
  let imageManagerOpen = false;
  let policyDraft = null;
  let displayCaptionPage = 0;
  const readyReports = new Set();
  const loadedPictures = new Set();
  const uploadDraft = { file: null, title: '', alt: '', credit: '', permission: false };
  const requests = new Map();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const isHost = () => page === 'host' && state?.role === 'host';
  const isCards = () => state?.game?.type === 'family-cards';
  const isPicture = () => state?.game?.type === 'get-the-picture';
  const gameTitle = () => isPicture() ? 'Get The Picture' : isCards() ? 'Family Cards' : 'Pictionary';
  const connected = () => socket?.readyState === WebSocket.OPEN;
  const shown = () => publicStages.has(state?.round?.stage);
  const timeLeft = deadline => Math.max(0, Math.ceil((deadline - (Date.now() + offset)) / 1000));
  const disabled = condition => condition || busy ? ' disabled' : '';
  const button = (action, label, condition = false, style = '', data = {}) => `<button type="button" class="${style}" data-action="${action}" data-payload="${escape(JSON.stringify(data))}"${disabled(condition)}>${label}</button>`;
  const timer = deadline => deadline ? `<span class="timer" data-deadline="${deadline}" aria-label="Time remaining">◷ <span>${timeLeft(deadline)}s</span></span>` : '';

  function notify(message, sticky = false) {
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.hidden = false;
    if (!sticky) noticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
  }

  async function api(path, data, uploadType = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), uploadType ? 60000 : 15000);
    let response;
    try {
      response = await fetch(path, {
        method: data === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: data === undefined ? {} : { 'Content-Type': uploadType || 'application/json' },
        body: data === undefined ? undefined : uploadType ? data : JSON.stringify(data)
      });
    } catch (error) {
      throw new Error(error.name === 'AbortError' ? 'The server took too long to respond. Refreshing will check whether your change saved.' : 'Cannot reach the server. Check your connection and try again.');
    } finally { clearTimeout(timeout); }
    let result;
    try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
    if (!response.ok) {
      const error = new Error(result.error || 'Something went wrong. Please try again.');
      error.code = result.code;
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function refresh() {
    const sequence = ++fetchedSequence;
    const revision = stateRevision;
    try {
      const next = await api(`/api/state${page === 'display' ? '?display=1' : ''}`);
      if (sequence === fetchedSequence && revision === stateRevision) receive(next);
    } catch (error) {
      notify(`Cannot load the game: ${error.message}`);
      if (!state) app.innerHTML = '<section class="card loading"><h1>We lost the party connection.</h1><p>Check your internet connection, then try again.</p><button id="retry-load">Try again</button></section>';
      document.getElementById('retry-load')?.addEventListener('click', refresh);
    }
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    connection.className = 'connection';
    connection.textContent = reconnectAttempt ? 'Reconnecting…' : 'Connecting…';
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws${page === 'display' ? '?display=1' : ''}`);
    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      connection.className = 'connection live';
      connection.textContent = 'Live';
      refresh();
      updateDrawControls();
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { notify('An unreadable live update was received. Refreshing the game.'); refresh(); return; }
      if (message.type === 'state') receive(message.state);
      if (message.type === 'ack') {
        const request = requests.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timeout);
        requests.delete(message.requestId);
        if (message.ok) request.resolve();
        else {
          const error = new Error(message.error || 'The drawing change was not accepted.');
          error.code = message.code;
          request.reject(error);
        }
      }
    });
    socket.addEventListener('error', () => {
      connection.textContent = 'Connection trouble';
    });
    socket.addEventListener('close', () => {
      connection.className = 'connection';
      connection.textContent = 'Offline · retrying';
      for (const request of requests.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error('Connection lost. That drawing change may not have saved.'));
      }
      requests.clear();
      if (draft || optimistic.length) notify('Connection lost. Some ink was not saved. Check your drawing after reconnecting and redraw any missing lines.', true);
      optimistic = [];
      draft = null;
      drawAll();
      updateDrawControls();
      reconnectTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** reconnectAttempt++));
    });
  }

  function socketCommand(action, data = {}) {
    return new Promise((resolve, reject) => {
      if (!connected()) { reject(new Error('You are offline. Drawing will be available when we reconnect.')); return; }
      const requestId = `draw-${Date.now()}-${++requestSequence}`;
      const timeout = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error('The drawing server did not respond. Your change may not have saved; reconnecting to check.'));
        socket.close();
      }, 10000);
      requests.set(requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ type: 'command', requestId, action, data }));
    });
  }

  function receive(next) {
    if (!next || typeof next.serverTime !== 'number' || (state && next.serverTime < state.serverTime)) return;
    stateRevision++;
    const previous = state;
    state = next;
    if (isHost() && pictureImageChoice && !state.pictureImages.some(image => image.id === pictureImageChoice && image.enabled)) {
      pictureImageChoice = '';
    }
    const title = isPicture() ? 'Get The Picture' : isCards() ? 'Family Cards' : 'The Big Draw';
    document.querySelector('.brand-name').textContent = title;
    document.querySelector('.brand-icon').textContent = isPicture() ? '▣' : isCards() ? '5' : '✎';
    document.title = `${page === 'host' ? 'Host studio' : page === 'player' ? 'Guest play' : 'Big screen'} · ${title}`;
    offset = next.serverTime - Date.now();
    if (previous?.round?.id !== next.round?.id || previous?.me?.artistSlot !== next.me?.artistSlot) {
      draft = null;
      optimistic = [];
      captionDraft = { roundId: next.round?.id || null, text: '' };
      displayCaptionPage = 0;
    }
    const own = next.round?.slots?.[next.me?.artistSlot];
    if (own) optimistic = optimistic.filter(entry => !own.drawing.some(stroke => JSON.stringify(stroke.points) === JSON.stringify(entry.stroke.points)));
    if (!canDrawNow()) draft = null;
    render();
  }

  function render(force = false) {
    if (!state) return;
    // A live crowd update must never remove the surface holding pointer capture.
    if (draft && canDrawNow()) { drawAll(); tick(); return; }
    // Keep an unfinished room selection intact while other guests join.
    if (page === 'player' && !state.me && document.getElementById('join-form') && !force) {
      document.getElementById('join-submit').disabled = busy || !state.joinOpen;
      document.getElementById('join-status').textContent = state.joinOpen ? 'Your silly name is waiting for you.' : 'Joining is paused. The host will open a new event soon.';
      app.querySelector('.hero .eyebrow').textContent = state.event?.title || 'The Big Draw';
      tick();
      return;
    }
    const nextSignature = JSON.stringify(state, (key, value) => key === 'drawing' || key === 'serverTime' ||
      (key === 'players' && state.event?.status === 'ended') ? undefined : value) + busy;
    if (!force && signature === nextSignature) { drawAll(); tick(); return; }
    signature = nextSignature;
    const focus = document.activeElement;
    const savedField = focus?.id && focus.matches('input:not([type=file]), select, textarea') ? { id: focus.id, value: focus.value, start: focus.selectionStart, end: focus.selectionEnd } : null;
    const joinDraft = document.getElementById('join-form') ? {
      room: picker?.getValue(), canDraw: document.getElementById('can-draw').checked
    } : null;
    const eventDraft = document.getElementById('event-form') ? { title: document.getElementById('event-title').value, mode: document.getElementById('event-mode').value } : null;
    const previousPicture = app.querySelector('[data-picture-image]');
    app.removeAttribute('aria-busy');
    if (page === 'host') app.innerHTML = isHost() ? hostView() : loginView();
    else if (page === 'player') app.innerHTML = state.me ? playerView() : joinView();
    else app.innerHTML = displayView();
    if (previousPicture?.dataset.pictureImage === state.round?.id) {
      app.querySelector('[data-picture-image]')?.replaceWith(previousPicture);
    }
    document.body.classList.toggle('event-ended', state.event?.status === 'ended');
    document.body.dataset.roundStage = state.round?.stage || '';
    bind();
    if (eventDraft && document.getElementById('event-form')) {
      document.getElementById('event-title').value = eventDraft.title;
      document.getElementById('event-mode').value = eventDraft.mode;
    }
    if (savedField) {
      const field = document.getElementById(savedField.id);
      if (field) {
        field.value = savedField.value;
        field.focus({ preventScroll: true });
        if (savedField.start !== null && field.setSelectionRange && field.type !== 'number') field.setSelectionRange(savedField.start, savedField.end);
      }
    }
    if (joinDraft && document.getElementById('can-draw')) document.getElementById('can-draw').checked = joinDraft.canDraw;
    drawAll();
    tick();
  }

  function heading(title, text, eyebrow = '') {
    return `<section class="hero">${eyebrow ? `<span class="eyebrow">${escape(eyebrow)}</span>` : ''}<h1>${escape(title)}</h1><p>${escape(text)}</p></section>`;
  }

  function joinView() {
    if (isPicture()) return `${heading('One picture. Your funniest caption.', 'You get 30 seconds to bring the laughs, then the audience votes.', state.event?.title || 'Get The Picture')}
      <section class="card loading"><h2>Join Get The Picture</h2><form id="join-form"><div id="room-picker"></div>
      <label class="check"><input id="can-draw" type="checkbox" checked><span><strong>Volunteer for Big Draw too</strong>This only affects drawing games, not captions or judging.</span></label>
      <button class="full" id="join-submit"${disabled(!state.joinOpen)}>Join the fun</button><p id="join-status" class="small-text">${state.joinOpen ? 'Your silly name is waiting for you.' : 'Joining is paused.'}</p></form>
      <p>Keep captions friendly and politics-free. One audience vote each; no voting for your own caption. Guests joining during a round can vote and submit starting next round.</p></section>`;
    if (isCards()) return `${heading('Pick a card. Get a laugh.', 'Join on your phone. The first five answers face an audience vote.', state.event?.title || 'Family Cards')}
      <section class="card loading"><h2>Join the card game</h2><form id="join-form"><div id="room-picker"></div>
      <label class="check"><input id="can-draw" type="checkbox" checked><span><strong>Volunteer for Big Draw too</strong>This only affects drawing games, not your card-game eligibility.</span></label>
      <button class="full" id="join-submit"${disabled(!state.joinOpen)}>Join the fun</button><p id="join-status" class="small-text">${state.joinOpen ? 'Your silly name is waiting for you.' : 'Joining is paused.'}</p></form>
      <p>Ten private answer cards. Five anonymous finalists. Everyone votes, but never for their own answer. Guests joining mid-round can vote immediately and submit starting next round.</p></section>`;
    return `${heading('Big laughs. Little doodles.', 'Join the room, get a silly name, and let your imagination do the rest.', state.event?.title || 'The Big Draw')}
      <div class="grid join-layout"><section class="card"><span class="eyebrow">Your ticket to the fun</span><h2>Let’s get you in</h2>
      <form id="join-form"><div id="room-picker"></div><label class="check"><input id="can-draw" type="checkbox" checked><span><strong>Pick me to draw!</strong>I’m happy to use my finger, mouse or pen. Uncheck to just guess.</span></label>
      <button class="full" id="join-submit"${disabled(!state.joinOpen)}>Join the fun →</button><p class="small-text center" id="join-status">${state.joinOpen ? 'Your silly name is waiting for you.' : 'Joining is paused. The host will open a new event soon.'}</p></form></section>
      <section class="card"><div class="join-art"><span class="spark" aria-hidden="true">✦</span><span class="pencil" aria-hidden="true">✏️</span><h2>Perfectly imperfect.</h2><p>Stick figures are absolutely welcome.</p></div>
      <ol class="rules"><li><span class="rule-number">1</span><span><strong>Two secret artists.</strong><br>Each draws one part of the same mystery.</span></li><li><span class="rule-number">2</span><span><strong>One big reveal.</strong><br>The host shows both drawings together.</span></li><li><span class="rule-number">3</span><span><strong>Guess & cheer.</strong><br>First correct guesses earn 5 to 1 points. Each shown artist earns 1.</span></li></ol></section></div>`;
  }

  function loginView() {
    return `${heading('Hello, party starter.', 'Your private studio: pick artists, review doodles, and run the show.', 'Host access')}
      <section class="card loading"><h2>Open the host studio</h2><form id="login-form"><label class="field">Host password<input id="password" type="password" autocomplete="current-password" required maxlength="200"></label><button class="full"${disabled(false)}>Sign in securely →</button></form><p class="small-text center">Keep this screen private. Open /display for the audience.</p></section>`;
  }

  function leaderboard(kind, title, cutoff = 5) {
    const entries = (state.leaderboards?.[kind] || []).filter(entry => entry.rank <= cutoff);
    return `<section class="card"><div class="between"><h2>${escape(title)}</h2><span class="pill">Top ${cutoff} · ties included</span></div>
      ${entries.length ? `<ol class="score-list">${entries.map(entry => `<li class="${entry.rank <= 3 ? 'podium' : ''}"><span class="rank">${escape(entry.rank)}</span><span class="score-name">${escape(entry.name)}${entry.id === state.me?.id ? ' <span class="pill">You</span>' : ''}</span><span class="score-value">${escape(entry.score)}<small>PTS</small></span></li>`).join('')}</ol>` : '<div class="empty">A fresh start. Your first points are coming!</div>'}</section>`;
  }

  function qrCard() {
    const url = `${location.origin}/`;
    return `<section class="card qr-card"><span class="eyebrow">${state.joinOpen ? 'Everyone’s invited' : 'Join the next event'}</span><h2>Scan. Join. Play.</h2><img src="/api/qr?url=${encodeURIComponent(url)}" alt="QR code to join this game" width="180" height="180"><a class="join-url" href="${escape(url)}">${escape(url)}</a><p class="small-text">${state.joinOpen ? 'Choose your room on your own device.' : 'Joining is currently paused.'}</p><p id="qr-error" class="small-text" hidden>QR unavailable. Open the address above to join.</p></section>`;
  }

  function roster(privateView = false) {
    const players = state.players || [];
    const volunteers = players.filter(player => player.canDraw && !player.excluded && player.online).length;
    return `<section class="card"><div class="between"><h2>The happy crowd</h2><span class="pill">${players.filter(player => player.online).length} online</span></div><p class="small-text">${volunteers} available drawing volunteers</p>
      ${!players.length ? '<div class="empty">The first silly name could be yours.</div>' : privateView ? `<div class="roster-scroll"><table class="roster-table"><thead><tr><th>Name / room</th><th>Status</th><th>Pts</th></tr></thead><tbody>${players.map(player => `<tr><td>${escape(player.name)}<br><span class="muted">${escape(player.room || '—')}</span></td><td>${!player.online ? 'Offline' : player.excluded ? 'Guessing only' : player.canDraw ? '✎ Volunteer' : 'Guessing only'}</td><td>${escape(player.eventScore)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="roster">${players.map(player => `<span class="name-chip${!player.online ? ' offline' : ''}">${escape(player.name)}${player.online ? '' : ' · away'}</span>`).join('')}</div>`}</section>`;
  }

  function wheels() {
    const slots = state.round?.slots || [];
    const candidates = state.players.filter(player => player.canDraw && player.online && !player.excluded);
    const names = candidates.slice(0, 8).map(player => player.name);
    while (names.length < 8) names.push('★');
    return `<div class="wheels">${[0, 1].map(index => {
      const slot = slots[index];
      const spinning = slot?.status === 'selecting';
      const winner = slot?.playerId && !spinning ? slot.name : spinning ? 'Who will it be?' : 'Ready for a doodler';
      const wheelNames = [...names];
      if (slot?.playerId && !wheelNames.includes(slot.name)) wheelNames[0] = slot.name;
      const winnerIndex = slot?.playerId && !spinning ? wheelNames.indexOf(slot.name) : -1;
      return `<section class="card wheel-card"><span class="eyebrow">Artist ${index + 1}</span><div class="wheel-wrap"><span class="wheel-pointer" aria-hidden="true"></span><div class="wheel${spinning ? ' spinning' : ''}" data-winner="${winnerIndex}" aria-hidden="true">${wheelNames.map((name, i) => `<span class="wheel-label wheel-label-${i}">${escape(name)}</span>`).join('')}<span class="wheel-hub">✎</span></div></div><div class="wheel-winner">${escape(winner)}</div><div class="round-meta center-meta">${timer(slot?.deadline)}<span class="pill">${spinning ? 'Spinning…' : slot ? escape(slot.status) : 'Waiting'}</span></div></section>`;
    }).join('')}</div>`;
  }

  function drawingSvg(index, editable = false) {
    return `<svg class="drawing-surface${editable ? ' editable' : ''}" viewBox="0 0 1200 900" data-drawing="${index}"${editable ? ' id="draw-pad" tabindex="0"' : ''} role="img" aria-label="${editable ? 'Drawing area. Use a finger, pen or mouse to draw your secret part.' : `Drawing by artist ${index + 1}`}"><g class="strokes"></g></svg>`;
  }

  function drawings(privateView = false) {
    if (!state.round || (!privateView && !shown())) return '';
    return `<div class="drawing-pair">${state.round.slots.map((slot, index) => `<section class="drawing-panel"><div class="drawing-head"><h3>${escape(slot.name || `Artist ${index + 1}`)}</h3>${privateView ? timer(slot.deadline) : '<span class="pill">✎</span>'}</div>${privateView ? `<p class="small-text"><strong>${escape(slot.part || 'Awaiting selection')}</strong> · ${escape(slot.status)} · attempt ${escape(slot.attempt)}</p>` : ''}${drawingSvg(index)}
      ${privateView ? `<div class="actions drawing-tools">${button('approve', '✓ Approve', slot.status !== 'review' || !slot.playerId || !slot.drawing.length, 'small', { slot: index })}${button('reject', '↻ Try again', slot.status !== 'review' || !slot.playerId || !slot.drawing.length, 'secondary small', { slot: index })}${button('replace-artist', 'Replace artist', !!slot.playerId || !['review', 'selecting', 'drawing'].includes(state.round.stage), 'secondary small', { slot: index })}</div>` : ''}</section>`).join('')}</div>`;
  }

  function roundWaiting() {
    const stage = state.round?.stage;
    const title = stage === 'ready' ? 'The next masterpiece awaits.' : stage === 'selecting' ? 'The wheels of destiny are turning!' : stage === 'drawing' ? 'Secret doodles in progress…' : stage === 'review' ? 'A little backstage magic.' : stage === 'cancelled' ? 'A fresh round is on its way.' : 'Ready when you are.';
    return `<section class="card waiting"><span class="waiting-icon" aria-hidden="true">${stage === 'review' ? '✨' : '✏️'}</span><h2>${title}</h2><p>Keep your guesses under wraps. Both drawings appear when the host chooses Show.</p>${timer(state.round?.deadline)}</section>`;
  }

  function answerView() {
    return state.round?.answer && ['revealed', 'results'].includes(state.round.stage) ? `<section class="answer"><span class="eyebrow">The mystery was…</span><h2>${escape(state.round.answer)}</h2></section>` : '';
  }

  function identity() {
    const me = state.me;
    return `<section class="identity"><div><span class="small-text">Your gloriously silly name</span><br><strong>${escape(me.name)}</strong></div><div class="metric">${escape(me.gameScore)} game pts · ${escape(me.eventScore)} event pts</div></section>`;
  }

  function canDrawNow() {
    const slot = state?.round?.slots?.[state.me?.artistSlot];
    return page === 'player' && state?.me?.artistSlot !== null && slot?.status === 'drawing' && (!slot.deadline || timeLeft(slot.deadline) > 0);
  }

  function artistView() {
    const slot = state.round.slots[state.me.artistSlot];
    if (!slot) return roundWaiting();
    const editable = slot.status === 'drawing';
    return `<section class="card"><div class="between"><div><span class="eyebrow">You’re artist ${state.me.artistSlot + 1}</span><h2>${slot.status === 'selecting' ? 'Your moment is coming…' : editable ? 'Make your mark!' : slot.status === 'approved' ? 'Your doodle is ready!' : 'Over to the host.'}</h2></div>${timer(slot.deadline)}</div>
      ${slot.part ? `<div class="prompt"><span class="small-text">Your secret part — don’t say it out loud!</span><strong>${escape(slot.part)}</strong></div>` : ''}
      ${editable ? '<p class="small-text">30 seconds. Black ink. Big imagination. Draw with your finger, mouse or pen. Up to 200 strokes / 8,000 points; Undo or Clear makes more room.</p>' : '<p class="small-text">You can cheer, but artists can’t guess in their own round.</p>'}
      ${drawingSvg(state.me.artistSlot, editable)}
      ${editable ? `<div class="actions drawing-tools"><button id="undo-drawing" class="secondary"${disabled(!connected() || !slot.drawing.length)}>↶ Undo</button><button id="clear-drawing" class="secondary"${disabled(!connected() || !slot.drawing.length)}>Clear</button><button id="finish-drawing"${disabled(!connected())}>Done drawing ✓</button></div><p id="draw-status" class="small-text">${connected() ? 'Lift your finger to save each stroke.' : 'Offline — reconnecting. Please wait before drawing.'}</p>` : `<p class="private">${slot.status === 'review' ? 'Submitted privately. The host will review it.' : slot.status === 'approved' ? 'Approved! Waiting for the other artist.' : 'The host is selecting an artist.'}</p>`}</section>`;
  }

  function playerView() {
    const intro = heading(state.event?.title || 'You’re on the guest list!', state.game ? `${gameTitle()} · Game ${state.game.number}${state.round ? ` · Round ${state.round.number}` : ''}` : 'Hang tight — the host will start the fun.', 'Your play space');
    if (state.event?.status === 'ended' || state.display === 'event-final') return identity() + finale();
    if (state.display === 'game-final') return identity() + gameFinal();
    if (state.display === 'scoreboard') return identity() + intro + `<div class="grid split">${leaderboard('game', 'This game')}${leaderboard('event', 'The whole show')}</div>`;
    if (isPicture()) return identity() + intro + pictureRoundView() + leaderboard('game', 'The score so far');
    if (isCards()) return identity() + intro + cardRoundView() + leaderboard('game', 'The score so far');
    if (state.display === 'round-results') return identity() + intro + answerView() + leaderboard('round', 'This round’s stars', 5) + leaderboard('game', 'Game leaderboard');
    let content;
    const contributor = state.me.hasContributed;
    if (state.round && shown()) {
      content = `<section class="card">${drawings()}${answerView()}
        ${state.round.stage === 'guessing' && !contributor && state.me.artistSlot === null ? state.me.correct ? '<div class="success">✓ You got it! Keep the answer secret and cheer on the others.</div>' : `<div class="round-meta"><span class="pill">What do these drawings make together?</span>${timer(state.round.deadline)}</div><form id="guess-form" class="guess-form"><input id="guess" aria-label="Your guess" placeholder="Type your best guess…" autocomplete="off" maxlength="80" required><button${disabled(false)}>Send guess →</button></form><p class="small-text">Try again until you get it right. Fastest correct guesses earn the most points.</p>` : state.round.stage === 'guessing' ? `<p class="private">You contributed a drawing this round. Cheer on the guessers!</p>${timer(state.round.deadline)}` : state.round.stage === 'awaiting-reveal' ? '<p class="center">Guesses are closed. Ready for the answer?</p>' : ''}</section>`;
    } else if (state.round && state.me.artistSlot !== null) {
      content = artistView();
    } else if (state.round) {
      content = (state.round.stage === 'selecting' ? wheels() : '') + roundWaiting();
    } else {
      content = `<section class="card waiting"><span class="waiting-icon" aria-hidden="true">🎈</span><h2>You’re in. Let’s make some memories.</h2><p>${state.me.canDraw ? 'You’re in the artist pool. Keep this screen open — the wheel might pick you!' : 'You’re on the guessing team. Keep this screen open for the first round.'}</p></section>`;
    }
    return identity() + intro + `<div class="stack">${content}${state.round ? leaderboard('game', 'The score so far') : roster()}</div>`;
  }

  function displayView() {
    if (state.display === 'event-final' || state.event?.status === 'ended') return finale();
    if (state.display === 'game-final') return gameFinal();
    const intro = heading(state.event?.title || 'The Big Draw', state.game ? `${gameTitle()} · Game ${state.game.number}${state.round ? ` · Round ${state.round.number}` : ''}` : 'A room full of people. A world of imagination.', 'Play together');
    if (state.display === 'scoreboard') return intro + `<div class="grid split">${leaderboard('game', `${gameTitle()} leaderboard`)}${leaderboard('event', 'Variety Show leaderboard')}</div>`;
    if (isPicture()) return intro + pictureRoundView() + (!state.round ? `<div class="grid split">${roster()}${qrCard()}</div>` : '');
    if (isCards()) return intro + cardRoundView() + (!state.round ? `<div class="grid split">${roster()}${qrCard()}</div>` : '');
    if (state.display === 'round-results') return intro + answerView() + `<div class="grid split">${leaderboard('round', 'This round’s stars')}${leaderboard('game', 'Game leaderboard')}</div>`;
    if (state.round && state.display === 'round') {
      if (shown()) return `${state.round.stage === 'guessing' ? `<div class="guess-progress" role="progressbar" aria-label="Guessing time remaining" aria-valuemin="0" aria-valuemax="30" data-progress-deadline="${state.round.deadline}"><div class="guess-progress-fill"></div><span></span></div>` : ''}` + intro + `<section class="card">${drawings()}${answerView()}<div class="center round-meta center-meta"><h2>${state.round.stage === 'guessing' ? 'Two doodles. One answer. Guess on your device!' : state.round.stage === 'awaiting-reveal' ? 'Time’s up! What could it be?' : 'Did you guess it?'}</h2>${timer(state.round.deadline)}</div></section>`;
      return intro + `<div class="stack">${wheels()}${roundWaiting()}</div>`;
    }
    return intro + `<div class="grid host-layout"><section class="card"><div class="join-art"><span class="pencil" aria-hidden="true">✏️</span><h2>Good times are on the drawing board.</h2><p>Scan to join. The host will take it from here.</p></div>${roster()}</section>${qrCard()}</div>`;
  }

  function newEventForm() {
    return `<section class="card"><h2>Set the stage</h2><form id="event-form"><label class="field">Event name<input id="event-title" maxlength="80" placeholder="Tonight’s games" value="${escape(state.event?.title || 'The Big Draw')}"></label><label class="field">Format<select id="event-mode"><option value="standalone">Standalone — choose one game below</option><option value="variety"${state.event?.mode === 'variety' ? ' selected' : ''}>Variety Show — cumulative games</option></select></label><button class="full"${disabled(false)}>${state.event ? 'Create a fresh event…' : 'Open new event →'}</button></form><p class="small-text">${state.event ? 'A new event clears all registrations, hands and scores.' : 'Guests can join once you open an event.'}</p></section>`;
  }

  function cardRoundView() {
    const round = state.round;
    const me = page === 'player' ? state.me : null;
    const revealed = round && ['revealed', 'results'].includes(round.stage);
    const submitting = round?.stage === 'submitting';
    const voting = round?.stage === 'voting';
    const finalists = round?.finalists || [];
    const status = !round ? 'The host will start the first round.' :
      submitting ? `${round.submissionCount} of 5 answers received. Choose on your phone!` :
      voting ? `${round.voteCount} votes received. Vote for your favorite on your phone!` :
      revealed ? 'Audience results are in!' : 'No points awarded. The host can start another round.';
    const answers = finalists.length ? `<div class="card-options">${finalists.map((finalist, index) => {
      const own = finalist.id === me?.ownSubmissionId;
      const voted = finalist.id === me?.votedFor;
      return `<article class="answer-card"><span class="eyebrow">Answer ${index + 1}${own ? ' · Yours' : ''}</span><p>${escape(finalist.text)}</p>
        ${revealed ? `<strong>${escape(finalist.name)}</strong><p class="small-text">${finalist.votes} votes · ${finalist.points} points</p>` :
          me ? button('vote-card', voted ? 'Vote recorded' : own ? 'Your answer — no self-voting' : `Vote for answer ${index + 1}`,
            !voting || own || !!me.votedFor || timeLeft(round.deadline) <= 0, 'card-choice', { submissionId: finalist.id }) : ''}</article>`;
    }).join('')}</div>` : '';
    const hand = me && (!round || submitting) ? `<section class="card"><h2>Your private hand</h2>
      <p>${me.submitted ? 'Your answer is submitted. Wait for the finalists.' : round && !me.canSubmit ? 'You joined during this round. Submit starting next round; you can vote this round.' : 'Tap one card to submit it immediately. Only the first five answers received become finalists.'}</p>
      <div class="card-options">${me.hand.map(card => button('submit-card', escape(card.text),
        !submitting || !me.canSubmit || me.submitted || timeLeft(round.deadline) <= 0, 'answer-card card-choice', { cardId: card.id })).join('')}</div></section>` : '';
    return `<section class="card"><div class="between"><h2>${!round ? 'Ready for some laughs?' : submitting ? 'Choose your answer' : voting ? `${finalists.length} ${finalists.length === 1 ? 'answer' : 'answers'}. Your choice.` : 'Round complete'}</h2>${timer(round?.deadline)}</div>
      ${round ? `<div class="card-prompt">${escape(round.prompt)}</div>` : '<p>Ten private cards per player. First five answers become anonymous finalists. Everyone votes, except for their own answer.</p>'}
      <p role="status">${escape(status)}</p>${me?.votedFor && voting ? '<p class="success">Your vote is recorded. Results appear when voting closes.</p>' : ''}${answers}
      ${isHost() && round ? `<div class="actions host-actions">${button('close-submissions', 'Close submissions now', !submitting)}${button('close-voting', 'Close voting & show results', !voting)}${button('round-results', 'Round results', round.stage !== 'revealed', 'secondary')}${button('cancel-round', 'Cancel round…', !submitting && !voting, 'danger')}</div>` : ''}
      <p class="small-text">30 seconds to submit, closing early at five answers; then 30 seconds to vote. One vote each. Ranked points: 5/4/3/2/1; ties share their rank and skip the next position. Answers without votes earn no points.</p></section>${hand}${revealed ? leaderboard('round', 'This round’s stars') : ''}`;
  }

  function pictureChoices(entries, action, closed = false) {
    const me = page === 'player' ? state.me : null;
    const revealed = ['revealed', 'results'].includes(state.round?.stage);
    const perPage = 6;
    const start = page === 'display' ? (displayCaptionPage % Math.max(1, Math.ceil(entries.length / perPage))) * perPage : 0;
    const visible = page === 'display' ? entries.slice(start, start + perPage) : entries;
    return `${page === 'display' && entries.length > perPage ? `<p class="center small-text">Captions ${start + 1}–${start + visible.length} of ${entries.length} · screen rotates · full list on phones</p>` : ''}
      <div class="card-options">${visible.map((entry, index) => {
        const own = entry.id === me?.ownSubmissionId;
        const picked = action === 'vote-caption' ? me?.votedFor === entry.id : me?.nominated;
        return `<article class="answer-card"><span class="eyebrow">Caption ${start + index + 1}${own ? ' · Yours' : ''}</span><p>${escape(entry.text)}</p>
        ${revealed ? `<strong>${escape(entry.name)}</strong><p class="small-text">${entry.votes} votes · ${entry.points} points</p>` :
          me ? button(action, picked ? 'Choice recorded' : own ? 'Your caption — no self-voting' : action === 'nominate-caption' ? 'Nominate this caption' : 'Vote for this caption',
            closed || own || (action === 'vote-caption' ? !!me.votedFor : me.nominated) || timeLeft(state.round.deadline) <= 0,
            'picture-choice', { submissionId: entry.id }) : ''}</article>`;
      }).join('')}</div>`;
  }

  function pictureRoundView() {
    const round = state.round;
    const me = page === 'player' ? state.me : null;
    const mode = state.game.pictureMode;
    const modes = { small: 'Small room', large: 'Large audience', poolside: 'Poolside' };
    if (!round) return `<section class="card waiting"><h2>Get The Picture</h2><span class="pill">${modes[mode]}</span><p>The host will choose an image and start the first round. Keep it friendly, respectful and politics-free.</p></section>`;
    const live = ['loading', 'captioning', 'reviewing', 'judging', 'voting'].includes(round.stage);
    const captioning = round.stage === 'captioning';
    const voting = round.stage === 'voting';
    const revealed = ['revealed', 'results'].includes(round.stage);
    const statuses = {
      loading: 'Loading the picture. The host starts the timer after screens are ready.',
      captioning: `${round.submissionCount} captions received. Write your funniest caption on your phone!`,
      reviewing: 'The host is choosing captions for the audience vote.',
      judging: `${round.nominatedCount} of ${round.groupCount} groups nominated. Judges: choose on your phone.`,
      voting: `${round.voteCount} votes received. Vote for your favorite on your phone!`,
      revealed: 'The audience has spoken!', results: 'This round’s results.',
      cancelled: 'This round was cancelled or had no eligible finalists. No points awarded.',
    };
    const form = me && captioning && me.canSubmit && !me.submitted ? `<form id="caption-form">
      <label class="field">Your funniest caption<textarea id="caption" rows="3" maxlength="160" required placeholder="Keep it friendly and politics-free…">${escape(captionDraft.text)}</textarea></label>
      <button id="submit-caption"${disabled(timeLeft(round.deadline) <= 0)}>Submit caption</button>
      <p class="small-text">160 characters maximum. Rejected captions can be revised while time remains. Accepted captions are final.</p></form>` : '';
    const own = me?.submitted && live ? `<p class="private">${me.captionRemoved ? 'The host removed your caption from this round.' : 'Your caption is submitted:'} ${escape(me.ownCaption)}</p>` : '';
    const judge = me && round.stage === 'judging' ? me.isJudge ?
      `<section class="card"><h2>You’re the judge for group ${me.groupNumber}</h2><p>${me.nominated ? 'Your nomination is recorded.' : me.judgeChoices.length ? 'Choose your group’s funniest caption. Your own caption is never among these options.' : 'There are no eligible captions from other players in your group. Your group will skip this vote.'}</p>
      ${pictureChoices(me.judgeChoices, 'nominate-caption', me.nominated)}</section>` :
      `<p class="private">${me.groupNumber ? `Your group ${me.groupNumber} judge is choosing a caption.` : 'You joined mid-round. You can vote when the nominees appear.'}</p>` : '';
    const review = isHost() && live && round.review.length ? `<section class="card"><h2>Private caption review</h2>
      <p>${mode === 'large' ? 'Approve only the captions you want the audience to see, then open voting. About five to ten finalists keeps voting manageable.' : 'The safety filter has accepted these captions. Remove anything unsuitable before or during voting.'}</p>
      <div class="caption-review">${round.review.map(entry => `<article class="answer-card"><p>${escape(entry.text)}</p><span class="pill">${entry.removed ? 'Removed' : entry.approved ? 'Approved' : 'Filter passed'}</span><div class="actions">
      ${mode === 'large' ? button('review-caption', 'Approve', entry.removed || entry.approved || !['captioning', 'reviewing'].includes(round.stage), 'small', { submissionId: entry.id, decision: 'approve' }) : ''}
      ${button('review-caption', 'Remove', entry.removed, 'danger small', { submissionId: entry.id, decision: 'remove' })}</div></article>`).join('')}</div></section>` : '';
    const hostControls = isHost() && live ? `<div class="host-actions"><p class="small-text">${round.readyCount}/${round.participantCount} players have loaded the image. Verify it is visible on the Main Display before starting the timer.</p><div class="actions">
      ${button('start-caption-timer', 'Start 30-second caption timer', round.stage !== 'loading' || !loadedPictures.has(round.id))}
      ${button('close-submissions', 'Close captions now', !captioning, 'secondary')}
      ${button('open-picture-voting', 'Open audience voting', !['reviewing', 'judging'].includes(round.stage) ||
        (round.stage === 'reviewing' ? !round.review.some(entry => entry.approved && !entry.removed) : !round.nominatedCount))}
      ${button('close-voting', 'Close voting & show results', !voting, 'secondary')}
      ${button('cancel-round', 'Cancel round…', false, 'danger')}</div>
      ${mode === 'poolside' ? `<p class="small-text">${round.groups.map(group => `Group ${group.number}: ${escape(group.judge)} — ${group.nominated ? 'nominated' : `${group.choiceCount} choices`}`).join(' · ')}</p>` : ''}</div>` : '';
    return `<section class="card"><div class="between"><div><span class="eyebrow">${modes[mode]} · Round ${round.number}</span><h2>${revealed ? 'Picture-perfect punchlines' : 'Get The Picture'}</h2></div>${timer(round.deadline)}</div>
      <figure class="picture-frame"><img data-picture-image="${round.id}" src="${escape(round.image.url)}" alt="${escape(round.image.alt)}"><figcaption>${escape(round.image.credit)}</figcaption></figure>
      <p class="picture-error" hidden>Image could not load. Check your connection. <button type="button" id="retry-picture" class="secondary small">Retry image</button></p>
      <p role="status">${escape(statuses[round.stage])}</p>
      ${me && captioning && !me.canSubmit ? '<p class="private">You joined mid-round. You can vote this round and caption starting next round.</p>' : ''}
      ${me?.isJudge && ['loading', 'captioning'].includes(round.stage) ? `<p class="private">You’re this round’s group ${me.groupNumber} judge. Submit your own caption too; you’ll choose from the other players’ captions after time expires.</p>` : ''}
      ${form}${own}${voting || revealed ? pictureChoices(round.finalists, 'vote-caption', !voting) : ''}
      ${me?.votedFor && voting ? '<p class="success">Your vote is recorded.</p>' : ''}${hostControls}
      ${isHost() && revealed ? button('round-results', 'Round results', round.stage !== 'revealed', 'secondary') : ''}
      <p class="small-text">30 seconds to caption; 30 seconds to vote. One vote each, never for your own caption. Top-five positive-vote captions earn 5/4/3/2/1 points; ties share rank.</p></section>${judge}${review}${revealed ? leaderboard('round', 'This round’s stars') : ''}`;
  }

  function pictureLibraryView() {
    return `<section class="card"><details id="picture-library"${imageManagerOpen ? ' open' : ''}><summary><strong>Get The Picture · Image library & safety</strong></summary>
      <p>Six original starter illustrations are ready to use. Upload only images you have permission to display. Check each image for suitability; image content is not automatically moderated.</p>
      <div class="image-library">${(state.pictureImages || []).map(image => `<article class="answer-card"><img src="${escape(image.url)}" alt="${escape(image.alt)}" loading="lazy"><h3>${escape(image.title)}</h3><p class="small-text">${escape(image.credit)}</p>
      ${button('set-picture-image', image.enabled ? 'Disable image' : 'Enable image', false, 'secondary small', { imageId: image.id, enabled: !image.enabled })}</article>`).join('')}</div>
      <h3>Upload an image</h3>${state.pictureUploadsEnabled ? `<form id="image-upload-form">
      <label class="field">Still image (JPEG, PNG or WebP; up to 5 MB)<input id="image-file" type="file" accept="image/jpeg,image/png,image/webp"></label>
      <p id="selected-image-name" class="small-text">${uploadDraft.file ? `Selected: ${escape(uploadDraft.file.name)}` : 'No image selected.'}</p>
      <label class="field">Private library title<input id="image-title" maxlength="80" required value="${escape(uploadDraft.title)}"></label>
      <label class="field">Image description for accessibility<input id="image-alt" maxlength="240" required value="${escape(uploadDraft.alt)}"></label>
      <label class="field">Credit / source<input id="image-credit" maxlength="160" required value="${escape(uploadDraft.credit)}"></label>
      <label class="check"><input id="image-permission" type="checkbox" required${uploadDraft.permission ? ' checked' : ''}><span>I have permission to use this image and have checked that it suits this audience.</span></label>
      <button${disabled(false)}>Upload to games image storage</button></form>` :
      '<p class="private">Uploads will be available after R2 is configured in Render. The starter library works now. Follow the dedicated games manual for setup; never enter storage keys here.</p>'}
      <h3>Additional blocked words and phrases</h3><p class="small-text">One phrase per line. These add to the built-in rules; they cannot disable them. Save before opening captions.</p>
      <form id="picture-policy-form"><textarea id="picture-policy" rows="4" maxlength="4000" aria-label="Additional blocked phrases">${escape(policyDraft ?? state.pictureBlockedTerms.join('\n'))}</textarea><button${disabled(false)}>Save safety additions</button></form>
      <p class="small-text">Automated filtering is not a guarantee. Keep the host panel private and remove unsuitable captions. Use Large audience mode when every caption needs a human review before display.</p>
      </details></section>`;
  }

  function hostView() {
    const game = state.game;
    const round = state.round;
    const activeGame = game && game.status !== 'ended';
    const activeEvent = state.event && state.event.status !== 'ended';
    const roundDone = !round || ['revealed', 'results', 'cancelled'].includes(round.stage);
    const liveRound = round && !['revealed', 'results', 'cancelled'].includes(round.stage);
    const enoughArtists = state.players.filter(player => player.online && player.canDraw && !player.excluded).length >= 2;
    const enoughPlayers = state.players.filter(player => player.online).length >= 2;
    const canStartGame = activeEvent && !activeGame && (!game || state.event.mode === 'variety');
    let mainContent = '';
    if (state.event?.status === 'ended') mainContent = finale();
    else if (game?.status === 'ended') mainContent = gameFinal();
    else if (isPicture()) mainContent = pictureRoundView();
    else if (isCards()) mainContent = cardRoundView();
    else if (round) mainContent = `<section class="card"><div class="between"><div><span class="eyebrow">Private host preview · Round ${round.number}</span><h2>${escape(round.stage.replaceAll('-', ' '))}</h2></div>${timer(round.deadline)}</div>${round.answer ? `<div class="prompt"><span class="small-text">Secret answer — host eyes only</span><strong>${escape(round.answer)}</strong></div>` : ''}${round.stage === 'ready' || round.stage === 'selecting' ? wheels() : ''}${drawings(true)}
      <div class="host-actions"><div class="actions">${button('select-players', 'Spin both wheels ✦', round.stage !== 'ready' || !enoughArtists)}${button('show', 'Show both drawings →', !round.slots.length || !round.slots.every(slot => slot.status === 'approved') || round.stage !== 'review')}${button('reveal', 'Reveal answer', round.stage !== 'awaiting-reveal')}${button('round-results', 'Round results', round.stage !== 'revealed', 'secondary')}</div><div class="actions">${button('cancel-round', 'Cancel round…', !liveRound, 'danger')}</div></div><p class="small-text">Blank drawings retry automatically, then switch artists. If replacements run out, welcome another volunteer and use Replace artist, or cancel this round.</p></section>`;
    else mainContent = `<section class="card waiting"><span class="waiting-icon" aria-hidden="true">🎬</span><h2>${game ? 'Ready for round one?' : activeEvent ? 'Your event is open!' : 'Let’s get this show started.'}</h2><p>${activeEvent ? 'Welcome your guests, choose a game, then start a round.' : 'Open a new event to welcome guests.'}</p></section>`;
    const pictureControls = `<form id="picture-game-form"><label class="field">Get The Picture format<select id="picture-mode"${disabled(!canStartGame)}>${[['small', 'Small room — all accepted captions'], ['large', 'Large audience — host-approved captions'], ['poolside', 'Poolside — rotating group judges']].map(([value, label]) => `<option value="${value}"${pictureModeChoice === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label><button${disabled(!canStartGame)}>Start Get The Picture</button></form>
      ${isPicture() ? `<label class="field">Next round’s image<select id="picture-image"><option value="">Random unused image</option>${state.pictureImages.filter(image => image.enabled).map(image => `<option value="${image.id}"${pictureImageChoice === image.id ? ' selected' : ''}>${escape(image.title)}</option>`).join('')}</select></label>` : ''}`;
    const controls = `<section class="card"><h2>Run the show</h2>${pictureControls}<div class="actions">${button('start-game', 'Start Big Draw', !canStartGame, '', { type: 'pictionary' })}${button('start-game', 'Start Family Cards', !canStartGame, '', { type: 'family-cards' })}${button('start-round', 'Start a new round', !activeEvent || !activeGame || !roundDone || !(isCards() || isPicture() ? enoughPlayers : enoughArtists))}${button('scoreboard', 'Show scoreboard', !game || !!liveRound, 'secondary')}${button('end-game', 'Conclude game…', !activeGame || !!liveRound, 'secondary')}${button('end-event', 'Conclude event…', !activeEvent || !!liveRound, 'secondary')}</div><p class="small-text">${isPicture() ? 'Get The Picture supports 2–100 players. Start a round to preload the image, then start the caption timer.' : isCards() ? 'Family Cards needs at least two online players; drawing volunteers are not required.' : 'Big Draw needs at least two online drawing volunteers.'} ${state.event?.mode === 'variety' ? 'Next games keep this event’s registrations and cumulative scores.' : 'Concluding a standalone game also concludes the event.'}</p><p class="small-text">Family Cards includes toilet humor and dark themes. Start it at the host’s discretion for an appropriate audience.</p></section>`;
    return `${heading(state.event?.title || 'Your party. Your studio.', 'Private controls for a very public good time.', 'Host studio')}<div class="grid host-layout"><div class="stack">${mainContent}${controls}${pictureLibraryView()}<div class="grid split">${leaderboard('game', 'Game points')}${leaderboard('event', 'Event points')}</div></div><aside class="stack host-sidebar">${qrCard()}${roster(true)}${newEventForm()}<section class="card"><div class="actions"><a href="/display" target="_blank" rel="noopener">Open audience display ↗</a>${button('logout', 'Sign out', false, 'secondary small')}</div></section></aside></div>`;
  }

  function gameFinal() {
    return `${heading('What a game!', state.event?.mode === 'variety' ? 'Keep those smiles. The host will choose the next game.' : 'Thanks for playing!', `${gameTitle()} · final standings`)}<div class="grid split">${leaderboard('game', `Our ${gameTitle()} stars`, 3)}${leaderboard('event', 'The show so far', 5)}</div>`;
  }

  function finale() {
    return `<section class="finale"><span class="eyebrow">${escape(state.event?.title || 'The Big Draw')} · That’s a wrap</span>
      <svg class="finale-art" viewBox="0 0 660 260" role="img" aria-label="Two stick figures drawn in black pen, followed by a red heart"><rect width="660" height="260" fill="white"/><g stroke="#111111" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"><g class="figure"><circle class="ink head" pathLength="1" cx="210" cy="72" r="25"/><path class="ink body" pathLength="1" d="M210 98V171M210 117L167 97L147 61M210 117L250 98L272 65M210 171L177 222M210 171L241 220"/><path class="ink smile" pathLength="1" d="M202 76Q210 84 218 76" stroke-width="3"/></g><g class="figure second"><circle class="ink head" pathLength="1" cx="450" cy="72" r="25"/><path class="ink body" pathLength="1" d="M450 98V171M450 117L409 98L387 65M450 117L490 96L511 58M450 171L418 221M450 171L483 220"/><path class="ink smile" pathLength="1" d="M442 76Q450 84 458 76" stroke-width="3"/></g><path class="ink heart" pathLength="1" d="M330 118C269 77 291 29 330 60C369 29 391 77 330 118Z" stroke="#e83250" stroke-width="7"/></g></svg>
      <h1>Thank You For Playing</h1><p>The art was one of a kind. So were you.</p><div class="final-standings">${leaderboard('event', 'Our event stars', 3)}</div></section>`;
  }

  function confirmChoice(title, description, choices) {
    return new Promise(resolve => {
      if (dialog.open) { resolve(null); return; }
      document.getElementById('dialog-title').textContent = title;
      document.getElementById('dialog-description').textContent = description;
      const actions = document.getElementById('dialog-actions');
      actions.replaceChildren();
      const close = value => { dialog.close(); resolve(value); };
      for (const choice of choices) {
        const element = document.createElement('button');
        element.textContent = choice.label;
        element.className = choice.style || '';
        element.addEventListener('click', () => close(choice.value), { once: true });
        actions.append(element);
      }
      dialog.addEventListener('cancel', () => resolve(null), { once: true });
      dialog.showModal();
    });
  }

  async function command(action, data = {}) {
    if (busy) return;
    if (action === 'start-round' && isPicture() && pictureImageChoice) data = { ...data, imageId: pictureImageChoice };
    if (action === 'new-event' && state.event) {
      const choice = await confirmChoice('Start completely fresh?', 'This removes EVERY registration, game, drawing and score. Guests will need to join again.', [{ label: 'Keep this event', value: false, style: 'secondary' }, { label: 'Clear everything & create event', value: true, style: 'danger' }]);
      if (!choice) return;
    }
    if (['end-game', 'end-event', 'cancel-round', 'logout'].includes(action)) {
      const choice = await confirmChoice(action === 'logout' ? 'Sign out of the studio?' : action === 'cancel-round' ? 'Cancel this round?' : `Conclude this ${action === 'end-event' ? 'event' : 'game'}?`,
        action === 'cancel-round' ? 'This round will stop. You can start a fresh round next.' : action === 'logout' ? 'The game keeps running. You can sign in again at any time.' : 'Standings will be finalized. A tied lead will give you the option of another round.',
        [{ label: 'Go back', value: false, style: 'secondary' }, { label: action === 'logout' ? 'Sign out' : 'Continue', value: true }]);
      if (!choice) return;
    }
    busy = true;
    render(true);
    try {
      const result = action === 'logout' ? await api('/api/host/logout', {}) : await api('/api/command', { action, data });
      if (action === 'set-picture-policy') policyDraft = null;
      if (result?.serverTime) receive(result); else await refresh();
      // A socket opened before login carries the old role until it is reconnected.
      if (action === 'logout') socket?.close();
      if (action === 'guess' && !state.me?.correct) notify('Not quite! Have another go.');
    } catch (error) {
      if (error.status === 409 && error.code === 'TIE_CONFIRMATION') {
        busy = false;
        render(true);
        const choice = await confirmChoice('A shared podium!', 'Celebrate the tie, or give everyone one more round to find a winner.', [
          { label: 'Conclude Anyway', value: 'conclude' }, { label: 'Play One More Round', value: 'round', style: 'secondary' }, { label: 'Go back', value: null, style: 'secondary' }
        ]);
        if (choice === 'conclude') await runCommand(action, { ...data, allowTie: true });
        if (choice === 'round') {
          if (action === 'end-event' && state.game?.status === 'ended') {
            if (!await runCommand('start-game', { type: state.game.type, pictureMode: state.game.pictureMode })) return;
          }
          await runCommand('start-round', {});
        }
      } else {
        notify(error.code === 'NEED_ARTISTS' ? `${error.message} Ask another guest to join with “Pick me to draw”, then use Replace artist or cancel the round.` : error.message);
        await refresh();
      }
    } finally { busy = false; render(true); }
  }

  async function runCommand(action, data) {
    busy = true;
    render(true);
    try { receive(await api('/api/command', { action, data })); return true; }
    catch (error) { notify(error.message); await refresh(); return false; }
    finally { busy = false; render(true); }
  }

  function bind() {
    app.querySelectorAll('[data-action]').forEach(element => element.addEventListener('click', () => command(element.dataset.action, JSON.parse(element.dataset.payload))));
    app.querySelectorAll('.qr-card img').forEach(image => image.addEventListener('error', () => {
      image.hidden = true;
      image.parentElement.querySelector('#qr-error').hidden = false;
    }));
    document.getElementById('picture-mode')?.addEventListener('change', event => { pictureModeChoice = event.target.value; });
    document.getElementById('picture-image')?.addEventListener('change', event => { pictureImageChoice = event.target.value; });
    document.getElementById('picture-game-form')?.addEventListener('submit', event => {
      event.preventDefault();
      command('start-game', { type: 'get-the-picture', pictureMode: pictureModeChoice });
    });
    document.getElementById('caption')?.addEventListener('input', event => {
      captionDraft = { roundId: state.round.id, text: event.target.value };
    });
    document.getElementById('caption-form')?.addEventListener('submit', event => {
      event.preventDefault();
      command('submit-caption', { text: document.getElementById('caption').value });
    });
    document.getElementById('picture-library')?.addEventListener('toggle', event => { imageManagerOpen = event.target.open; });
    document.getElementById('picture-policy')?.addEventListener('input', event => { policyDraft = event.target.value; });
    document.getElementById('picture-policy-form')?.addEventListener('submit', event => {
      event.preventDefault();
      command('set-picture-policy', { terms: document.getElementById('picture-policy').value });
    });
    document.getElementById('image-file')?.addEventListener('change', event => {
      uploadDraft.file = event.target.files[0] || null;
      document.getElementById('selected-image-name').textContent = uploadDraft.file ? `Selected: ${uploadDraft.file.name}` : 'No image selected.';
    });
    for (const field of ['title', 'alt', 'credit']) {
      document.getElementById(`image-${field}`)?.addEventListener('input', event => { uploadDraft[field] = event.target.value; });
    }
    document.getElementById('image-permission')?.addEventListener('change', event => { uploadDraft.permission = event.target.checked; });
    document.getElementById('image-upload-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const file = uploadDraft.file;
      if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
        notify('Choose a still JPEG, PNG or WebP image up to 5 MB.');
        return;
      }
      const query = new URLSearchParams({
        title: uploadDraft.title, alt: uploadDraft.alt, credit: uploadDraft.credit, permission: String(uploadDraft.permission),
      });
      busy = true;
      render(true);
      try {
        const next = await api(`/api/picture-images?${query}`, file, file.type);
        Object.assign(uploadDraft, { file: null, title: '', alt: '', credit: '', permission: false });
        receive(next);
        notify('Image uploaded. It is now available in the games library.');
      } catch (error) { notify(error.message); await refresh(); }
      finally { busy = false; render(true); }
    });
    const picture = app.querySelector('[data-picture-image]');
    if (picture) {
      const roundId = state.round.id;
      const loaded = async () => {
        if (!picture.isConnected || state.round?.id !== roundId) return;
        loadedPictures.add(roundId);
        const start = app.querySelector('[data-action="start-caption-timer"]');
        if (start) start.disabled = busy || state.round?.stage !== 'loading';
        const errorMessage = app.querySelector('.picture-error');
        if (errorMessage) errorMessage.hidden = true;
        if (page !== 'player' || !state.me?.participant || state.me.imageReady || readyReports.has(roundId) ||
          !['loading', 'captioning'].includes(state.round?.stage) || state.round.id !== roundId) return;
        readyReports.add(roundId);
        try { receive(await api('/api/command', { action: 'picture-ready', data: {} })); }
        catch (error) { notify(`Could not confirm image readiness: ${error.message}`); }
        finally { readyReports.delete(roundId); }
      };
      picture.onload = loaded;
      picture.onerror = () => {
        if (!picture.isConnected || state.round?.id !== roundId) return;
        loadedPictures.delete(roundId);
        app.querySelector('.picture-error').hidden = false;
        const start = app.querySelector('[data-action="start-caption-timer"]');
        if (start) start.disabled = true;
      };
      if (picture.complete) {
        if (picture.naturalWidth) loaded();
        else picture.onerror();
      }
      document.getElementById('retry-picture')?.addEventListener('click', () => {
        picture.src = `${state.round.image.url}?retry=${Date.now()}`;
      });
    }
    const joinForm = document.getElementById('join-form');
    if (joinForm) {
      picker = window.ResortRoomPicker.mount(document.getElementById('room-picker'), { name: 'room' });
      joinForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || !state.joinOpen || !picker.validate()) return;
        const data = { room: picker.getValue(), canDraw: document.getElementById('can-draw').checked };
        busy = true;
        document.getElementById('join-submit').disabled = true;
        try { receive(await api('/api/join', data)); socket?.close(); }
        catch (error) { notify(error.message); }
        finally { busy = false; render(); }
      });
    }
    document.getElementById('login-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      if (busy) return;
      const password = document.getElementById('password').value;
      document.getElementById('password').value = '';
      busy = true;
      render(true);
      try { receive(await api('/api/host/login', { password })); socket?.close(); }
      catch (error) { notify(error.message); }
      finally { busy = false; render(true); }
    });
    document.getElementById('event-form')?.addEventListener('submit', event => {
      event.preventDefault();
      command('new-event', { mode: document.getElementById('event-mode').value, title: document.getElementById('event-title').value.trim() || 'The Big Draw' });
    });
    document.getElementById('guess-form')?.addEventListener('submit', event => {
      event.preventDefault();
      const answer = document.getElementById('guess').value.trim();
      if (!answer || busy) return;
      document.getElementById('guess').value = '';
      command('guess', { answer });
    });
    document.getElementById('finish-drawing')?.addEventListener('click', async () => {
      if (draft || requests.size) { notify('Let the current stroke finish saving, then tap Done again.'); return; }
      await command('finish');
    });
    ['undo', 'clear'].forEach(action => document.getElementById(`${action}-drawing`)?.addEventListener('click', async () => {
      if (!canDrawNow() || draft || requests.size) return;
      try { await socketCommand(action); }
      catch (error) { notify(error.message); refresh(); }
    }));
    const pad = document.getElementById('draw-pad');
    if (pad) bindDrawing(pad);
    updateDrawControls();
  }

  function updateDrawControls() {
    const own = state?.round?.slots?.[state.me?.artistSlot];
    const allowed = canDrawNow() && connected() && !busy;
    const pad = document.getElementById('draw-pad');
    if (pad) pad.setAttribute('aria-disabled', String(!allowed));
    for (const action of ['undo', 'clear']) {
      const element = document.getElementById(`${action}-drawing`);
      if (element) element.disabled = !allowed || !!draft || requests.size > 0 || (!own?.drawing.length && !optimistic.length);
    }
    const finish = document.getElementById('finish-drawing');
    if (finish) finish.disabled = !allowed || !!draft || requests.size > 0;
    const status = document.getElementById('draw-status');
    if (status) status.textContent = !connected() ? 'Offline — reconnecting. Please wait before drawing.' : !canDrawNow() ? 'Time’s up! Your drawing is with the host.' : requests.size ? 'Saving your doodle…' : 'Lift your finger to save each stroke.';
  }

  function bindDrawing(pad) {
    const point = event => {
      const rect = pad.getBoundingClientRect();
      return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
    };
    pad.addEventListener('pointerdown', event => {
      if (!canDrawNow() || !connected() || busy || draft || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (!inkCapacity()) { notify('Your drawing has reached its ink limit. Undo a stroke or Clear to make more room.'); return; }
      event.preventDefault();
      pad.setPointerCapture(event.pointerId);
      draft = { pointerId: event.pointerId, points: [point(event)], color: '#111111', width: 0.008, started: Date.now() };
      drawAll();
      updateDrawControls();
    });
    pad.addEventListener('pointermove', event => {
      if (!draft || draft.pointerId !== event.pointerId) return;
      if (!canDrawNow()) { finishStroke(); return; }
      const coalesced = event.getCoalescedEvents?.();
      const events = coalesced?.length ? coalesced : [event];
      for (const item of events) {
        if (!draft) break;
        const next = point(item);
        const last = draft.points.at(-1);
        if (Math.hypot(next.x - last.x, next.y - last.y) < 0.002) continue;
        if (!inkCapacity()) {
          finishStroke();
          notify('Your drawing has reached its ink limit. Undo a stroke or Clear to make more room.');
          break;
        }
        draft.points.push(next);
        // Periodic chunks save long touch gestures before the independent timer expires.
        if (draft.points.length >= 160 || Date.now() - draft.started >= 1000) {
          const pointerId = draft.pointerId;
          finishStroke();
          if (inkCapacity()) draft = { pointerId, points: [next], color: '#111111', width: 0.008, started: Date.now() };
        }
      }
      drawAll();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(type, event => {
      if (draft?.pointerId !== event.pointerId) return;
      finishStroke();
      if (pad.hasPointerCapture(event.pointerId)) pad.releasePointerCapture(event.pointerId);
      render();
    });
  }

  function inkCapacity() {
    const slot = state?.round?.slots?.[state.me?.artistSlot];
    const strokes = [...(slot?.drawing || []), ...optimistic.map(entry => entry.stroke)];
    const points = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + (draft?.points.length || 0);
    return strokes.length < 200 && points < 8000;
  }

  function finishStroke() {
    if (!draft) return;
    const stroke = { points: draft.points, color: '#111111', width: 0.008 };
    draft = null;
    const entry = { stroke };
    optimistic.push(entry);
    drawAll();
    socketCommand('stroke', { stroke }).catch(error => {
      optimistic = optimistic.filter(item => item !== entry);
      notify(error.message);
      refresh();
    }).finally(() => { drawAll(); updateDrawControls(); });
    updateDrawControls();
  }

  function drawAll() {
    app.querySelectorAll('[data-drawing]').forEach(svg => {
      const index = Number(svg.dataset.drawing);
      const slot = state?.round?.slots?.[index];
      const group = svg.querySelector('.strokes');
      if (!group) return;
      const strokes = [...(slot?.drawing || [])];
      if (page === 'player' && index === state.me?.artistSlot) {
        for (const entry of optimistic) {
          if (!strokes.some(stroke => JSON.stringify(stroke.points) === JSON.stringify(entry.stroke.points))) strokes.push(entry.stroke);
        }
        if (draft) strokes.push(draft);
      }
      const fragment = document.createDocumentFragment();
      for (const stroke of strokes) {
        if (!stroke.points?.length) continue;
        const path = document.createElementNS(SVG_NS, 'path');
        const points = stroke.points.map(point => [Math.max(0, Math.min(1, point.x)) * 1200, Math.max(0, Math.min(1, point.y)) * 900]);
        path.setAttribute('d', points.map((point, i) => `${i ? 'L' : 'M'}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(' ') + (points.length === 1 ? ` l0.01,0` : ''));
        path.setAttribute('stroke', '#111111');
        path.setAttribute('stroke-width', String((stroke.width || 0.008) * 1200));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        fragment.append(path);
      }
      group.replaceChildren(fragment);
    });
  }

  function tick() {
    const deadline = state?.round?.slots?.[state.me?.artistSlot]?.deadline;
    if (draft && deadline && timeLeft(deadline) <= 1 && canDrawNow() && connected() && Date.now() - draft.started >= 250) {
      const pointerId = draft.pointerId;
      const last = draft.points.at(-1);
      finishStroke();
      if (inkCapacity()) draft = { pointerId, points: [last], color: '#111111', width: 0.008, started: Date.now() };
    }
    app.querySelectorAll('[data-deadline]').forEach(element => {
      const left = timeLeft(Number(element.dataset.deadline));
      element.querySelector('span').textContent = `${left}s`;
      element.classList.toggle('urgent', left <= 5);
      element.setAttribute('aria-label', `${left} seconds remaining`);
    });
    app.querySelectorAll('[data-progress-deadline]').forEach(element => {
      const remaining = Math.max(0, Math.min(30, (Number(element.dataset.progressDeadline) - Date.now() - offset) / 1000));
      element.querySelector('.guess-progress-fill').style.width = `${remaining / 30 * 100}%`;
      element.querySelector('span').textContent = `${Math.ceil(remaining)}s to guess`;
      element.setAttribute('aria-valuenow', String(Math.ceil(remaining)));
    });
    app.querySelectorAll('.wheel[data-winner]').forEach(element => {
      const winner = Number(element.dataset.winner);
      if (winner >= 0) element.style.transform = `rotate(${-90 - (winner * 45 + 22.5)}deg)`;
    });
    document.querySelectorAll('#guess-form input, #guess-form button').forEach(element => {
      element.disabled = busy || timeLeft(state.round.deadline) <= 0;
    });
    app.querySelectorAll('button.card-choice').forEach(element => {
      const submitting = element.dataset.action === 'submit-card';
      const payload = JSON.parse(element.dataset.payload);
      element.disabled = busy || !state.round || timeLeft(state.round.deadline) <= 0 ||
        (submitting ? state.round.stage !== 'submitting' || !state.me.canSubmit || state.me.submitted :
          state.round.stage !== 'voting' || !!state.me.votedFor || payload.submissionId === state.me.ownSubmissionId);
    });
    app.querySelectorAll('#caption-form textarea, #submit-caption').forEach(element => {
      element.disabled = busy || state.round?.stage !== 'captioning' || timeLeft(state.round.deadline) <= 0;
    });
    app.querySelectorAll('button.picture-choice').forEach(element => {
      const voting = element.dataset.action === 'vote-caption';
      const payload = JSON.parse(element.dataset.payload);
      element.disabled = busy || !state.round || timeLeft(state.round.deadline) <= 0 ||
        (voting ? state.round.stage !== 'voting' || !!state.me?.votedFor || payload.submissionId === state.me?.ownSubmissionId :
          state.round.stage !== 'judging' || !state.me?.isJudge || state.me?.nominated);
    });
    updateDrawControls();
  }

  window.addEventListener('online', () => {
    if (!socket || socket.readyState === WebSocket.CLOSED) connect();
    refresh();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(tick, 250);
  setInterval(() => {
    if (page === 'display' && isPicture() && state.round?.finalists.length > 6 &&
      ['voting', 'revealed', 'results'].includes(state.round.stage)) {
      displayCaptionPage++;
      render(true);
    }
  }, 8000);
  setInterval(() => { if (!connected() && !busy) refresh(); }, 15000);
  refresh();
  connect();
})();
