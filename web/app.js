import { draftFromSnapshot, draftSignature, evaluateDraft, formatRanges, formatTime, groupStartLineups, saveInput, selectAllTimes, selectGridTime, selectionFromDraft, setResponse, strongestSlot } from './model.js';
import { EventDecoder } from './stream.js';

const $ = (id) => document.getElementById(id);
const demoMode = new URLSearchParams(location.search).get('demo') === '1';
const telegram = window.Telegram?.WebApp;
const native = !demoMode && Boolean(telegram?.initData);
const initData = native ? telegram.initData : '';
let nativeMainReady = false;
const state = {
  snapshot: null, draft: null, baseline: '', revision: '', editing: true, saving: false,
  conflict: false, fatal: false, selectedSlot: null, connection: 'connecting',
  serverAnchor: 0, clockAnchor: 0, controller: null, reconnectTimer: null,
  streamAttempt: 0, streamGeneration: 0, refreshPromise: null, demo: null,
  rangeSelection: { rangeMode: true, anchor: null },
  showingResults: null, groupDetailsWereOpen: false,
  reminding: false, demoReminderAvailableAt: 0,
};

function now() { return state.serverAnchor + performance.now() - state.clockAnchor; }
function closed() { return Boolean(state.snapshot && (state.snapshot.session.closed || now() >= state.snapshot.session.closesAt)); }
function dirty() { return Boolean(state.draft && (draftSignature(state.draft) !== state.baseline || state.rangeSelection.anchor !== null)); }
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function nativeCall(fn) {
  if (!native) return;
  try { fn(telegram); } catch { /* Unsupported Telegram clients keep the in-page controls. */ }
}
function updateNativeMain(text, enabled) {
  if (!nativeMainReady) return;
  try {
    if (state.editing && !state.fatal) {
      telegram.MainButton.setText(text);
      telegram.MainButton.show();
      if (state.saving) telegram.MainButton.showProgress();
      else telegram.MainButton.hideProgress();
      if (enabled) telegram.MainButton.enable();
      else telegram.MainButton.disable();
      // Only replace the in-page Save after the native control successfully renders.
      document.body.classList.add('native-button');
    } else telegram.MainButton.hide();
  } catch {
    nativeMainReady = false;
    document.body.classList.remove('native-button');
    nativeCall((tg) => tg.MainButton.hide());
  }
}
function announce(message) { $('announcement').textContent = message; }
function showError(message) {
  $('save-error').textContent = message;
  $('save-error').hidden = !message;
}
function setConnection(status) {
  state.connection = status;
  const labels = { connecting: 'Connecting', live: 'Live', offline: 'Reconnecting', paused: 'Paused', demo: 'Demo', ended: 'Ended', error: 'Unavailable' };
  $('connection').textContent = labels[status];
  $('connection').dataset.state = status;
  $('connection-notice').hidden = !state.snapshot || !['offline', 'connecting'].includes(status);
  $('connection-message').textContent = 'Live updates are reconnecting. Your selections are safe.';
}

function fatal(title, message, retry = false) {
  state.fatal = true;
  stopStream();
  setConnection('error');
  $('loading').hidden = true;
  $('fatal').hidden = false;
  $('fatal-title').textContent = title;
  $('fatal-message').textContent = message;
  $('fatal-retry').hidden = !retry;
  // If a connection expires mid-edit, preserve and show the draft underneath.
  $('content').hidden = !state.snapshot;
  $('connection-notice').hidden = true;
  updateFormChrome();
  nativeCall((tg) => tg.MainButton.hide());
}

function apiError(response, body) {
  const details = body?.error ?? body;
  const error = new Error(details?.message || `The request failed (${response.status}). Please try again.`);
  error.code = details?.code || 'REQUEST_FAILED';
  error.status = response.status;
  return error;
}

async function request(path, input) {
  if (demoMode) throw new Error('Demo mode cannot access the live API.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `tma ${initData}`, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: input === undefined ? undefined : JSON.stringify(input),
      credentials: 'omit', cache: 'no-store', signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw apiError(response, body);
    if (!body) throw new Error('The server returned an incomplete answer. Please try again.');
    return body;
  } finally { clearTimeout(timeout); }
}

function isAuthorizationError(error) { return error.status === 401 || error.status === 403 || error.status === 404; }
function authFailure(error) {
  if (error.status === 403 || error.code === 'FORBIDDEN') {
    fatal('This session isn’t available to you', 'Ask the organizer to add you to this group’s roster, then reopen the session from its group message.');
  } else if (error.status === 404) {
    fatal('Session not found', 'Return to the group and open the current availability message.');
  } else {
    fatal('Reopen from the group', 'Your Telegram connection has expired or could not be verified. Your draft is still here; reopen “Set my availability” in the group to reconnect.');
  }
}

async function refreshSnapshot() {
  if (demoMode || state.fatal) return;
  if (state.refreshPromise) return state.refreshPromise;
  state.refreshPromise = request('/api/session').then((snapshot) => {
    acceptSnapshot(snapshot);
    return snapshot;
  }).catch((error) => {
    if (isAuthorizationError(error)) authFailure(error);
    else setConnection('offline');
    throw error;
  }).finally(() => { state.refreshPromise = null; });
  return state.refreshPromise;
}

function loadSavedDraft() {
  if (!state.snapshot) return;
  state.draft = draftFromSnapshot(state.snapshot, now());
  state.rangeSelection = selectionFromDraft(state.draft);
  state.baseline = draftSignature(state.draft);
  state.revision = state.snapshot.me.revision;
  state.conflict = false;
  renderTimeGrid();
  updateFormChrome();
}

function acceptSnapshot(snapshot) {
  // GET, POST and the live stream can finish out of order.
  if (state.snapshot && snapshot.serverNow < state.snapshot.serverNow) return;
  const first = !state.snapshot;
  state.snapshot = snapshot;
  state.serverAnchor = snapshot.serverNow;
  state.clockAnchor = performance.now();
  if (first) {
    state.editing = !snapshot.me.responded && !snapshot.me.skipped && !closed();
    loadSavedDraft();
  } else if (!state.saving && snapshot.me.revision !== state.revision) {
    if (state.editing && dirty()) {
      state.conflict = true;
    } else {
      state.editing = !snapshot.me.responded && !snapshot.me.skipped && !closed();
      loadSavedDraft();
    }
  }
  $('loading').hidden = true;
  $('content').hidden = false;
  renderShared();
  updateFormChrome();
  if (closed()) {
    stopStream();
    if (!demoMode) setConnection('ended');
  }
}

function stopStream() {
  state.streamGeneration += 1;
  state.controller?.abort();
  state.controller = null;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
}

function scheduleReconnect() {
  if (state.fatal || document.hidden || demoMode || closed()) return;
  clearTimeout(state.reconnectTimer);
  setConnection('offline');
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(state.streamAttempt++, 5)) + Math.random() * 400;
  state.reconnectTimer = setTimeout(() => {
    // The SSE stream begins with a complete current snapshot, including changes missed offline.
    connectStream();
  }, delay);
}

async function connectStream() {
  if (demoMode || state.fatal || document.hidden || closed()) return;
  stopStream();
  const generation = state.streamGeneration;
  const controller = new AbortController();
  state.controller = controller;
  let watchdog;
  let streamError = null;
  const resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), 45_000);
  };
  try {
    resetWatchdog();
    const response = await fetch('/api/events', {
      headers: { Authorization: `tma ${initData}`, Accept: 'text/event-stream' },
      credentials: 'omit', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw apiError(response, await response.json().catch(() => null));
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('Live updates are unavailable.');
    }
    const decoder = new EventDecoder((event, data) => {
      if (event === 'session') {
        acceptSnapshot(JSON.parse(data));
        setConnection(closed() ? 'ended' : 'live');
        state.streamAttempt = 0;
      } else if (event === 'error') {
        const details = JSON.parse(data);
        streamError = new Error(details.message);
        streamError.code = details.code;
        if (['UNAUTHORIZED', 'INVALID_AUTH', 'EXPIRED_AUTH', 'AUTH_EXPIRED'].includes(details.code)) streamError.status = 401;
        if (details.code === 'FORBIDDEN') streamError.status = 403;
        if (details.code === 'NOT_FOUND') streamError.status = 404;
        controller.abort();
      }
    });
    const reader = response.body.getReader();
    const utf8 = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (generation !== state.streamGeneration) break;
        resetWatchdog();
        decoder.push(utf8.decode(value, { stream: true }));
      }
    } finally { reader.releaseLock(); }
    if (streamError) throw streamError;
  } catch (error) {
    if (generation !== state.streamGeneration) return;
    const failure = streamError || error;
    if (isAuthorizationError(failure)) authFailure(failure);
  } finally {
    clearTimeout(watchdog);
    if (generation === state.streamGeneration && !state.fatal && !document.hidden) scheduleReconnect();
  }
}

async function resume() {
  if (demoMode || state.fatal || document.hidden) return;
  setConnection('connecting');
  await refreshSnapshot().catch(() => {
    if (!state.snapshot && !state.fatal) fatal('Couldn’t load this session', 'Check your connection, then try again.', true);
  });
  if (closed()) setConnection('ended');
  else if (!state.fatal) connectStream();
}

function playerNames(ids) {
  return ids.map((id) => {
    const player = state.snapshot.players.find((entry) => entry.id === id);
    return player ? (id === state.snapshot.me.id && player.displayName !== 'You' ? `${player.displayName} (you)` : player.displayName) : 'Player';
  }).join(', ');
}

function answerText(person) {
  if (person.skipped) return 'Skipped for this session';
  if (!person.responded) return 'Not answered yet';
  const parts = [];
  const yes = formatRanges(person.votes, 'yes');
  const maybe = formatRanges(person.votes, 'maybe');
  if (yes) parts.push(`${person.filler ? 'If needed' : 'In'}: ${yes}`);
  if (maybe) parts.push(`${person.filler ? 'If needed · maybe' : 'Maybe'}: ${maybe}`);
  return parts.join(' · ') || 'Can’t play';
}

function renderShared() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const date = new Date(`${snapshot.session.date}T12:00:00Z`);
  $('session-date').textContent = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
  $('session-meta').textContent = `Starts ${formatTime(snapshot.slots[0]?.minutes ?? snapshot.session.startMinutes)}–${formatTime(snapshot.slots.at(-1)?.minutes ?? snapshot.session.startMinutes)} · ${snapshot.session.timezone}`;
  $('group-meta').textContent = `Opened by ${snapshot.session.openerName}. Only saved replies count.`;
  $('closed-banner').hidden = !closed();
  const responded = snapshot.players.filter((player) => player.responded || player.skipped).length;
  $('reply-count').textContent = `${responded}/${snapshot.players.length} answered`;
  $('roster-count').textContent = `(${snapshot.players.length})`;
  const strongest = strongestSlot(snapshot.slots, now());
  if (snapshot.lock) {
    $('overlap').textContent = `${snapshot.lock.size}-stack at ${formatTime(snapshot.lock.slot)}${closed() ? ' · final saved party' : ''}`;
    $('party').hidden = false;
    $('party').textContent = `${playerNames(snapshot.lock.core)}${snapshot.lock.alternates.length ? ` · Alternates: ${playerNames(snapshot.lock.alternates)}` : ''}`;
  } else {
    $('party').hidden = true;
    $('overlap').textContent = strongest && (strongest.yes || strongest.maybe || strongest.filler)
      ? `Strongest start: ${formatTime(strongest.minutes)} · ${strongest.yes} in${strongest.maybe ? ` + ${strongest.maybe} maybe` : ''}${strongest.filler ? ` + ${strongest.filler} if needed` : ''}`
      : closed() ? 'No party formed for this session.' : 'Waiting for the first overlapping answers.';
  }
  const windows = $('party-windows');
  windows.replaceChildren();
  windows.hidden = !snapshot.parties?.length;
  if (snapshot.parties?.length) {
    windows.append(el('h3', '', 'Playable parties'));
    for (const party of snapshot.parties) {
      const range = party.endSlot - 30 === party.slot ? formatTime(party.slot) : `${formatTime(party.slot)}–${formatTime(party.endSlot - 30)}`;
      const players = party.core.map(id => `${playerNames([id])}${party.fillerIds.includes(id) ? ' (if needed)' : party.maybeIds.includes(id) ? ' (maybe)' : ''}`).join(', ');
      const row = el('div', 'party-window');
      row.append(el('strong', '', `${range} · ${party.size}-stack`), el('p', 'caption', players));
      windows.append(row);
    }
    windows.append(el('p', 'caption', 'Each entry lists possible starts for that lineup. Later parties don’t delay earlier ones.'));
  }
  if (state.selectedSlot === null) state.selectedSlot = snapshot.lock?.slot ?? strongest?.minutes ?? snapshot.slots[0]?.minutes;
  renderRail();
  const players = $('players');
  players.replaceChildren();
  for (const person of snapshot.players) {
    const row = el('li', 'player');
    const name = el('span', 'player-name', person.displayName);
    if (person.id === snapshot.me.id && person.displayName !== 'You') name.append(el('span', 'you', ' · you'));
    const answer = el('div', 'player-answer');
    if (person.skipped || !person.responded || !person.votes.some((vote) => vote.value !== 'no')) {
      answer.append(el('p', 'muted', answerText(person)));
    } else {
      const yes = formatRanges(person.votes, 'yes');
      const maybe = formatRanges(person.votes, 'maybe');
      if (yes) answer.append(el('p', person.filler ? 'muted' : 'yes', `${person.filler ? 'If needed' : 'In'} · ${yes}`));
      if (maybe) answer.append(el('p', 'maybe', `${person.filler ? 'If needed · maybe' : 'Maybe'} · ${maybe}`));
      if (person.lateMinutes) answer.append(el('p', 'caption', `${person.lateMinutes} min late`));
      const voted = new Set(person.votes.map((vote) => vote.slot));
      if (snapshot.slots.some((slot) => slot.startsAt > now() && !voted.has(slot.minutes))) answer.append(el('p', 'caption', 'Other starts not answered'));
    }
    row.append(name, answer);
    players.append(row);
  }
  renderLineups();
  $('saved-summary').textContent = answerText(snapshot.me);
  $('saved-title').textContent = snapshot.me.skipped ? 'You’re skipped for this session' : snapshot.me.responded ? 'Your availability is saved' : 'You haven’t answered yet';
  $('saved-note').textContent = closed() ? 'This session has ended.' : snapshot.me.skipped ? 'Edit to join the session again.' : demoMode ? 'Demo only · Group updates are simulated.' : 'Saved. Group replies update live below.';
  $('edit').disabled = closed() || state.fatal;
  $('edit').textContent = snapshot.me.responded || snapshot.me.skipped ? 'Edit availability' : 'Set my availability';
  renderReminder();
}

function renderReminder() {
  if (!state.snapshot) return;
  const pending = state.snapshot.players.filter(player => !player.responded && !player.skipped).length;
  const full = state.snapshot.lock && state.snapshot.lock.size >= Math.max(...state.snapshot.session.validStacks);
  const started = state.snapshot.lock && state.snapshot.slots.some(slot => slot.minutes === state.snapshot.lock.slot && slot.startsAt <= now());
  $('reminder-controls').hidden = closed() || !pending || Boolean(full) || Boolean(started);
  const availableAt = demoMode ? state.demoReminderAvailableAt : state.snapshot.reminderAvailableAt || 0;
  const minutes = Math.max(0, Math.ceil((availableAt - now()) / 60_000));
  $('remind-non-voters').disabled = state.reminding || state.fatal || minutes > 0;
  $('remind-non-voters').textContent = state.reminding ? 'Sending reminder…' : '🔔 Remind non-voters';
  $('reminder-hint').textContent = minutes > 0 ? `Remind again in ${minutes} min.` : `Nudge ${pending} ${pending === 1 ? 'person who hasn’t' : 'people who haven’t'} answered in the group chat.`;
}

async function remindNonVoters() {
  if (!state.snapshot || closed() || state.reminding || state.fatal || $('remind-non-voters').disabled) return;
  state.reminding = true;
  $('reminder-status').hidden = true;
  renderReminder();
  try {
    const result = demoMode
      ? { message: 'Demo reminder sent. No real message was posted.', nextAllowedAt: now() + 15 * 60_000 }
      : await request('/api/reminder', {});
    if (demoMode) state.demoReminderAvailableAt = result.nextAllowedAt;
    else state.snapshot.reminderAvailableAt = result.nextAllowedAt;
    $('reminder-status').textContent = result.message;
    announce(result.message);
  } catch (error) {
    if (isAuthorizationError(error)) authFailure(error);
    $('reminder-status').textContent = error.name === 'AbortError' ? 'Could not confirm the reminder. Try again to check.' : error.message;
  } finally {
    state.reminding = false;
    $('reminder-status').hidden = false;
    renderReminder();
  }
}

function renderLineups() {
  const snapshot = state.snapshot;
  const waiting = snapshot.players.filter((player) => !player.responded && !player.skipped).map((player) => player.id);
  $('waiting-summary').textContent = waiting.length ? `Waiting for: ${playerNames(waiting)}` : 'Everyone has replied.';
  const lineups = $('lineups');
  lineups.replaceChildren();
  const groups = groupStartLineups(snapshot, now(), closed());
  for (const group of groups) {
    const row = el('article', 'lineup');
    const times = group.from === group.to ? formatTime(group.from) : `${formatTime(group.from)}–${formatTime(group.to)}`;
    const heading = el('div', 'lineup-heading');
    heading.append(el('h4', 'lineup-time', times));
    const total = group.yes.length + group.maybe.length + group.filler.length;
    heading.append(el('span', 'caption', `${total} available`));
    row.append(heading);
    for (const [label, ids, className] of [['In', group.yes, 'yes'], ['Maybe', group.maybe, 'maybe'], ['If needed', group.filler, 'muted'], ['Waiting', group.waiting, 'muted']]) {
      if (!ids.length) continue;
      const answer = el('p', `lineup-answer ${className}`);
      answer.append(el('span', 'lineup-label', label), el('span', '', playerNames(ids)));
      row.append(answer);
    }
    if (!total) row.append(el('p', 'caption', 'No one available yet.'));
    if (group.no) row.append(el('p', 'lineup-unavailable caption', `${group.no} unavailable`));
    lineups.append(row);
  }
  if (!groups.length) lineups.append(el('p', 'caption', 'All start times have passed. Saved player replies remain above.'));
}

function updateViewMode() {
  const results = !state.editing;
  const details = $('group-details');
  if (results !== state.showingResults) {
    if (results) {
      state.groupDetailsWereOpen = details.open;
      details.open = true;
    } else if (state.showingResults !== null) details.open = state.groupDetailsWereOpen;
    state.showingResults = results;
  }
  document.body.classList.toggle('showing-results', results);
  $('session-title').textContent = closed() ? 'Session ended' : results ? 'Who can play?' : 'When can you play?';
  $('group-title').textContent = results ? 'Everyone’s availability' : 'The group, so far';
  $('group-disclosure').hidden = results;
  $('waiting-summary').hidden = !results;
  $('start-lineups').hidden = !results;
  $('time-rail').hidden = results;
  $('slot-detail').hidden = results;
}

function renderRail() {
  const snapshot = state.snapshot;
  const rail = $('time-rail');
  const first = !rail.children.length;
  // Keep the actual buttons, focus and scroll position through other players’ updates.
  for (const slot of snapshot.slots) {
    let button = rail.querySelector(`[data-slot="${slot.minutes}"]`);
    if (!button) {
      button = el('button', 'time-slot');
      button.type = 'button';
      button.dataset.slot = String(slot.minutes);
      button.append(el('span', 'slot-time', formatTime(slot.minutes)), el('span', 'slot-in'), el('span', 'slot-maybe'), el('span', 'slot-filler'));
      button.addEventListener('click', () => { state.selectedSlot = slot.minutes; renderRail(); });
      rail.append(button);
    }
    button.classList.toggle('is-past', slot.startsAt <= now());
    button.setAttribute('aria-pressed', String(slot.minutes === state.selectedSlot));
    button.setAttribute('aria-label', `${formatTime(slot.minutes)}: ${slot.yes} in, ${slot.maybe} maybe, ${slot.filler} if needed${slot.startsAt <= now() ? ', start has passed' : ''}`);
    button.children[1].textContent = `${slot.yes} in`;
    button.children[2].textContent = slot.maybe ? `+ ${slot.maybe} maybe` : '—';
    button.children[3].textContent = slot.filler ? `+ ${slot.filler} if needed` : '';
  }
  if (first) {
    const selected = rail.querySelector('[aria-pressed="true"]');
    if (selected) requestAnimationFrame(() => { rail.scrollLeft = selected.offsetLeft - rail.offsetLeft - (rail.clientWidth - selected.clientWidth) / 2; });
  }
  const slot = snapshot.slots.find((item) => item.minutes === state.selectedSlot);
  const detail = $('slot-detail');
  detail.replaceChildren();
  if (!slot) return;
  detail.append(el('p', 'slot-heading', `Starting at ${formatTime(slot.minutes)}${slot.startsAt <= now() ? ' · passed' : ''}`));
  for (const [label, ids, className] of [['In', slot.yesUserIds, 'yes'], ['Maybe', slot.maybeUserIds, 'maybe'], ['Only if needed', slot.fillerUserIds, 'muted']]) {
    if (ids.length) detail.append(el('p', className, `${label}: ${playerNames(ids)}`));
  }
  if (!slot.yes && !slot.maybe && !slot.filler) detail.append(el('p', 'muted', 'No available players at this start yet.'));
  if (slot.notVoted || slot.no) detail.append(el('p', 'caption', [slot.notVoted ? `${slot.notVoted} unanswered` : '', slot.no ? `${slot.no} unavailable` : ''].filter(Boolean).join(' · ')));
}

function changed() {
  showError('');
  updateFormChrome();
  nativeCall((tg) => tg.HapticFeedback?.selectionChanged());
}

function renderTimeGrid() {
  if (!state.draft || !state.snapshot) return;
  const grid = $('time-grid');
  const selected = new Map(state.draft.votes.map((vote) => [vote.slot, vote.value]));
  // Update the existing buttons in place: live counts must not steal focus or clear selections.
  for (const slot of state.snapshot.slots) {
    let button = grid.querySelector(`[data-time="${slot.minutes}"]`);
    if (!button) {
      button = el('button', 'choice-time');
      button.type = 'button';
      button.dataset.time = String(slot.minutes);
      button.append(el('span', 'choice-mark'), el('span', 'choice-label', formatTime(slot.minutes)), el('span', 'choice-count'));
      button.addEventListener('click', () => {
        if (state.saving || closed() || state.fatal) return;
        // The button survives live updates; validate time against the current snapshot.
        selectGridTime(state.draft, state.rangeSelection, state.snapshot.slots, now(), slot.minutes);
        changed();
      });
      grid.append(button);
    }
    const value = selected.get(slot.minutes);
    const isSelected = value !== undefined;
    const isAnchor = state.rangeSelection.anchor === slot.minutes;
    const passed = slot.startsAt <= now();
    const count = slot.yes + slot.maybe + slot.filler;
    const response = state.draft.filler ? 'only if needed' : value === 'maybe' ? 'maybe' : 'in';
    button.hidden = passed && !isSelected && !isAnchor;
    button.disabled = passed;
    button.setAttribute('aria-pressed', String(isSelected));
    button.setAttribute('aria-label', `${formatTime(slot.minutes)}${isAnchor ? ', range start chosen' : isSelected ? `, selected ${response}` : ', not selected'}, ${count} available${passed ? ', start has passed' : ''}`);
    button.classList.toggle('is-maybe', isSelected && value === 'maybe');
    button.classList.toggle('is-anchor', isAnchor);
    button.classList.toggle('is-past', passed);
    button.children[0].textContent = isAnchor ? '1' : isSelected ? value === 'maybe' ? '?' : state.draft.filler ? '↗' : '✓' : '';
    button.children[0].setAttribute('aria-hidden', 'true');
    button.children[2].textContent = passed ? 'Passed' : count ? `${count} available` : '—';
  }
}

function updateFormChrome() {
  if (!state.snapshot || !state.draft) return;
  const isClosed = closed();
  updateViewMode();
  $('editor').hidden = !state.editing;
  $('saved-view').hidden = state.editing;
  $('cancel').hidden = !state.snapshot.me.responded && !state.snapshot.me.skipped;
  $('cancel').disabled = state.saving;
  $('edit-fields').disabled = state.saving || isClosed || state.fatal;
  $('conflict').hidden = !state.conflict;
  $('conflict-saved').textContent = `Latest saved answer: ${answerText(state.snapshot.me)}.`;
  $('reload-saved').disabled = state.saving;
  $('keep-draft').disabled = state.saving || isClosed || state.fatal;
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === state.draft.mode));
  $('times').hidden = state.draft.mode === 'no';
  $('editor-saved-status').textContent = state.snapshot.me.responded || state.snapshot.me.skipped ? `Saved: ${answerText(state.snapshot.me)}` : 'Not answered yet';
  $('mixed-response').hidden = state.draft.response !== 'mixed';
  $('response-type').value = state.draft.response;
  $('response-badge').textContent = state.draft.response === 'maybe' ? '· Maybe' : state.draft.response === 'filler' ? '· Only if needed' : state.draft.response === 'mixed' ? '· Mixed saved replies' : '';
  $('response-note').textContent = state.draft.response === 'filler'
    ? 'You can help complete a party. Confirmed players and maybes get seats first.'
    : state.draft.response === 'maybe' ? 'You’re not confirmed. The bot may ask you to confirm.'
      : state.draft.response === 'mixed' ? 'Your saved maybes keep their ? mark. New times mean “I’m in”. Choosing a response here changes all selected times.'
        : 'You’re available at every selected start. Changing this response applies to all selected times.';
  const evaluated = evaluateDraft(state.draft, state.snapshot.slots, now(), state.rangeSelection);
  $('time-instruction').textContent = state.rangeSelection.rangeMode ? state.rangeSelection.anchor === null ? '1. Tap earliest start.' : '2. Tap latest start.' : 'Tap to add or remove.';
  $('grid-note').textContent = state.rangeSelection.anchor !== null
    ? `From ${formatTime(state.rangeSelection.anchor)}. Tap the same time again for one start.`
    : state.rangeSelection.rangeMode ? 'Two taps select a range. Counts are saved replies.' : 'Counts are saved replies. Only Save submits your choices.';
  $('add-range').hidden = state.rangeSelection.rangeMode || !state.draft.votes.length;
  $('cancel-range').hidden = !state.rangeSelection.rangeMode || (state.rangeSelection.anchor === null && !state.draft.votes.length);
  $('all-times').disabled = !state.snapshot.slots.some((slot) => slot.startsAt > now());
  $('clear-times').disabled = !state.draft.votes.length && state.rangeSelection.anchor === null && state.rangeSelection.rangeMode;
  renderTimeGrid();
  if (state.draft.mode === 'no' && evaluated.valid) $('draft-summary').textContent = 'You’re out for this session.';
  else if (evaluated.valid) {
    const lines = [];
    const yes = formatRanges(evaluated.votes, 'yes');
    const maybe = formatRanges(evaluated.votes, 'maybe');
    if (yes) lines.push(`${state.draft.filler ? 'If needed' : 'Selected'}: ${yes}`);
    if (maybe) lines.push(`${state.draft.filler ? 'If needed · maybe' : 'Maybe'}: ${maybe}`);
    $('draft-summary').textContent = lines.join(' · ');
  } else $('draft-summary').textContent = evaluated.message;
  const futureCount = state.snapshot.slots.filter((slot) => slot.startsAt > now()).length;
  $('draft-outside').textContent = isClosed ? 'This session has ended. Your draft was not submitted.'
    : !evaluated.valid ? 'Nothing changes until you save.'
      : `${state.draft.mode === 'no' ? 'All remaining start times will be declined.' : evaluated.votes.length === futureCount ? 'Every remaining start time is included.' : 'All other remaining start times will be declined.'}${evaluated.expiredCount ? ' Earlier starts have passed and will not be changed.' : ''}`;
  const enabled = evaluated.valid && dirty() && !state.conflict && !state.saving && !isClosed && !state.fatal;
  const text = state.saving ? 'Saving…' : isClosed ? 'Session ended' : state.draft.mode === 'no' ? 'Save: can’t play' : 'Save availability';
  $('save').disabled = !enabled;
  $('save').textContent = text;
  $('save-note').textContent = state.conflict ? 'Resolve the changed answer above before saving.' : !dirty() && state.snapshot.me.responded ? 'Your saved answer is up to date.' : demoMode ? 'Demo only · No real availability is changed.' : 'Only you can see your unfinished answer.';
  updateNativeMain(text, enabled);
  nativeCall((tg) => {
    if (state.editing && (state.snapshot.me.responded || dirty())) tg.BackButton.show();
    else tg.BackButton.hide();
  });
  nativeCall((tg) => {
    if (dirty() && state.editing) tg.enableClosingConfirmation();
    else tg.disableClosingConfirmation();
  });
}

async function save() {
  if (state.saving || state.conflict || closed() || state.fatal || !dirty()) return;
  let input;
  try { input = saveInput(state.draft, state.snapshot.slots, now(), state.revision, state.rangeSelection); }
  catch (error) { showError(error.message); return; }
  state.saving = true;
  showError('');
  updateFormChrome();
  try {
    const snapshot = demoMode ? state.demo.save(input) : await request('/api/availability', input);
    acceptSnapshot(snapshot);
    state.saving = false;
    state.editing = false;
    loadSavedDraft();
    renderShared();
    updateFormChrome();
    nativeCall((tg) => tg.HapticFeedback?.notificationOccurred('success'));
    announce(demoMode ? 'Your demo availability is saved.' : 'Your availability is saved. The group has been updated.');
    $('saved-view').scrollIntoView({ behavior: 'auto', block: 'nearest' });
  } catch (error) {
    state.saving = false;
    if (isAuthorizationError(error)) authFailure(error);
    else if (error.status === 409 || error.status === 410) {
      await refreshSnapshot().catch(() => {});
      if (error.code === 'CLOSED' || error.status === 410 || closed()) {
        state.snapshot.session.closed = true;
        stopStream();
        setConnection('ended');
        renderShared();
        showError('This session has ended. Your draft was not submitted.');
      }
      else {
        state.conflict = true;
        showError('Your saved answer changed before this save finished. Choose an option above.');
      }
    } else {
      showError(error.name === 'AbortError' || error instanceof TypeError
        ? 'We couldn’t confirm the save. Your selections are still here. Reconnect to check your saved answer, then try again.'
        : error.message);
      refreshSnapshot().catch(() => {});
    }
    updateFormChrome();
    nativeCall((tg) => tg.HapticFeedback?.notificationOccurred('error'));
  }
}

function discardDraft() {
  loadSavedDraft();
  state.editing = !closed() && !state.snapshot.me.responded && !state.snapshot.me.skipped;
  showError('');
  updateFormChrome();
}

function confirmDiscard(onConfirm) {
  if (state.saving) return;
  if (!dirty()) { onConfirm(); return; }
  if (native && telegram.isVersionAtLeast?.('6.2')) {
    try {
      telegram.showPopup({ title: 'Discard your changes?', message: 'Your last saved availability will stay the same.', buttons: [
        { id: 'keep', type: 'cancel', text: 'Keep editing' }, { id: 'discard', type: 'destructive', text: 'Discard changes' },
      ] }, (id) => { if (id === 'discard') onConfirm(); });
      return;
    } catch { /* A limited client can still show the browser confirmation. */ }
  }
  if (window.confirm('Discard your changes? Your last saved availability will stay the same.')) onConfirm();
}

$('availability-form').addEventListener('submit', (event) => { event.preventDefault(); save(); });
$('remind-non-voters').addEventListener('click', remindNonVoters);
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
  state.draft.mode = button.dataset.mode;
  state.rangeSelection = selectionFromDraft(state.draft);
  changed();
});
$('all-times').addEventListener('click', () => {
  selectAllTimes(state.draft, state.snapshot.slots, now());
  state.rangeSelection = { rangeMode: false, anchor: null };
  changed();
});
$('clear-times').addEventListener('click', () => {
  state.draft.votes = [];
  state.rangeSelection = selectionFromDraft(state.draft);
  changed();
});
$('add-range').addEventListener('click', () => {
  state.rangeSelection = { rangeMode: true, anchor: null };
  changed();
});
$('cancel-range').addEventListener('click', () => {
  state.rangeSelection = selectionFromDraft(state.draft);
  changed();
});
$('response-type').addEventListener('change', () => {
  setResponse(state.draft, $('response-type').value);
  changed();
});
$('cancel').addEventListener('click', () => confirmDiscard(discardDraft));
$('edit').addEventListener('click', () => {
  if (closed() || state.fatal) return;
  state.editing = true;
  loadSavedDraft();
  showError('');
  updateFormChrome();
  $('editor').scrollIntoView({ behavior: 'auto', block: 'start' });
});
$('reload-saved').addEventListener('click', () => { loadSavedDraft(); showError(''); announce('Latest saved answer loaded.'); });
$('keep-draft').addEventListener('click', () => {
  state.revision = state.snapshot.me.revision;
  state.baseline = draftSignature(draftFromSnapshot(state.snapshot, now()));
  state.conflict = false;
  showError('');
  updateFormChrome();
  announce('Your draft is kept. Save to replace the latest answer.');
});
$('retry').addEventListener('click', resume);
$('fatal-retry').addEventListener('click', () => {
  state.fatal = false;
  $('fatal').hidden = true;
  $('loading').hidden = Boolean(state.snapshot);
  resume();
});
$('back-to-chat').addEventListener('click', () => nativeCall((tg) => tg.close()));
$('demo-update').addEventListener('click', () => {
  if (!demoMode || !state.demo) return;
  const result = state.demo.simulate();
  acceptSnapshot(result.snapshot);
  $('demo-update').textContent = result.message;
  announce(`Demo update: ${result.message} Your draft is unchanged.`);
});

document.addEventListener('visibilitychange', () => {
  if (demoMode || state.fatal) return;
  if (document.hidden) { stopStream(); setConnection('paused'); }
  else resume();
});
window.addEventListener('online', resume);
window.addEventListener('offline', () => { if (!demoMode && !state.fatal) { stopStream(); setConnection('offline'); } });
window.addEventListener('beforeunload', (event) => {
  if (dirty() && state.editing) { event.preventDefault(); event.returnValue = ''; }
});
// Age the display using a monotonic clock anchored to the server; never trust device clock settings.
setInterval(() => {
  if (!state.snapshot || document.hidden) return;
  const previousClosed = !$('closed-banner').hidden;
  renderShared();
  updateFormChrome();
  if (!previousClosed && closed()) {
    stopStream();
    if (!demoMode) setConnection('ended');
    announce('This session has ended. Unfinished changes were not submitted.');
  }
}, 15_000);

async function start() {
  if (demoMode) {
    const { createDemo } = await import('./demo.js');
    state.demo = createDemo();
    $('demo-banner').hidden = false;
    $('demo-controls').hidden = false;
    setConnection('demo');
    acceptSnapshot(state.demo.snapshot());
    return;
  }
  if (!native) {
    fatal('Open this in Telegram', 'Use “Set my availability” on your group’s session message. It opens your personal picker and connects you to the right group.');
    return;
  }
  nativeCall((tg) => tg.ready());
  // Respect the compact launch mode. The user can expand the sheet when needed.
  nativeCall((tg) => {
    if (!tg.isVersionAtLeast?.('6.1')) return;
    const required = ['onClick', 'setText', 'show', 'hide', 'showProgress', 'hideProgress', 'enable', 'disable'];
    if (!required.every((method) => typeof tg.MainButton?.[method] === 'function')) return;
    tg.MainButton.hide();
    tg.MainButton.onClick(save);
    nativeMainReady = true;
  });
  nativeCall((tg) => {
    tg.BackButton.hide();
    tg.BackButton.onClick(() => confirmDiscard(() => {
      if (!state.snapshot) return;
      if (state.snapshot.me.responded || state.snapshot.me.skipped) {
        loadSavedDraft();
        state.editing = false;
        showError('');
        updateFormChrome();
      }
      else { loadSavedDraft(); tg.close(); }
    }));
  });
  nativeCall((tg) => tg.onEvent('activated', resume));
  nativeCall((tg) => {
    tg.onEvent('themeChanged', () => { document.documentElement.style.colorScheme = tg.colorScheme || 'light dark'; });
    document.documentElement.style.colorScheme = tg.colorScheme || 'light dark';
  });
  $('back-to-chat').hidden = typeof telegram.close !== 'function';
  try {
    await refreshSnapshot();
    connectStream();
  } catch (error) {
    if (!state.fatal) fatal('Couldn’t load this session', 'Check your connection, then try again.', true);
  }
}

start().catch(() => fatal('Couldn’t open the picker', 'Close this panel and open it again from the group message.'));
