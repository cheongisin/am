import { modalConfirm } from './util.js';
import {
  genRoomCode, getState, setState, setBothState, getPrivateState,
  pullActions, clearActions
} from './gasApi.js';
import { PHASE, ROLE, ROLE_LABEL } from '../src/constants.js';
import { createGame, publicState, snapshot, undo } from '../src/gameState.js';
import { journalistReveal } from '../src/journalist.js';
import { execute } from '../src/execution.js';
import { checkWin } from '../src/win.js';
import { resolveNight } from './nightResolve.js';

const BUILD = '2026-02-02.1';

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('click', keepAwake, { once: true });

const app = document.getElementById('app');

// connected: 서버(GAS) 통신 가능 여부
// clientSeen: 진행자(Display)가 최소 1회 접속 신호(HELLO/PING)를 보냈는지
let connected = false;
let clientSeen = false;
let roomCode = '';
let hostBeatTimer = null;
let actionPollTimer = null;
let privatePollTimer = null;
let actionPollInFlight = false;
let syncInFlight = false;
let syncQueued = false;
let lastSyncError = null;

let lastActionId = null;
let pendingReporterReveal = null;

let actionPollFailures = 0;
let lastClientPingAt = 0;

const CONNECT_TIMEOUT_MS = 60000;      // 60초
const FAIL_TO_DISCONNECT = 6;          // 연속 실패 6번 후에만 🔴

let game = createGame(Array.from({ length: 8 }).map((_, i) => ({ id: i, name: `P${i + 1}` })));
let nightDraft = null;

function formatTimer(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
function getTimerRemaining(timer) {
  if (!timer || timer.mode !== 'COUNTDOWN') return null;
  if (timer.running && timer.endAt) return Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000));
  return Math.max(0, Math.floor(timer.durationSec || 0));
}
function setTimerInfinite() {
  game.timer = { mode: 'INFINITE', durationSec: 0, endAt: null, running: false };
}
function setTimerStopped() {
  game.timer = { mode: 'STOPPED', durationSec: 0, endAt: null, running: false };
}
function resetTimerForPhase() {
  if ([PHASE.NIGHT, PHASE.VOTE, PHASE.EXECUTION].includes(game.phase)) setTimerInfinite();
  else setTimerStopped();
}
function startCountdown(seconds, { record = true } = {}) {
  const s = Math.max(0, Number(seconds) || 0);
  if (record) snapshot(game);
  game.timer = { mode: 'COUNTDOWN', durationSec: s, endAt: Date.now() + s * 1000, running: true };
  game.timerConfig.daySec = s;
}
function pauseCountdown() {
  if (game.timer?.mode !== 'COUNTDOWN' || !game.timer?.running) return;
  const remaining = getTimerRemaining(game.timer);
  snapshot(game);
  game.timer = { mode: 'COUNTDOWN', durationSec: remaining, endAt: null, running: false };
}
function resumeCountdown() {
  if (game.timer?.mode !== 'COUNTDOWN' || game.timer?.running) return;
  const s = Math.max(0, Number(game.timer.durationSec) || 0);
  snapshot(game);
  game.timer = { mode: 'COUNTDOWN', durationSec: s, endAt: Date.now() + s * 1000, running: true };
}
function resetTimerManual() {
  snapshot(game);
  resetTimerForPhase();
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function rolePoolFor(n) {
  const pool = [
    ROLE.MAFIA, ROLE.SPY, ROLE.POLICE, ROLE.DOCTOR, ROLE.SOLDIER,
    ROLE.REPORTER, ROLE.POLITICIAN, ROLE.TERRORIST, ROLE.DETECTIVE, ROLE.ARMY
  ];
  while (pool.length < n) pool.push(ROLE.CITIZEN);
  return pool.slice(0, n);
}

const DECK_ROLE_ORDER = [
  ROLE.MAFIA,
  ROLE.SPY,
  ROLE.POLICE,
  ROLE.DOCTOR,
  ROLE.SOLDIER,
  ROLE.REPORTER,
  ROLE.POLITICIAN,
  ROLE.TERRORIST,
  ROLE.DETECTIVE,
  ROLE.ARMY,
  ROLE.CITIZEN,
];
const DECK_CONFIG_STORAGE_KEY = 'am.deckConfigByCount.v1';

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v ?? '0'), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function defaultDeckConfigFor(n) {
  const cfg = {};
  for (const r of DECK_ROLE_ORDER) cfg[r] = 0;
  for (const r of rolePoolFor(n)) cfg[r] = (cfg[r] || 0) + 1;
  return cfg;
}

function loadDeckConfigByCount() {
  try {
    const raw = localStorage.getItem(DECK_CONFIG_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveDeckConfigForCount(playerCount, cfg) {
  const byCount = loadDeckConfigByCount();
  byCount[String(playerCount)] = cfg;
  try { localStorage.setItem(DECK_CONFIG_STORAGE_KEY, JSON.stringify(byCount)); } catch {}
}

function sanitizeDeckConfig(cfg) {
  const out = {};
  for (const r of DECK_ROLE_ORDER) {
    if (r === ROLE.CITIZEN) continue; // 시민은 자동 계산
    out[r] = clampInt(cfg?.[r] ?? 0, 0, 3);
  }
  return out;
}

function getDeckConfigForGame() {
  const n = game.players.length;
  if (!game.deckConfig) {
    const byCount = loadDeckConfigByCount();
    const fromStorage = byCount[String(n)];
    game.deckConfig = sanitizeDeckConfig(fromStorage);
    if (!Object.keys(game.deckConfig).length) {
      game.deckConfig = sanitizeDeckConfig(defaultDeckConfigFor(n));
    }
  }
  // 누락 키 보정
  game.deckConfig = sanitizeDeckConfig(game.deckConfig);
  return game.deckConfig;
}

function computeDeckSummary(cfg, n) {
  const safe = sanitizeDeckConfig(cfg);
  const nonCitizenRoles = DECK_ROLE_ORDER.filter(r => r !== ROLE.CITIZEN);
  const sumNonCitizen = nonCitizenRoles.reduce((acc, r) => acc + (safe[r] || 0), 0);
  const citizenCount = n - sumNonCitizen;

  const errors = [];
  if ((safe[ROLE.MAFIA] || 0) < 1) errors.push('마피아는 최소 1장 필요합니다.');
  if (sumNonCitizen > n) errors.push(`특수직업 합계(${sumNonCitizen})가 인원(${n})을 초과합니다.`);
  if (citizenCount < 0) errors.push('시민 카드가 음수가 됩니다.');

  return {
    cfg: safe,
    n,
    sumNonCitizen,
    citizenCount,
    total: sumNonCitizen + Math.max(0, citizenCount),
    valid: errors.length === 0,
    errors,
  };
}

function buildDeckFromConfig(cfg, n) {
  const summary = computeDeckSummary(cfg, n);
  if (!summary.valid) {
    throw new Error(summary.errors[0] || '덱 구성이 올바르지 않습니다.');
  }
  const deck = [];
  for (const r of DECK_ROLE_ORDER) {
    if (r === ROLE.CITIZEN) continue;
    const c = summary.cfg[r] || 0;
    for (let i = 0; i < c; i++) deck.push(r);
  }
  for (let i = 0; i < summary.citizenCount; i++) deck.push(ROLE.CITIZEN);
  return deck;
}
function initNightDraft() {
  const find = (r) => game.players.find(p => p.role === r && p.alive)?.id ?? null;
  nightDraft = {
    mafiaId: find(ROLE.MAFIA), mafiaTarget: null,
    doctorId: find(ROLE.DOCTOR), doctorTarget: null,
    policeId: find(ROLE.POLICE), policeTarget: null,
    reporterId: find(ROLE.REPORTER), reporterUsed: false, reporterTarget: null,
    terroristId: find(ROLE.TERRORIST), terroristTarget: null
  };
}

async function sync() {
  if (!roomCode) return;
  if (syncInFlight) { syncQueued = true; return; }
  syncInFlight = true;
  const pub = {
    roomCode,
    hostHeartbeat: Date.now(),
    ...publicState(game),
  };

  // GAS ScriptProperties는 값 크기 제한이 있어 history는 저장하지 않음
  const priv = {
    phase: game.phase,
    night: game.night,
    timer: game.timer,
    timerConfig: game.timerConfig,
    players: game.players,
    deck: game.deck,
    deckUsed: game.deckUsed,
    votes: game.votes,
    executionTarget: game.executionTarget,
    journalistReveals: game.journalistReveals,
    reporterUsedOnce: game.reporterUsedOnce,
    eventQueue: game.eventQueue,
    winner: game.winner,
  };

  try {
    await setBothState(roomCode, { publicState: pub, privateState: priv });
    lastSyncError = null;
  } catch (e) {
    lastSyncError = e?.message || String(e);
    throw e;
  } finally {
    syncInFlight = false;
    if (syncQueued) {
      syncQueued = false;
      // 최신 game 상태로 한 번 더 flush
      sync();
    }
  }
}
function setConnected(flag) {
  connected = !!flag;
}

function markClientSeen() {
  clientSeen = true;
  lastClientPingAt = Date.now();
}

async function startRoom(code) {
  roomCode = String(code || '').trim();
  if (!/^\d{4}$/.test(roomCode)) throw new Error('4자리 코드가 필요합니다.');

  // ★ 시작시 변수 초기화 (중요)
  lastActionId = null;
  pendingReporterReveal = null;
  actionPollFailures = 0;
  lastClientPingAt = 0;
  clientSeen = false;

  await sync();
  // 방 저장/동기화에 성공했으면 서버 연결은 🟢
  setConnected(true);

  if (hostBeatTimer) clearInterval(hostBeatTimer);
  // setState 주기 호출은 GAS write 락 경쟁을 키워 배정/액션이 밀릴 수 있어 끈다.
  // (타이머는 endAt 기반이라 주기 sync 없이도 Display가 남은 시간을 계산 가능)
  hostBeatTimer = null;

  if (actionPollTimer) clearInterval(actionPollTimer);
  actionPollTimer = setInterval(pollActions, 600);

  if (privatePollTimer) clearInterval(privatePollTimer);
  // DEAL 중에는 server-side dealPick이 private/public를 갱신하므로 host도 읽어와서 화면 반영
  privatePollTimer = setInterval(pollPrivateDuringDeal, 650);

  render();
}

function applyPrivateStateToGame(priv) {
  if (!priv || typeof priv !== 'object') return;
  const keepHistory = game.history;
  const keepDeckConfig = game.deckConfig;
  const keepRoom = roomCode;

  game.phase = priv.phase ?? game.phase;
  game.night = priv.night ?? game.night;
  game.timer = priv.timer ?? game.timer;
  game.timerConfig = priv.timerConfig ?? game.timerConfig;
  game.players = Array.isArray(priv.players) ? priv.players : game.players;
  game.deck = Array.isArray(priv.deck) ? priv.deck : game.deck;
  game.deckUsed = Array.isArray(priv.deckUsed) ? priv.deckUsed : game.deckUsed;
  game.votes = priv.votes ?? game.votes;
  game.executionTarget = priv.executionTarget ?? game.executionTarget;
  game.journalistReveals = Array.isArray(priv.journalistReveals) ? priv.journalistReveals : game.journalistReveals;
  game.reporterUsedOnce = !!priv.reporterUsedOnce;
  game.eventQueue = priv.eventQueue ?? game.eventQueue;
  game.winner = priv.winner ?? game.winner;

  game.history = keepHistory;
  game.deckConfig = keepDeckConfig;
  roomCode = keepRoom;
}

async function pollPrivateDuringDeal() {
  if (!roomCode) return;
  if (game.phase !== PHASE.DEAL) return;
  try {
    const res = await getPrivateState(roomCode);
    const priv = res?.privateState;
    if (priv) {
      applyPrivateStateToGame(priv);
      setConnected(true);
      render();
    }
  } catch {
    // 무시: 호스트는 UI용 동기화라 실패해도 진행 가능
  }
}

async function pollActions() {
  if (!roomCode) return;

  // setInterval로 async 함수가 겹쳐 실행되면 lastActionId/clearActions가 꼬여
  // 일부 액션이 누락되거나 '첫 배정만 되고 이후 무반응'이 발생할 수 있음
  if (actionPollInFlight) return;
  actionPollInFlight = true;

  try {
    const res = await pullActions(roomCode);
    actionPollFailures = 0;
    // 서버 통신 성공
    setConnected(true);

    const actions = (res && res.actions) ? res.actions : [];

    // 액션이 없어도 서버 연결은 유지. (진행자 접속 감지는 HELLO/PING으로 별도 표시)
    if (!actions.length) {
      renderBadgeOnly();
      return;
    }

    // 액션 처리(여기서는 상태만 변경) → 마지막에 sync 1회
    let mutated = false;
    for (const a of actions) {
      if (lastActionId != null && a.id <= lastActionId) continue;
      lastActionId = a.id;
      const changed = await onAction(a);
      if (changed) mutated = true;
    }

    await clearActions(roomCode, lastActionId);

    if (mutated) await sync();
    render();
  } catch {
    actionPollFailures += 1;
    if (actionPollFailures >= FAIL_TO_DISCONNECT) {
      setConnected(false);
      renderBadgeOnly();
    }
  } finally {
    actionPollInFlight = false;
  }
}

function renderBadgeOnly() {
  const b = document.getElementById('connBadge');
  if (b) b.textContent = `서버 ${connected ? '🟢' : '🔴'} / 진행자 ${clientSeen ? '🟢' : '🔴'}`;
}

function render() {
  const deckCfg = getDeckConfigForGame();
  const deckSummary = computeDeckSummary(deckCfg, game.players.length);
  const canDeal = connected && clientSeen && !game.winner && deckSummary.valid;

  const aliveCount = game.players.filter(p => p.alive).length;
  const remaining = getTimerRemaining(game.timer);
  const timerText =
    game.timer?.mode === 'INFINITE' ? '∞' :
      (game.timer?.mode === 'COUNTDOWN' ? formatTimer(remaining) : '--:--');

  app.innerHTML = `
  <div class="topbar"><div class="topbar-inner">
    <div class="actions">
      <span class="badge night">${game.phase} ${game.phase === PHASE.NIGHT ? `N${game.night}` : ''}</span>
      <span class="badge">타이머 ${timerText}</span>
      <span class="badge">생존 ${aliveCount}/${game.players.length}</span>
      <span class="badge" id="connBadge">서버 ${connected ? '🟢' : '🔴'} / 진행자 ${clientSeen ? '🟢' : '🔴'}</span>
      <span class="badge">방코드 ${roomCode ? `<b>${roomCode}</b>` : '-'}</span>
      <span class="badge">v${BUILD}</span>
      ${lastSyncError ? `<span class="badge" style="background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.35)">SYNC ERR ${String(lastSyncError).slice(0,120)}</span>` : ''}
      ${game.winner ? `<span class="badge">승리: ${game.winner}</span>` : ''}
    </div>
    <div class="actions">
      <button id="undoBtn" ${game.history.length ? '' : 'disabled'}>되돌리기</button>
    </div>
  </div></div>

  <div class="app">
    <div class="grid cols2">
      <div class="card">
        <h3>방 연결 (GAS)</h3>
        <p class="muted small">WebRTC 없이 동작합니다. 사회자가 4자리 코드를 만들고, 진행자는 그 코드로 접속합니다.</p>
        <div class="grid cols2">
          <div>
            <label>방 코드</label>
            <input id="roomCode" placeholder="예: 4831" value="${roomCode}">
          </div>
          <div>
            <label>&nbsp;</label>
            <div class="actions">
              <button class="primary" id="mkRoom">방 생성</button>
              <button id="startRoomBtn">연결 시작</button>
            </div>
          </div>
        </div>
        <p class="muted small">서버(🔴/🟢)는 GAS 통신 성공 여부입니다. 진행자(🔴/🟢)는 Display가 접속 시 1회 HELLO 신호를 보냈는지 표시합니다.</p>
      </div>

      <div class="card">
        <h3>게임 세팅</h3>
        <div class="grid cols2">
          <div><label>인원(8~12)</label><input id="count" type="number" min="8" max="12" value="${game.players.length}"></div>
          <div><label>Phase</label>
            <select id="phaseSel">
              ${Object.values(PHASE).map(p => `<option value="${p}" ${game.phase === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
          </div>
        </div>
        <label>플레이어 이름</label>
        <div id="names" class="grid cols2"></div>

        <div style="margin-top:12px">
          <label>덱 구성 (직업별 0~3장, 시민은 자동)</label>
          <div class="grid cols2" id="deckConfig">
            ${DECK_ROLE_ORDER.filter(r => r !== ROLE.CITIZEN).map(r => {
              const label = ROLE_LABEL[r] || r;
              const v = deckCfg?.[r] ?? 0;
              return `<div>
                <label>${label}</label>
                <input type="number" min="0" max="3" value="${v}" data-deck-role="${r}">
              </div>`;
            }).join('')}
            <div>
              <label>시민(자동)</label>
              <input type="text" value="${Math.max(0, deckSummary.citizenCount)}" disabled>
            </div>
          </div>
          <div class="actions" style="margin-top:8px">
            <button id="deckReset">기본값</button>
            <span class="badge">총 ${deckSummary.total}/${game.players.length}</span>
            ${deckSummary.valid ? '' : '<span class="badge" style="background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.35)">덱 오류</span>'}
          </div>
          ${deckSummary.errors.length ? `<p class="muted small" style="color:rgba(239,68,68,.92)">${deckSummary.errors.join(' / ')}</p>` : '<p class="muted small">특수직업 합계가 인원을 넘지 않으면 시민이 자동으로 채워집니다.</p>'}
        </div>

        <div class="actions" style="margin-top:10px">
          <button id="applyBtn">적용</button>
          <button class="primary" id="dealStartBtn" ${canDeal ? '' : 'disabled'}>배정 시작</button>
          <button class="danger" id="forceEndBtn">강제 종료</button>
        </div>
      </div>
    </div>

    <div class="grid cols2" style="margin-top:12px">
      <div class="card">
        <h3>배정/공개 현황</h3>
        <div id="assignList"></div>
      </div>
      <div class="card">
        <h3>컨트롤</h3>
        <div id="controlPanel"></div>
      </div>
    </div>
  </div>`;

  app.querySelector('#undoBtn').onclick = () => {
    const ok = undo(game);
    if (ok) {
      if (game.phase === PHASE.NIGHT) initNightDraft();
      pendingReporterReveal = null;
      sync(); render();
    }
  };

  // room
  app.querySelector('#mkRoom').onclick = async () => {
    const code = genRoomCode();
    app.querySelector('#roomCode').value = code;
    await startRoom(code);
  };
  app.querySelector('#startRoomBtn').onclick = async () => {
    const code = app.querySelector('#roomCode').value;
    try { await startRoom(code); }
    catch (e) { alert(e.message || String(e)); }
  };

  // names
  const namesWrap = app.querySelector('#names');
  namesWrap.innerHTML = '';
  game.players.forEach(p => {
    const inp = document.createElement('input');
    inp.dataset.i = p.id;
    inp.value = p.name;
    namesWrap.appendChild(inp);
  });

  app.querySelector('#applyBtn').onclick = async () => {
    const n = Math.max(8, Math.min(12, parseInt(app.querySelector('#count').value || '8', 10)));
    const ok = await modalConfirm('세팅 적용', '인원/이름을 적용할까요? (배정은 초기화)');
    if (!ok) return;

    snapshot(game);
    const newPlayers = Array.from({ length: n }).map((_, i) => {
      const inp = app.querySelector(`input[data-i="${i}"]`);
      const name = inp ? (inp.value.trim() || `P${i + 1}`) : `P${i + 1}`;
      return { id: i, name };
    });
    game = createGame(newPlayers);

    // 인원 변경 시 덱 구성도 해당 인원 기본값으로 맞춤
    game.deckConfig = sanitizeDeckConfig(defaultDeckConfigFor(n));
    saveDeckConfigForCount(n, game.deckConfig);

    sync(); render();
  };

  app.querySelector('#phaseSel').onchange = () => {
    snapshot(game);
    game.phase = app.querySelector('#phaseSel').value;
    if (game.phase === PHASE.DAY && game.timerConfig?.daySec) startCountdown(game.timerConfig.daySec, { record: false });
    else resetTimerForPhase();
    if (game.phase === PHASE.NIGHT) initNightDraft();
    sync(); render();
  };

  app.querySelector('#dealStartBtn').onclick = async () => {
    const ok = await modalConfirm('배정 시작', '카드 배정을 시작할까요?');
    if (!ok) return;

    snapshot(game);
    game.phase = PHASE.DEAL;
    setTimerStopped();
    game.winner = null;

    game.players.forEach(p => {
      p.role = null;
      p.publicCard = 'CITIZEN';
      p.alive = true;
      p.assigned = false;
      p.armorUsed = false;
      p.terroristTarget = null;
    });

    game.reporterUsedOnce = false;
    // UI 덱 구성 기반으로 카드 생성
    try {
      game.deck = shuffle(buildDeckFromConfig(getDeckConfigForGame(), game.players.length));
    } catch (e) {
      alert(e.message || String(e));
      render();
      return;
    }
    game.deckUsed = Array.from({ length: game.players.length }).map(() => false);

    await sync();
    render();
  };

  // deck config
  const deckResetBtn = app.querySelector('#deckReset');
  if (deckResetBtn) deckResetBtn.onclick = () => {
    const n = game.players.length;
    game.deckConfig = sanitizeDeckConfig(defaultDeckConfigFor(n));
    saveDeckConfigForCount(n, game.deckConfig);
    render();
  };

  app.querySelectorAll('input[data-deck-role]').forEach(inp => {
    inp.onchange = () => {
      const role = inp.getAttribute('data-deck-role');
      const cfg = getDeckConfigForGame();
      cfg[role] = clampInt(inp.value, 0, 3);
      game.deckConfig = sanitizeDeckConfig(cfg);
      saveDeckConfigForCount(game.players.length, game.deckConfig);
      render();
    };
  });

  app.querySelector('#forceEndBtn').onclick = async () => {
    const ok = await modalConfirm('강제 종료', 'SETUP으로 초기화할까요? (되돌리기 가능)');
    if (!ok) return;

    snapshot(game);
    game.phase = PHASE.SETUP;
    setTimerStopped();
    game.winner = null;
    game.votes = {};
    game.executionTarget = null;
    game.reporterUsedOnce = false;
    pendingReporterReveal = null;

    sync(); render();
  };

  // assign list
  app.querySelector('#assignList').innerHTML = game.players.map(p => {
    const r = p.role ? ROLE_LABEL[p.role] : '미배정';
    const pub = p.publicCard && p.publicCard !== 'CITIZEN' ? ` / 공개:${ROLE_LABEL[p.publicCard] || p.publicCard}` : '';
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div>${p.name}${p.alive ? '' : ' <span class="muted">(사망)</span>'}</div>
      <div class="muted small">${r}${pub}</div>
    </div>`;
  }).join('');

  app.querySelector('#controlPanel').innerHTML = buildControlPanel();
  wireControlPanel();
}

function buildControlPanel() {
  return `<div style="display:flex;flex-direction:column;gap:12px">
    ${buildTimerPanel()}
    ${buildPhasePanel()}
  </div>`;
}

function buildTimerPanel() {
  const remaining = getTimerRemaining(game.timer);
  const timerText =
    game.timer?.mode === 'INFINITE' ? '∞' :
      (game.timer?.mode === 'COUNTDOWN' ? formatTimer(remaining) : '--:--');

  const disabled = connected ? '' : 'disabled';
  const running = game.timer?.mode === 'COUNTDOWN' && game.timer?.running;
  const paused = game.timer?.mode === 'COUNTDOWN' && !game.timer?.running;

  return `
    <div>
      <h4 style="margin:0 0 6px">타이머</h4>
      <div class="actions"><span class="badge">현재 ${timerText}</span></div>
      <div class="grid cols2" style="margin-top:8px">
        <div><label>분</label><input id="timerMin" type="number" min="0" value="3"></div>
        <div><label>초</label><input id="timerSec" type="number" min="0" max="59" value="0"></div>
      </div>
      <div class="actions" style="margin-top:8px">
        <button id="timerStart" ${disabled}>시작</button>
        <button id="timerPause" ${disabled || !running ? 'disabled' : ''}>일시정지</button>
        <button id="timerResume" ${disabled || !paused ? 'disabled' : ''}>재개</button>
        <button id="timerStop" ${disabled}>리셋</button>
      </div>
      <div class="actions" style="margin-top:6px">
        <button class="timerPreset" data-sec="300" ${disabled}>낮 5분</button>
        <button class="timerPreset" data-sec="120" ${disabled}>투표 2분</button>
      </div>
      <p class="muted small">밤은 무한대로 표시되며 스킵 가능합니다.</p>
    </div>`;
}

function buildPhasePanel() {
  if (game.winner) return `<p class="muted">게임 종료: <b>${game.winner}</b></p>`;
  if (game.phase === PHASE.DEAL) return `<p class="muted">배정 진행: ${game.players.filter(p => p.assigned).length}/${game.players.length}</p>`;

  const disabled = connected ? '' : 'disabled';

  if (game.phase === PHASE.NIGHT) {
    if (!nightDraft) initNightDraft();
    return `
      <div class="grid cols2">
        <div>
          ${sel('마피아 공격', nightDraft.mafiaId, 'mafiaTarget', false)}
          ${sel('의사 보호', nightDraft.doctorId, 'doctorTarget', true)}
          ${sel('경찰 조사', nightDraft.policeId, 'policeTarget', true)}
        </div>
        <div>
          ${reporterBlock()}
          ${sel('테러리스트 지목', nightDraft.terroristId, 'terroristTarget', true)}
        </div>
      </div>
      <div class="actions" style="margin-top:10px"><button class="primary" id="nightResolve" ${disabled}>밤 확정 → DAY</button></div>`;
  }

  if (game.phase === PHASE.DAY) {
    return `
      <p class="muted">낮 토론</p>
      <div class="actions">
        <button class="primary" id="toVote" ${disabled}>투표로 이동</button>
        <button id="skipDay" ${disabled}>토론 스킵</button>
        <button id="manualReveal" ${disabled}>기자 공개(수동)</button>
      </div>`;
  }

  if (game.phase === PHASE.VOTE) {
    const alive = game.players.filter(p => p.alive);
    const selected = game.executionTarget ?? alive[0]?.id ?? null;
    return `
      <p class="muted">최후 변론 대상 선택</p>
      <label>단두대 대상</label>
      <select id="accusedSel" ${disabled}>
        ${alive.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${p.name}</option>`).join('')}
      </select>
      <div class="actions" style="margin-top:10px">
        <button class="primary" id="startDefense" ${disabled}>최후 변론 시작</button>
      </div>`;
  }

  if (game.phase === PHASE.EXECUTION) {
    const t = game.executionTarget;
    const name = (t == null) ? '무효(처형 없음)' : (game.players.find(p => p.id == t)?.name ?? '-');
    return `
      <p class="muted">투표 진행 중: <b>${name}</b></p>
      <div class="actions">
        <button class="primary" id="execConfirm" ${disabled}>처형 확정</button>
        <button id="execCancel" ${disabled}>무효 → 밤으로</button>
      </div>`;
  }

  return `<p class="muted">SETUP</p>`;
}

function wireControlPanel() {
  if (game.winner) return;

  const timerStart = app.querySelector('#timerStart');
  if (timerStart) timerStart.onclick = async () => {
    const min = Number(app.querySelector('#timerMin')?.value || 0);
    const sec = Number(app.querySelector('#timerSec')?.value || 0);
    startCountdown(Math.max(0, min * 60 + sec));
    await sync();
    render();
  };

  const timerPause = app.querySelector('#timerPause');
  if (timerPause) timerPause.onclick = async () => {
    pauseCountdown();
    await sync();
    render();
  };

  const timerResume = app.querySelector('#timerResume');
  if (timerResume) timerResume.onclick = async () => {
    resumeCountdown();
    await sync();
    render();
  };

  const timerStop = app.querySelector('#timerStop');
  if (timerStop) timerStop.onclick = async () => {
    resetTimerManual();
    await sync();
    render();
  };

  app.querySelectorAll('.timerPreset').forEach(btn => {
    btn.onclick = async () => {
      startCountdown(Number(btn.dataset.sec || 0));
      await sync();
      render();
    };
  });

  if (game.phase === PHASE.NIGHT) {
    app.querySelectorAll('select[data-key]').forEach(s => {
      s.onchange = () => {
        snapshot(game);
        const key = s.dataset.key;
        nightDraft[key] = (s.value === '' ? null : Number(s.value));
        render();
      };
    });

    const rep = app.querySelector('#repUsed');
    if (rep) rep.onchange = () => {
      snapshot(game);
      nightDraft.reporterUsed = rep.checked;
      if (!nightDraft.reporterUsed) nightDraft.reporterTarget = null;
      render();
    };

    app.querySelector('#nightResolve').onclick = async () => {
      const ok = await modalConfirm('밤 확정', '밤 결과를 확정할까요? (연출 후 DAY)');
      if (!ok) return;

      snapshot(game);
      const res = resolveNight(game, nightDraft);

      res.dead.forEach(id => { if (game.players[id]) game.players[id].alive = false; });
      game.eventQueue = { token: Date.now(), events: res.events || [] };
      pendingReporterReveal = res.reporterRevealTarget;

      game.phase = PHASE.DAY;
      if (game.timerConfig?.daySec) startCountdown(game.timerConfig.daySec, { record: false });
      else setTimerStopped();

      game.votes = {};
      game.executionTarget = null;

      const winner = checkWin(game);
      if (winner) { game.phase = PHASE.END; game.winner = winner; setTimerStopped(); }

      await sync();
      render();
    };
    return;
  }

  if (game.phase === PHASE.DAY) {
    app.querySelector('#toVote').onclick = async () => {
      const ok = await modalConfirm('투표로 이동', '투표로 이동할까요? (되돌리기 가능)');
      if (!ok) return;
      snapshot(game);
      game.phase = PHASE.VOTE;
      game.executionTarget = null;
      setTimerInfinite();
      await sync();
      render();
    };

    app.querySelector('#skipDay').onclick = async () => {
      const ok = await modalConfirm('토론 스킵', '토론을 스킵하고 투표로 넘어갈까요?');
      if (!ok) return;
      snapshot(game);
      game.phase = PHASE.VOTE;
      game.executionTarget = null;
      setTimerInfinite();
      await sync();
      render();
    };

    app.querySelector('#manualReveal').onclick = async () => {
      const ok = await modalConfirm('기자 공개', '기자 공개(수동)를 진행할까요?');
      if (!ok) return;
      const alive = game.players.filter(p => p.alive);
      const id = alive[0]?.id;
      if (id != null) {
        snapshot(game);
        journalistReveal(game, id);
        await sync();
        render();
      }
    };
    return;
  }

  if (game.phase === PHASE.VOTE) {
    app.querySelector('#startDefense').onclick = async () => {
      const ok = await modalConfirm('최후 변론', '최후 변론을 시작할까요?');
      if (!ok) return;
      snapshot(game);
      const sel = app.querySelector('#accusedSel');
      game.executionTarget = sel ? Number(sel.value) : null;
      game.phase = PHASE.EXECUTION;
      setTimerInfinite();
      await sync();
      render();
    };
    return;
  }

  if (game.phase === PHASE.EXECUTION) {
    app.querySelector('#execConfirm').onclick = async () => {
      const ok = await modalConfirm('처형 확정', '처형을 확정할까요? (되돌리기 가능)');
      if (!ok) return;

      snapshot(game);
      let result = { executed: [], chain: [] };
      if (game.executionTarget != null) result = execute(game, game.executionTarget);

      const executedId = game.executionTarget;
      const executedPlayer = executedId != null ? game.players[executedId] : null;

      const evs = [{ type: 'EXECUTION', executedId }];
      if (executedPlayer?.role === ROLE.TERRORIST) {
        evs[0].terroristId = executedId;
        evs[0].executorName = '처형자';
      }
      if (result.chain.length) {
        evs.push({ type: 'TERROR_CHAIN', terroristId: executedId, targetId: result.chain[0] });
      }

      game.eventQueue = { token: Date.now(), events: evs };

      const winner = checkWin(game);
      if (winner) { game.phase = PHASE.END; game.winner = winner; setTimerStopped(); }
      else {
        game.night += 1;
        game.phase = PHASE.NIGHT;
        setTimerInfinite();
        game.votes = {};
        game.executionTarget = null;
        initNightDraft();
      }

      await sync();
      render();
    };

    app.querySelector('#execCancel').onclick = async () => {
      const ok = await modalConfirm('처형 취소', '처형 없이 다음 밤으로 넘어갈까요?');
      if (!ok) return;
      snapshot(game);
      game.night += 1;
      game.phase = PHASE.NIGHT;
      setTimerInfinite();
      game.votes = {};
      game.executionTarget = null;
      initNightDraft();
      await sync();
      render();
    };
    return;
  }
}

function sel(title, actorId, key, optional) {
  const actor = actorId != null ? game.players[actorId] : null;
  if (!actor || !actor.alive) return `<p class="muted small">${title}: 사용 불가</p>`;
  const opts = game.players
    .filter(p => p.alive && p.id !== actorId)
    .map(p => `<option value="${p.id}" ${nightDraft[key] === p.id ? 'selected' : ''}>${p.name}</option>`)
    .join('');
  return `
    <label>${title} <span class="muted small">(${actor.name})</span></label>
    <select data-key="${key}">
      <option value="">${optional ? '미사용 / 선택안함' : '대상 선택'}</option>
      ${opts}
    </select>`;
}

function reporterBlock() {
  const rid = nightDraft.reporterId;
  const actor = rid != null ? game.players[rid] : null;
  if (!actor || !actor.alive) return `<p class="muted small">기자: 사용 불가</p>`;
  const disabled = game.night < 2 || game.reporterUsedOnce;
  const checked = nightDraft.reporterUsed && !disabled;
  const opts = game.players
    .filter(p => p.alive && p.id !== rid)
    .map(p => `<option value="${p.id}" ${nightDraft.reporterTarget === p.id ? 'selected' : ''}>${p.name}</option>`)
    .join('');
  return `
    <label>기자 특보 <span class="muted small">(${actor.name})</span></label>
    <div class="actions" style="margin:6px 0">
      <input id="repUsed" type="checkbox" style="width:auto" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="muted small">${game.reporterUsedOnce ? '이미 사용함' : (disabled ? '첫밤 불가' : '사용')}</span>
    </div>
    <select data-key="reporterTarget" ${checked ? '' : 'disabled'}>
      <option value="">대상 선택</option>
      ${opts}
    </select>`;
}

async function onAction(action) {
  const msg = action?.msg || action;

  if (msg.type === 'PING') {
    markClientSeen();
    setConnected(true);
    renderBadgeOnly();
    return false;
  }

  if (msg.type === 'HELLO') {
    markClientSeen();
    renderBadgeOnly();
    return false;
  }

  if (msg.type === 'REQ_SYNC') {
    if (pendingReporterReveal != null) {
      snapshot(game);
      journalistReveal(game, pendingReporterReveal);
      pendingReporterReveal = null;
      return true;
    }
    return false;
  }

  if (msg.type === 'DEAL_PICK') {
    if (game.phase !== PHASE.DEAL || !game.deck || !game.deckUsed) return;

    const { cardIndex, playerId } = msg;
    if (game.deckUsed[cardIndex]) return;

    const p = game.players[playerId];
    if (!p || p.assigned) return;

    snapshot(game);

    const role = game.deck[cardIndex];
    game.deckUsed[cardIndex] = true;
    p.role = role;
    p.assigned = true;

    game.eventQueue = { token: Date.now(), events: [{ type: 'DEAL_REVEAL', playerId, role, cardIndex }] };

    if (game.players.every(x => x.assigned)) {
      snapshot(game);
      game.phase = PHASE.NIGHT;
      setTimerInfinite();
      initNightDraft();
    }
    return true;
  }

  return false;
}

render();