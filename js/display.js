import { genRoomCode, getState, patchState, pushAction } from './gasApi.js';
import { PHASE, CARD } from '../src/constants.js';

let root = null;

/* =========================
   상태 변수
========================= */
let connected = false;
let roomCode = '';
let pollTimer = null;
let beatTimer = null;
let failures = 0;
let lastRenderKey = null;

const POLL_MS = 800;
const BEAT_MS = 2000;
const FAIL_TO_DISCONNECT = 6;

// DEAL 클릭-폴링 레이스 방지(최소 로컬 상태)
const pendingDealPick = new Set();

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
  const mode = st?.timer?.mode ?? '';
  const endAt = st?.timer?.endAt ?? '';
  const alive = (st?.players || []).map(p => (p?.alive === false ? '0' : '1')).join('');
  const pub = (st?.players || []).map(p => (p?.publicCard || '')).join('|');
  const used = getDeckUsed(st).map(v => (v ? '1' : '0')).join('');
  return `${phase}|${hb}|${mode}|${endAt}|${alive}|${pub}|${used}`;
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
        <div class="muted">상태: ${connected ? '🟢' : '🔴'}</div>
      </div>
    </div>
  `;

  document.getElementById('joinBtn').onclick = () => {
    const code = document.getElementById('roomInput').value.trim();
    joinRoom(code);
  };
}

/* =========================
   DEAL UI
========================= */
function renderDealPanel(state) {
  const used = getDeckUsed(state);
  const remain = used.filter(v => !v).length;

  return `
    <div class="dealwrap">
      <h3>직업 배정 (남은 카드 ${remain})</h3>
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
    </div>
  `;
}

function guessNextPlayer(state) {
  const p = state.players.find(x => x.assigned === false);
  return p ? p.id : 0;
}

function wireDeal(state) {
  const used = getDeckUsed(state);

  document.querySelectorAll('.cardbtn').forEach(btn => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.idx);
      if (!Number.isFinite(idx)) return;
      if (used[idx]) return;
      if (pendingDealPick.has(idx)) return;

      pendingDealPick.add(idx);
      btn.disabled = true;

      try {
        await pushAction(roomCode, {
          type: 'DEAL_PICK',
          cardIndex: idx,
          playerId: guessNextPlayer(state)
        });
      } catch {
        pendingDealPick.delete(idx);
        btn.disabled = false;
        alert('전송 실패');
      }
    };
  });
}

/* =========================
   메인 렌더 (layout.css 구조에 맞춤)
========================= */
function renderTable(state) {
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

  root.innerHTML = `
    <div class="board">
      <div class="hud">
        <div>
          <span class="badge">${escapeHtml(phase)}</span>
          <span class="badge">타이머 ${escapeHtml(timerText)}</span>
          <span class="badge">생존 ${aliveCount}/${players.length}</span>
        </div>
        <div>
          <span class="badge">연결 ${connected ? '🟢' : '🔴'}</span>
          <span class="badge">방코드 ${escapeHtml(roomCode)}</span>
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

      ${phase === PHASE.DEAL ? renderDealPanel(state) : ''}
    </div>
  `;

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

  const st = await getState(roomCode);
  if (!st) {
    alert('방 없음');
    return;
  }

  if (beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(() => {
    patchState(roomCode, { clientHeartbeat: Date.now() }).catch(()=>{});
  }, BEAT_MS);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);

  setConnected(true);
  renderTable(st);
}

async function poll() {
  try {
    const st = await getState(roomCode);
    if (!st) throw new Error('no state');

    failures = 0;

    const hb = Number(st.hostHeartbeat || 0);
    setConnected(hb && Date.now() - hb < 30000);

    const key = computeRenderKey(st);
    if (key !== lastRenderKey) {
      lastRenderKey = key;
      renderTable(st);
    }
  } catch {
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