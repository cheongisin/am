import { genRoomCode, getState, patchState, pushAction } from './gasApi.js';
import { PHASE, ROLE_LABEL } from '../src/constants.js';

const root = document.getElementById('display');

let connected = false;
let roomCode = '';
let pollTimer = null;
let beatTimer = null;
let failures = 0;
let lastRenderToken = null;

const POLL_MS = 800;
const BEAT_MS = 2000;
const FAIL_TO_DISCONNECT = 6;

/* =========================
   공통 유틸
========================= */
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function setConnected(v) {
  connected = !!v;
}

/* =========================
   치명 에러 표시
========================= */
function showFatal(err) {
  root.innerHTML = `
    <div style="padding:16px">
      <h2>display.js 오류</h2>
      <pre style="white-space:pre-wrap">${escapeHtml(err?.stack || err)}</pre>
      <button onclick="location.reload()">새로고침</button>
    </div>
  `;
}

window.addEventListener('error', e => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', e => showFatal(e.reason));

/* =========================
   연결 전 화면
========================= */
function renderDisconnected() {
  root.innerHTML = `
    <div class="display-wrap">
      <div class="panel">
        <h3>진행자 연결</h3>
        <div class="row">
          <input id="roomInput" placeholder="4자리 코드" />
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
   메인 테이블 렌더
========================= */
function renderTable(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const phase = state?.phase || PHASE.SETUP;
  const timer = state?.timer || {};

  const aliveCount = players.filter(p => p?.alive !== false).length;

  const timerText = (() => {
    if (timer.mode === 'INFINITE') return '∞';
    if (timer.mode === 'COUNTDOWN') {
      const endAt = timer.running ? timer.endAt : null;
      const sec = endAt
        ? Math.max(0, Math.ceil((endAt - Date.now()) / 1000))
        : Number(timer.durationSec || 0);
      return `${String(Math.floor(sec / 60)).padStart(2,'0')}:${String(sec % 60).padStart(2,'0')}`;
    }
    return '--:--';
  })();

  /* 좌석 생성 (CSS가 배치 담당) */
  const seatHtml = players.map((p, i) => {
    const dead = p.alive === false;
    const label =
      p.publicCard && p.publicCard !== 'CITIZEN'
        ? (ROLE_LABEL[p.publicCard] || p.publicCard)
        : 'CITIZEN';

    return `
      <div class="seat">
        <div class="card ${dead ? 'dead' : ''}">
          <div class="card-top">${label}</div>
          <div class="card-body"></div>
        </div>
        <div class="name">${escapeHtml(p.name || `P${i+1}`)}</div>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <div class="table-wrap">
      <div class="hud">
        <div class="hud-left">
          <span class="badge">${phase}</span>
          <span class="badge">타이머 ${timerText}</span>
          <span class="badge">생존 ${aliveCount}/${players.length}</span>
        </div>
        <div class="hud-right">
          <span class="badge">연결 ${connected ? '🟢' : '🔴'}</span>
          <span class="badge">방코드 ${roomCode}</span>
        </div>
      </div>

      <div class="table-area">
        <div class="seat-layer">
          <div class="host-anchor">사회자</div>
          ${seatHtml}
        </div>
      </div>

      ${phase === PHASE.DEAL ? renderDealPanel(state) : ''}
    </div>
  `;

  if (phase === PHASE.DEAL) wireDeal(state);
}

/* =========================
   카드 배정
========================= */
function renderDealPanel(state) {
  const used = Array.isArray(state.deckUsed) ? state.deckUsed : [];
  const remain = used.filter(v => !v).length;

  return `
    <div class="deal-panel">
      <h3>직업 배정 (남은 카드 ${remain})</h3>
      <div class="deal-grid">
        ${used.map((u,i)=>`
          <button class="deal-card" data-idx="${i}" ${u?'disabled':''}>
            ${u?'사용됨':`카드 ${i+1}`}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

function wireDeal(state) {
  document.querySelectorAll('.deal-card').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await pushAction(roomCode, {
          type: 'DEAL_PICK',
          cardIndex: Number(btn.dataset.idx),
          playerId: guessNextPlayer(state)
        });
      } catch (e) {
        btn.disabled = false;
        alert('전송 실패');
      }
    };
  });
}

function guessNextPlayer(state) {
  const p = state.players.find(x => x.assigned === false);
  return p ? p.id : 0;
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
  lastRenderToken = null;

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
    if (!st) throw new Error();

    failures = 0;

    const hb = Number(st.hostHeartbeat || 0);
    setConnected(hb && Date.now() - hb < 30000);

    const token = st.eventQueue?.token || `${st.phase}-${hb}-${st.timer?.endAt}`;
    if (token !== lastRenderToken) {
      lastRenderToken = token;
      renderTable(st);
    }
  } catch {
    failures++;
    if (failures >= FAIL_TO_DISCONNECT) setConnected(false);
  }
}

/* =========================
   시작
========================= */
renderDisconnected();