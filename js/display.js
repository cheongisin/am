// js/display.js
import { el } from './util.js';
import { getState, patchState, pushAction } from './gasApi.js';
import { PHASE, CARD, DEAD_CARD, EVENT_IMG } from '../src/constants.js';

/* =========================
   Root
========================= */
const root =
  document.getElementById('display') ||
  document.getElementById('app') ||
  document.body;

/* =========================
   Wake lock (optional)
========================= */
let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('click', keepAwake, { once: true });

/* =========================
   Global state
========================= */
let roomCode = '';
let state = null;

let mounted = false;
let currentMode = 'CONNECT'; // CONNECT | DEAL | TABLE

// single-flight poll loop
let polling = false;
let pollLoopRunning = false;
let pollAbort = false;

// freeze polling briefly during critical UI actions (DEAL pick)
let freezeUntil = 0;

// connection hysteresis
let connected = false;
let lastHostSeenAt = 0; // for debounce
let lastClientBeatAt = 0;

// event playback
let lastEventToken = 0;
let eventPlayback = Promise.resolve();

// local deal cache
let dealDeckCount = 0;
let dealUsed = [];
let dealPlayerIds = [];
let pendingPick = null; // {cardIndex, playerId, at}

/* =========================
   DOM refs (filled on mount)
========================= */
const dom = {
  connectWrap: null,
  connectInput: null,
  connectBtn: null,

  dealWrap: null,
  dealCards: null,

  tableWrap: null,
  table: null,
  connBadge: null,
  phaseTitle: null,
  timerBadge: null,
  phaseSub: null,
  timerBarFill: null,

  // seats
  seatEls: [], // by index in players array, not id
};

function now() { return Date.now(); }
function freezePoll(ms = 900) { freezeUntil = Math.max(freezeUntil, now() + ms); }

/* =========================
   Utils
========================= */
function isValidRoom(code) {
  return /^\d{4}$/.test(String(code || '').trim());
}

function computeConnected(st) {
  const t = now();
  if (st?.hostHeartbeat) lastHostSeenAt = t;
  // 6초 유예: hostHeartbeat가 잠깐 늦어도 🔴로 안 바뀜
  return (t - lastHostSeenAt) < 6000;
}

function formatTimer(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function getTimerRemaining(timer) {
  if (!timer || timer.mode !== 'COUNTDOWN') return null;
  if (timer.running && timer.endAt) {
    return Math.max(0, Math.ceil((timer.endAt - now()) / 1000));
  }
  return Math.max(0, Math.floor(timer.durationSec || 0));
}

/* =========================
   Mount (1 time)
========================= */
function mountOnce() {
  if (mounted) return;
  mounted = true;

  root.innerHTML = `
    <div class="display-root">
      <!-- CONNECT -->
      <div id="connectWrap" class="connect-wrap">
        <div class="card">
          <h3>진행자 연결</h3>
          <p class="muted small">사회자가 만든 4자리 방코드를 입력하세요.</p>
          <label>방 코드</label>
          <input id="connectCode" placeholder="예: 6720" inputmode="numeric" maxlength="4" />
          <div class="actions" style="margin-top:10px">
            <button class="primary" id="connectBtn">접속</button>
          </div>
          <div class="muted small" id="connectHint">상태: 연결 🔴</div>
        </div>
      </div>

      <!-- DEAL -->
      <div id="dealWrap" class="dealwrap hidden">
        <div class="card">
          <h3>카드 뽑기</h3>
          <p class="muted small">본인 카드를 선택한 뒤 본인을 지정하세요.</p>
          <div id="dealCards" class="deck"></div>
          <div class="muted small" id="dealHint"></div>
        </div>
      </div>

      <!-- TABLE -->
      <div id="tableWrap" class="board hidden">
        <div class="hud">
          <span class="badge" id="connBadge">연결 🔴</span>
          <span class="badge" id="phaseTitle">-</span>
          <span class="badge" id="timerBadge">--:--</span>
        </div>

        <div class="stage">
          <div class="hostPanel">
            <div class="seat host">
              <div class="imgwrap">
                <img src="assets/pront.svg" alt="사회자">
              </div>
              <div class="name">사회자</div>
            </div>
          </div>

          <div class="table" id="table">
            <div class="phase-center">
              <div class="phase-title" id="phaseCenterTitle"></div>
              <div class="phase-time" id="phaseCenterTimer"></div>
              <div class="phase-sub" id="phaseSub"></div>
              <div class="timer-bar">
                <div class="timer-bar-fill" id="timerBarFill"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  dom.connectWrap = root.querySelector('#connectWrap');
  dom.connectInput = root.querySelector('#connectCode');
  dom.connectBtn = root.querySelector('#connectBtn');

  dom.dealWrap = root.querySelector('#dealWrap');
  dom.dealCards = root.querySelector('#dealCards');

  dom.tableWrap = root.querySelector('#tableWrap');
  dom.table = root.querySelector('#table');
  dom.connBadge = root.querySelector('#connBadge');
  dom.phaseTitle = root.querySelector('#phaseTitle');
  dom.timerBadge = root.querySelector('#timerBadge');
  dom.phaseSub = root.querySelector('#phaseSub');
  dom.timerBarFill = root.querySelector('#timerBarFill');

  dom.connectBtn.onclick = async () => {
    const code = String(dom.connectInput.value || '').trim();
    if (!isValidRoom(code)) {
      alert('방 코드는 4자리 숫자입니다.');
      return;
    }
    await connectToRoom(code);
  };

  dom.connectInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.connectBtn.click();
  });
}

/* =========================
   Mode switch (no full rerender spam)
========================= */
function setMode(mode) {
  if (currentMode === mode) return;
  currentMode = mode;

  dom.connectWrap.classList.toggle('hidden', mode !== 'CONNECT');
  dom.dealWrap.classList.toggle('hidden', mode !== 'DEAL');
  dom.tableWrap.classList.toggle('hidden', mode !== 'TABLE');
}

/* =========================
   Connect / heartbeat
========================= */
async function connectToRoom(code) {
  mountOnce();
  roomCode = code;

  // 첫 조회로 방 존재 확인
  try {
    const st = await getState(roomCode);
    if (!st || !st.phase) {
      alert('해당 방을 찾을 수 없습니다. 방 코드가 맞는지 확인하세요.');
      return;
    }

    // client heartbeat 먼저 찍기
    lastClientBeatAt = now();
    await patchState(roomCode, { clientHeartbeat: lastClientBeatAt });

    // 상태 반영
    applyState(st, { forceMode: true });

    // 폴링 시작
    startPollLoop();

  } catch (e) {
    alert('연결 실패: GAS 응답이 없습니다.');
  }
}

async function beatClient() {
  if (!roomCode) return;
  const t = now();
  // 너무 자주 안 찍어도 됨
  if (t - lastClientBeatAt < 1500) return;
  lastClientBeatAt = t;
  try { await patchState(roomCode, { clientHeartbeat: t }); } catch {}
}

/* =========================
   Poll loop (single-flight + setTimeout)
========================= */
function startPollLoop() {
  if (pollLoopRunning) return;
  pollLoopRunning = true;
  pollAbort = false;

  const loop = async () => {
    if (pollAbort) { pollLoopRunning = false; return; }

    // freeze window: DEAL 클릭 직후 같은 “민감구간” 보호
    if (now() < freezeUntil) {
      setTimeout(loop, 150);
      return;
    }

    // single-flight
    if (polling) {
      setTimeout(loop, 150);
      return;
    }

    polling = true;
    try {
      await beatClient();
      await pollOnce();
    } finally {
      polling = false;
      setTimeout(loop, 450);
    }
  };

  loop();
}

async function pollOnce() {
  if (!roomCode) return;

  let st = null;
  try {
    st = await getState(roomCode);
  } catch {
    // 네트워크 순간 실패는 UI를 갈아엎지 않음
    updateConnBadge(false, { soft: true });
    return;
  }
  if (!st) return;

  applyState(st, { forceMode: false });
}

/* =========================
   Apply state (core)
========================= */
function applyState(st, { forceMode }) {
  state = st;

  // connection debounce
  connected = computeConnected(st);
  updateConnBadge(connected);

  // decide mode
  const dealActive = (state.phase === PHASE.DEAL);
  if (forceMode) {
    setMode(dealActive ? 'DEAL' : 'TABLE');
  } else {
    // 모드가 바뀔 때만 화면 구조 토글
    const wantMode = dealActive ? 'DEAL' : 'TABLE';
    if (currentMode === 'CONNECT') setMode(wantMode);
    else if (currentMode !== wantMode) setMode(wantMode);
  }

  // update content per mode
  if (currentMode === 'DEAL') {
    updateDealFromState();
    renderDealCardsIfNeeded();
    // DEAL은 “부분 업데이트”만
  } else if (currentMode === 'TABLE') {
    ensureSeatsBuilt();
    updateTopHud();
    updatePhaseCenter();
    updateSeatsFast();
    handleEventQueue();
  }

  // connect 화면 힌트
  if (currentMode === 'CONNECT') {
    const hint = root.querySelector('#connectHint');
    if (hint) hint.textContent = `상태: 연결 ${connected ? '🟢' : '🔴'}`;
  }
}

/* =========================
   Connection badge update
========================= */
function updateConnBadge(ok, { soft = false } = {}) {
  if (!dom.connBadge) return;
  // soft 실패는 UI를 붉게 바꾸지 않고 유지(깜빡임 방지)
  if (soft) return;

  dom.connBadge.textContent = `연결 ${ok ? '🟢' : '🔴'}`;
  const hint = root.querySelector('#connectHint');
  if (hint) hint.textContent = `상태: 연결 ${ok ? '🟢' : '🔴'}`;
}

/* =========================
   DEAL
========================= */
function updateDealFromState() {
  // host.js에서 state.deckInfo를 넣어두는 구조가 아니면,
  // 여기서는 “deck / deckUsed”를 직접 사용하도록 양쪽 다 지원.
  const info = state.deckInfo || null;

  if (info) {
    dealDeckCount = Number(info.count || 0);
    dealUsed = Array.isArray(info.used) ? info.used.slice() : [];
  } else {
    // fallback: deck/deckUsed
    dealDeckCount = Array.isArray(state.deck) ? state.deck.length : 0;
    dealUsed = Array.isArray(state.deckUsed) ? state.deckUsed.slice() : [];
  }

  // 배정 가능한 플레이어 목록
  dealPlayerIds = (state.players || [])
    .filter(p => !p.assigned)
    .map(p => p.id);

  const hint = root.querySelector('#dealHint');
  if (hint) {
    const assigned = (state.players || []).filter(p => p.assigned).length;
    hint.textContent = `배정 ${assigned}/${(state.players || []).length} · 연결 ${connected ? '🟢' : '🔴'}`;
  }
}

function renderDealCardsIfNeeded() {
  if (!dom.dealCards) return;

  // 카드 수 바뀌거나, used 배열 길이가 바뀌면 다시 그림
  const needRebuild =
    dom.dealCards.childElementCount !== dealDeckCount;

  if (needRebuild) {
    dom.dealCards.innerHTML = '';
    for (let i = 0; i < dealDeckCount; i++) {
      const btn = el(`<div class="cardbtn" data-i="${i}"><img src="${CARD.BACK}"></div>`);
      dom.dealCards.appendChild(btn);
    }
  }

  // 상태 반영 (used)
  Array.from(dom.dealCards.children).forEach((node, i) => {
    const used = !!dealUsed[i];
    node.classList.toggle('used', used);
    node.onclick = null;
    if (!used) {
      node.onclick = () => {
        // poll이 클릭 직후 덮어써서 “스킵”되는 걸 막기 위한 핵심 보호
        freezePoll(1100);
        openPickModal(i);
      };
    }
  });
}

function openPickModal(cardIndex) {
  // 이미 선택 진행 중이면 막음
  if (pendingPick) return;

  const selectable = (state.players || []).filter(p => !p.assigned);
  if (!selectable.length) return;

  const options = selectable.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  const bd = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <h3>본인 선택</h3>
        <p class="muted small">카드를 뽑은 플레이어를 선택하세요.</p>
        <select id="pSel">${options}</select>
        <div class="actions">
          <button id="cancel">취소</button>
          <button class="primary" id="ok">확인</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(bd);

  const close = () => {
    try { bd.remove(); } catch {}
  };

  bd.querySelector('#cancel').onclick = () => {
    pendingPick = null;
    close();
  };

  bd.querySelector('#ok').onclick = async () => {
    const pid = Number(bd.querySelector('#pSel').value);

    // optimistic lock (UI 스킵 방지)
    pendingPick = { cardIndex, playerId: pid, at: now() };
    dealUsed[cardIndex] = true;
    renderDealCardsIfNeeded();

    close();

    // 클릭 직후 poll 덮어쓰기 방지(중요)
    freezePoll(1200);

    // host로 액션 전달
    try {
      await pushAction(roomCode, { type: 'DEAL_PICK', cardIndex, playerId: pid });
    } catch {
      // 실패 시 되돌림
      dealUsed[cardIndex] = false;
      pendingPick = null;
      renderDealCardsIfNeeded();
      alert('전송 실패. 다시 시도하세요.');
      return;
    }

    // 잠깐 후 pending 해제 (host가 반영할 시간)
    setTimeout(() => {
      pendingPick = null;
    }, 1000);
  };
}

/* =========================
   TABLE
========================= */
function ensureSeatsBuilt() {
  if (!dom.table) return;
  const players = state.players || [];

  if (dom.seatEls.length !== players.length) {
    dom.seatEls = [];
    // 기존 좌석 제거 (중앙 phase-center는 유지)
    Array.from(dom.table.querySelectorAll('.seat:not(.host)')).forEach(n => n.remove());

    players.forEach((p) => {
      const seat = el(`
        <div class="seat">
          <div class="imgwrap"><img></div>
          <div class="name"></div>
        </div>
      `);
      dom.table.appendChild(seat);
      dom.seatEls.push(seat);
    });
  }
}

function updateTopHud() {
  if (!dom.phaseTitle || !dom.timerBadge) return;

  dom.phaseTitle.textContent = state.phase || '-';

  const timer = state.timer;
  if (timer?.mode === 'INFINITE') dom.timerBadge.textContent = '∞';
  else if (timer?.mode === 'COUNTDOWN') dom.timerBadge.textContent = formatTimer(getTimerRemaining(timer));
  else dom.timerBadge.textContent = '--:--';
}

function updatePhaseCenter() {
  const title = root.querySelector('#phaseCenterTitle');
  const tmr = root.querySelector('#phaseCenterTimer');
  if (!title || !tmr) return;

  // phase title
  if (state.phase === PHASE.NIGHT) title.textContent = `밤 N${state.night || 1}`;
  else if (state.phase === PHASE.DAY) title.textContent = '낮';
  else if (state.phase === PHASE.VOTE) title.textContent = '투표';
  else if (state.phase === PHASE.EXECUTION) title.textContent = '처형';
  else title.textContent = state.phase || '-';

  // timer
  const timer = state.timer;
  if (timer?.mode === 'INFINITE') tmr.textContent = '∞';
  else if (timer?.mode === 'COUNTDOWN') tmr.textContent = formatTimer(getTimerRemaining(timer));
  else tmr.textContent = '--:--';

  // bar fill (optional)
  if (dom.timerBarFill && timer?.mode === 'COUNTDOWN') {
    const remain = getTimerRemaining(timer);
    const dur = Math.max(1, Number(timer.durationSec || 1));
    const ratio = Math.max(0, Math.min(1, remain / dur));
    dom.timerBarFill.style.width = `${Math.round(ratio * 100)}%`;
  } else if (dom.timerBarFill) {
    dom.timerBarFill.style.width = '0%';
  }
}

function updateSeatsFast() {
  const players = state.players || [];
  const total = players.length;
  if (!total) return;

  // 8~12명: 상단 ceil(n/2), 하단 나머지
  const topCount = Math.ceil(total / 2);
  const bottomCount = total - topCount;

  players.forEach((p, i) => {
    const seat = dom.seatEls[i];
    if (!seat) return;

    const isTop = i < topCount;
    const idx = isTop ? i : i - topCount;
    const rowCount = isTop ? topCount : bottomCount;

    // x: 8%~92% 사용
    const x = 8 + (84 / ((rowCount - 1) || 1)) * idx;
    const y = isTop ? 24 : 76;

    seat.style.left = `${x}%`;
    seat.style.top = `${y}%`;

    seat.classList.toggle('dead', !p.alive);

    const nameEl = seat.querySelector('.name');
    if (nameEl) nameEl.textContent = p.name || '';

    // 카드 이미지: 공개카드 우선(죽으면 dead card)
    const cardKey = (state.winner ? (p.role || p.publicCard) : p.publicCard) || 'CITIZEN';
    const imgSrc = !p.alive
      ? (DEAD_CARD[cardKey] || CARD[cardKey] || CARD.CITIZEN)
      : (CARD[cardKey] || CARD.CITIZEN);

    const imgEl = seat.querySelector('img');
    if (imgEl && imgEl.getAttribute('src') !== imgSrc) imgEl.src = imgSrc;
  });
}

/* =========================
   Event queue playback (token-based)
========================= */
function handleEventQueue() {
  const q = state?.eventQueue;
  if (!q || !q.token || q.token === lastEventToken) return;

  lastEventToken = q.token;
  const events = Array.isArray(q.events) ? q.events : [];

  // 순차 재생 보장
  eventPlayback = eventPlayback.then(async () => {
    for (const ev of events) {
      // DEAL_REVEAL 같은 것은 테이블에서 굳이 오버레이로 안 띄우고 싶으면 스킵
      if (ev?.type === 'DEAL_REVEAL') continue;
      await showEventOverlay(ev);
    }
  });
}

async function showEventOverlay(ev) {
  const src = EVENT_IMG?.[ev.type] || EVENT_IMG?.DEFAULT || EVENT_IMG?.MAFIA_KILL;
  if (!src) return;

  const overlay = el(`
    <div class="event-overlay">
      <img class="event-img" src="${src}">
    </div>
  `);
  document.body.appendChild(overlay);

  // 기본 8초
  await new Promise(r => setTimeout(r, 8000));
  try { overlay.remove(); } catch {}
}

/* =========================
   Boot
========================= */
mountOnce();
setMode('CONNECT');

// 방코드가 URL에 있으면 자동
// 예: display.html?room=6720
try {
  const u = new URL(location.href);
  const rc = u.searchParams.get('room');
  if (isValidRoom(rc)) {
    dom.connectInput.value = rc;
  }
} catch {}
