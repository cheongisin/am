import { genRoomCode, getState, pushAction, pullActions, dealPick } from './gasApi.js';
import { PHASE, CARD, ROLE_LABEL } from '../src/constants.js';

const BUILD = '2026-02-02.1';

let root = null;

/* =========================
   상태 변수
========================= */
let connected = false;
let roomCode = '';
let pollTimer = null;
let pingTimer = null;
let failures = 0;
let lastRenderKey = null;
let lastEventToken = null;
let revealTimer = null;
let lastKnownState = null;
let lastNetError = null;
let lastPollAt = 0;
let lastPollMs = 0;

const POLL_MS = 1200;
const PING_MS = 6000;
const FAIL_TO_DISCONNECT = 6;

// DEAL 클릭-폴링 레이스 방지(최소 로컬 상태)
const pendingDealPick = new Set();
let dealPickInFlight = null; // {cardIndex, playerId, startedAt}
let dealPickStatus = null;   // {message, kind:'info'|'warn'|'error'}

function isUnknownOpMessage(msg){
  return /unknown\s+op/i.test(String(msg || ''));
}

/* =========================
   유틸
========================= */
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setConnected(v) {
  connected = !!v;
}

function getDeckUsed(state) {
  // 공개 상태 기준: deckInfo.used
  const used = state?.deckInfo?.used;
  return Array.isArray(used) ? used : [];
}

function computeRenderKey(st) {
  // eventQueue.token에만 묶지 말고, phase/timer/players/deck을 포함
  const phase = st?.phase ?? '';
  const hb = st?.hostHeartbeat ?? '';
  const ev = st?.eventQueue?.token ?? '';
  const mode = st?.timer?.mode ?? '';
  const endAt = st?.timer?.endAt ?? '';
  const alive = (st?.players || []).map(p => (p?.alive === false ? '0' : '1')).join('');
  const pub = (st?.players || []).map(p => (p?.publicCard || '')).join('|');
  const used = getDeckUsed(st).map(v => (v ? '1' : '0')).join('');
  return `${phase}|${hb}|${ev}|${mode}|${endAt}|${alive}|${pub}|${used}`;
}

/* =========================
   치명 에러 표시
========================= */
function showFatal(err) {
  const msg = err?.stack || err?.message || String(err);
  if (!root) {
    alert(msg);
    return;
  }
  root.innerHTML = `
    <div style="padding:16px">
      <h2>display.js 오류</h2>
      <pre style="white-space:pre-wrap">${escapeHtml(msg)}</pre>
      <button onclick="location.reload()">새로고침</button>
    </div>
  `;
}

window.addEventListener('error', e => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', e => showFatal(e.reason));

/* =========================
  좌석 배치 (카드 그리드)
  - 좌측: 사회자 패널(아이콘 + '사회자')
  - 우측: 플레이어 카드 그리드(좌→우, 위→아래 순서)
  - 8명: 4열(1~4 / 5~8)
  - 9~12명: 6열(1~6 / 7~12)
========================= */

function renderSeat(p, fallbackIndex) {
  const dead = p?.alive === false;
  const name = escapeHtml(p?.name || `P${(fallbackIndex ?? 0) + 1}`);
  const pub = String(p?.publicCard || 'CITIZEN');
  const img = CARD[pub] || CARD.CITIZEN;
  return `
    <div class="seat ${dead ? 'dead' : ''}">
      <div class="imgwrap">
        <img src="${img}" alt="">
      </div>
      <div class="name">${name}</div>
    </div>
  `;
}

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

function phaseLabel(st) {
  if (st?.winner === 'MAFIA') return 'MAFIA WIN';
  if (st?.winner === 'CITIZEN') return 'CITIZEN WIN';
  const p = st?.phase || PHASE.SETUP;
  if (p === PHASE.SETUP) return 'GAME SET';
  return String(p);
}

/* =========================
   연결 전 화면
========================= */
function renderDisconnected() {
  root.innerHTML = `
    <div class="display-wrap">
      <div class="panel">
        <h3>진행자 연결</h3>
        <div class="row">
          <input id="roomInput" placeholder="4자리 코드" inputmode="numeric" />
          <button id="joinBtn" class="primary">접속</button>
        </div>
        <div class="muted">상태: ${connected ? '🟢' : '🔴'} / v${BUILD}</div>
        <div class="muted small" id="joinStatus"></div>
      </div>
    </div>
  `;

  document.getElementById('joinBtn').onclick = () => {
    const code = document.getElementById('roomInput').value.trim();
    const st = document.getElementById('joinStatus');
    if (st) st.textContent = '접속 중…';
    joinRoom(code).catch((e) => {
      if (st) st.textContent = `접속 실패: ${e?.message || e}`;
    });
  };
}

/* =========================
   DEAL UI
========================= */
function renderDealPanelInner(state) {
  const used = getDeckUsed(state);
  const remain = used.filter(v => !v).length;
  const statusHtml = dealPickStatus?.message
    ? `<div class="muted small" style="margin-top:8px; color:${dealPickStatus.kind === 'error' ? 'rgba(239,68,68,.92)' : (dealPickStatus.kind === 'warn' ? 'rgba(251,191,36,.95)' : 'var(--muted)')}">
         ${escapeHtml(dealPickStatus.message)}
       </div>`
    : '';
  const inflightHtml = dealPickInFlight
    ? `<div class="muted small" style="margin-top:6px">처리 중… (카드 #${dealPickInFlight.cardIndex + 1})</div>`
    : '';

  return `
    <div class="dealDeckModal" role="dialog" aria-modal="true">
      <div class="dealHeader">
        <h3 style="margin:0">직업 배정</h3>
        <div class="muted small">남은 카드 ${remain}</div>
      </div>
      ${inflightHtml}
      ${statusHtml}
      <div class="deck">
        ${used.map((u, i) => {
          const pending = pendingDealPick.has(i);
          const disabled = u || pending;
          return `
            <button class="cardbtn ${u ? 'used' : ''}" data-idx="${i}" ${disabled ? 'disabled' : ''}>
              <img src="assets/cards/back.png" alt="">
            </button>
          `;
        }).join('')}
      </div>
      <div class="actions" style="margin-top:12px; justify-content:flex-end">
        ${dealPickInFlight ? '<button id="dealCancelWait">대기 취소</button>' : ''}
        <button id="dealClose">닫기</button>
      </div>
    </div>
  `;
}

function renderDealBoardOverlay(state) {
  return `
    <div class="dealBoardBackdrop" id="dealBoardBackdrop">
      ${renderDealPanelInner(state)}
    </div>
  `;
}

function refreshDealBoardUi() {
  const bd = document.getElementById('dealBoardBackdrop');
  if (!bd) return;
  const phase = lastKnownState?.phase || PHASE.SETUP;
  if (phase !== PHASE.DEAL) return;
  bd.innerHTML = renderDealPanelInner(lastKnownState);
  wireDeal(lastKnownState);
}

function ensureOverlayRoot() {
  let el = document.getElementById('overlayRoot');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'overlayRoot';
  document.body.appendChild(el);
  return el;
}

function closeOverlayById(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function openAssignModal({ state, cardIndex }) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const unassigned = players.filter(p => p?.assigned === false);
  if (!unassigned.length) return;

  if (dealPickInFlight) {
    alert('처리 중입니다. 잠시만 기다려주세요.');
    return;
  }

  const overlayRoot = ensureOverlayRoot();
  closeOverlayById('assignModal');

  const modal = document.createElement('div');
  modal.id = 'assignModal';
  modal.className = 'dealBackdrop';
  modal.innerHTML = `
    <div class="dealModal" role="dialog" aria-modal="true">
      <div class="dealHeader">
        <h3 style="margin:0">대상 선택</h3>
        <div class="muted small">카드 #${cardIndex + 1}</div>
      </div>
      <label class="muted small">플레이어</label>
      <select id="assignSel">
        ${unassigned.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}
      </select>
      <div class="actions" style="margin-top:12px; justify-content:flex-end">
        <button id="assignCancel">취소</button>
        <button class="primary" id="assignOk">확정</button>
      </div>
    </div>
  `;
  overlayRoot.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  modal.querySelector('#assignCancel').onclick = () => modal.remove();
  modal.querySelector('#assignOk').onclick = async () => {
    const sel = modal.querySelector('#assignSel');
    const playerId = sel ? Number(sel.value) : null;
    if (!Number.isFinite(playerId)) return;
    modal.querySelector('#assignOk').disabled = true;

    pendingDealPick.add(cardIndex);
    dealPickInFlight = { cardIndex, playerId, startedAt: Date.now() };
    dealPickStatus = { kind: 'info', message: '배정 요청을 전송했어요. 호스트 처리 대기 중…' };
    refreshDealBoardUi();
    try {
      // 신형 GAS: 배정을 서버에서 원자 처리(가장 빠름)
      const res = await dealPick(roomCode, { cardIndex, playerId });
      modal.remove();

      // 즉시 UI 반영(폴링 기다리지 않음)
      const st = res?.state;
      if (st && typeof st === 'object') {
        lastRenderKey = null;
        renderTable(st);
      } else {
        setTimeout(() => { poll().catch(()=>{}); }, 250);
      }

      const reveal = res?.reveal;
      if (reveal && reveal.role != null) {
        const players = Array.isArray(st?.players) ? st.players : [];
        const p = players.find(x => x?.id === playerId);
        showDealReveal({ playerName: p?.name || `P${playerId + 1}`, role: reveal.role });
      }
    } catch (e) {
      // 구버전 GAS면 기존 방식 폴백
      if (isUnknownOpMessage(e?.message)) {
        try {
          await pushAction(roomCode, { type: 'DEAL_PICK', cardIndex, playerId });
          modal.remove();
          setTimeout(() => { poll().catch(()=>{}); }, 250);
          setTimeout(() => { poll().catch(()=>{}); }, 900);
          return;
        } catch (e2) {
          e = e2;
        }
      }
      pendingDealPick.delete(cardIndex);
      dealPickInFlight = null;
      dealPickStatus = { kind: 'error', message: `전송 실패: ${e?.message || 'unknown'}` };
      refreshDealBoardUi();
      modal.querySelector('#assignOk').disabled = false;
      alert(e?.message || '전송 실패');
    }
  };
}

function wireDeal(state) {
  const used = getDeckUsed(state);
  const closeBtn = document.getElementById('dealClose');
  if (closeBtn) closeBtn.onclick = () => {
    const bd = document.getElementById('dealBoardBackdrop');
    if (bd) bd.remove();
  };

  const cancelBtn = document.getElementById('dealCancelWait');
  if (cancelBtn) cancelBtn.onclick = () => {
    if (!dealPickInFlight) return;
    pendingDealPick.delete(dealPickInFlight.cardIndex);
    dealPickInFlight = null;
    dealPickStatus = { kind: 'warn', message: '대기를 취소했어요. 다른 카드로 다시 시도할 수 있어요.' };
    refreshDealBoardUi();
  };

  document.querySelectorAll('.cardbtn').forEach(btn => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.idx);
      if (!Number.isFinite(idx)) return;
      if (used[idx]) return;
      if (dealPickInFlight) return;
      if (pendingDealPick.has(idx)) return;
      openAssignModal({ state, cardIndex: idx });
    };
  });
}

function showDealReveal({ playerName, role }) {
  const overlayRoot = ensureOverlayRoot();
  closeOverlayById('dealReveal');
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }

  const roleKey = String(role || 'CITIZEN');
  const img = CARD[roleKey] || CARD.CITIZEN;
  const label = ROLE_LABEL?.[roleKey] || roleKey;

  const el = document.createElement('div');
  el.id = 'dealReveal';
  el.className = 'dealBackdrop';
  el.innerHTML = `
    <div class="revealModal" role="dialog" aria-modal="true">
      <div class="revealTitle">${escapeHtml(playerName)}님은</div>
      <img class="revealImg" src="${img}" alt="">
      <div class="revealSub">${escapeHtml(label)}이(가) 되었습니다.</div>
      <div class="muted small">3초 후 자동 닫힘</div>
    </div>
  `;
  overlayRoot.appendChild(el);

  revealTimer = setTimeout(() => {
    closeOverlayById('dealReveal');
    revealTimer = null;
  }, 3000);
}

function handleEvents(state) {
  const token = state?.eventQueue?.token ?? null;
  if (token == null || token === lastEventToken) return;
  lastEventToken = token;

  const events = Array.isArray(state?.eventQueue?.events) ? state.eventQueue.events : [];
  const deal = events.find(e => e?.type === 'DEAL_REVEAL');
  if (deal) {
    const players = Array.isArray(state?.players) ? state.players : [];
    const p = players.find(x => x?.id === deal.playerId);
    const name = p?.name || `P${Number(deal.playerId) + 1}`;
    showDealReveal({ playerName: name, role: deal.role });

    // ACK: 실제 배정이 반영되었다고 보고 pending 해제
    if (Number.isFinite(deal.cardIndex)) pendingDealPick.delete(Number(deal.cardIndex));
    dealPickInFlight = null;
    dealPickStatus = null;
  }
}

async function diagnoseDealPickTimeout({ cardIndex, playerId }) {
  try {
    const res = await pullActions(roomCode);
    const actions = Array.isArray(res?.actions) ? res.actions : [];
    const queued = actions.some(a => {
      const m = a?.msg || a;
      return m?.type === 'DEAL_PICK' && Number(m?.cardIndex) === Number(cardIndex) && Number(m?.playerId) === Number(playerId);
    });

    if (queued) {
      dealPickStatus = { kind: 'warn', message: '호스트가 아직 액션을 처리하지 못했어요. (호스트 화면이 백그라운드/절전이면 지연될 수 있어요)' };
      refreshDealBoardUi();
      return;
    }

    const st = await getState(roomCode);
    const used = getDeckUsed(st);
    const players = Array.isArray(st?.players) ? st.players : [];
    const p = players.find(x => Number(x?.id) === Number(playerId));
    if (used[cardIndex] || p?.assigned) {
      // 처리됐는데 UI가 타이밍상 못 본 케이스
      dealPickStatus = null;
      pendingDealPick.delete(cardIndex);
      dealPickInFlight = null;
      return;
    }

    dealPickStatus = { kind: 'error', message: '호스트가 배정을 반영하지 못했어요. 호스트 탭이 살아있는지 확인해 주세요.' };
    refreshDealBoardUi();
  } catch {
    dealPickStatus = { kind: 'error', message: '상태 확인 중 오류가 발생했어요. 네트워크/GAS 상태를 확인해 주세요.' };
    refreshDealBoardUi();
  }
}

/* =========================
   메인 렌더 (layout.css 구조에 맞춤)
========================= */
function renderTable(state) {
  lastKnownState = state;
  const players = Array.isArray(state?.players) ? state.players : [];
  const phase = state?.phase || PHASE.SETUP;
  const timer = state?.timer || {};

  const aliveCount = players.filter(p => p?.alive !== false).length;

  const remaining = getTimerRemaining(timer);
  const timerText = (
    timer.mode === 'INFINITE' ? '∞' :
      (timer.mode === 'COUNTDOWN' ? formatTimer(remaining) : '--:--')
  );

  const totalSec = Number(timer?.durationSec || 0);
  const pct = (timer?.mode === 'COUNTDOWN' && totalSec > 0 && remaining != null)
    ? Math.max(0, Math.min(100, (remaining / totalSec) * 100))
    : 100;

  const cols = (players.length <= 8) ? 4 : 6;
  const seatHtml = players.map((p, i) => renderSeat(p, i)).join('');

  const usedNow = getDeckUsed(state);
  const usedCount = usedNow.filter(Boolean).length;
  const remainCount = Math.max(0, usedNow.length - usedCount);
  const dbg = `v${BUILD} · poll ${lastPollMs}ms · ${new Date(lastPollAt || Date.now()).toLocaleTimeString()} · deck ${remainCount}/${usedNow.length}`;
  const errText = lastNetError ? String(lastNetError).slice(0, 140) : '';

  root.innerHTML = `
    <div class="board ${phase === PHASE.DEAL ? 'dealActive' : ''}">
      <div class="hud">
        <div>
          <span class="badge">${escapeHtml(phase)}</span>
          <span class="badge">타이머 ${escapeHtml(timerText)}</span>
          <span class="badge">생존 ${aliveCount}/${players.length}</span>
          <span class="badge">${escapeHtml(dbg)}</span>
        </div>
        <div>
          <span class="badge">연결 ${connected ? '🟢' : '🔴'}</span>
          <span class="badge">방코드 ${escapeHtml(roomCode)}</span>
          ${errText ? `<span class="badge" style="background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.35)">ERR ${escapeHtml(errText)}</span>` : ''}
        </div>
      </div>

      <div class="stage">
        <div class="hostPanel">
          <div class="hostStatus">
            <div class="phase-title">${escapeHtml(phaseLabel(state))}</div>
            <div class="phase-time">${escapeHtml(timerText)}</div>
            <div class="timer-bar"><div class="timer-bar-fill" style="width:${pct}%"></div></div>
            <div class="phase-sub muted">생존 ${aliveCount}/${players.length}</div>
          </div>
          <div class="seat host">
            <div class="imgwrap">
              <img src="assets/cards/back.png" alt="">
            </div>
            <div class="name">사회자</div>
          </div>
        </div>

        <div class="table grid" style="--seat-cols:${cols}">
          ${seatHtml}
        </div>
      </div>

      ${phase === PHASE.DEAL ? renderDealBoardOverlay(state) : ''}
    </div>
  `;

  handleEvents(state);

  // 상태가 실제로 업데이트되었으면(used=true) pending도 정리
  if (dealPickInFlight && usedNow[dealPickInFlight.cardIndex]) {
    pendingDealPick.delete(dealPickInFlight.cardIndex);
    dealPickInFlight = null;
    dealPickStatus = null;
  }

  // ACK가 오래 안 오면(호스트 무시/통신 실패) UI를 풀어준다
  if (dealPickInFlight && Date.now() - dealPickInFlight.startedAt > 15000) {
    const { cardIndex, playerId } = dealPickInFlight;
    pendingDealPick.delete(cardIndex);
    dealPickInFlight = null;
    dealPickStatus = { kind: 'warn', message: '배정 반영이 지연되고 있어요. 원인 확인 중…' };
    // 비동기 진단(큐에 남아있는지 / 처리됐는지)
    diagnoseDealPickTimeout({ cardIndex, playerId });
  }

  if (phase === PHASE.DEAL) wireDeal(state);
  else pendingDealPick.clear();
}

/* =========================
   네트워크
========================= */
async function joinRoom(code) {
  if (!/^\d{4}$/.test(code)) {
    alert('4자리 코드');
    return;
  }

  roomCode = code;
  failures = 0;
  lastRenderKey = null;

  const t0 = performance.now();
  const st = await getState(roomCode);
  lastPollMs = Math.round(performance.now() - t0);
  lastPollAt = Date.now();
  lastNetError = null;
  if (!st) {
    alert('방 없음');
    return;
  }

  // PING(pushAction)은 write-lock 경쟁을 유발해 DEAL(dealPick) 지연/실패를 만들 수 있어 기본 비활성.
  // 연결 상태는 getState 성공 여부로만 판단한다.
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);

  setConnected(true);
  renderTable(st);
}

async function poll() {
  try {
    const t0 = performance.now();
    const st = await getState(roomCode);
    if (!st) throw new Error('no state');
    lastPollMs = Math.round(performance.now() - t0);
    lastPollAt = Date.now();
    lastNetError = null;

    failures = 0;

    // getState 성공 자체를 연결로 간주 (hostHeartbeat는 setState 주기가 줄면 stale해질 수 있음)
    setConnected(true);

    const key = computeRenderKey(st);
    if (key !== lastRenderKey) {
      lastRenderKey = key;
      renderTable(st);
    }
  } catch {
    lastNetError = 'getState failed';
    failures++;
    if (failures >= FAIL_TO_DISCONNECT) setConnected(false);
  }
}

/* =========================
   시작 (DOM 보장)
========================= */
document.addEventListener('DOMContentLoaded', () => {
  root = document.getElementById('display');
  if (!root) {
    alert('#display 엘리먼트를 찾을 수 없습니다.');
    return;
  }
  renderDisconnected();
});