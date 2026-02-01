import { genRoomCode, getState, patchState, pushAction } from './gasApi.js';
import { PHASE, ROLE_LABEL } from '../src/constants.js';
import { buildSeats } from './layout.js';

const root = document.getElementById('display');

let connected = false;
let roomCode = '';
let pollTimer = null;
let beatTimer = null;
let failures = 0;
let lastHostBeatSeen = 0;
let lastRenderToken = null;

// 디스플레이도 너무 민감하게 끊지 않기
const FAIL_TO_DISCONNECT = 6;
const POLL_MS = 700;     // 너무 빠르면 브라우저/네트워크 흔들림
const BEAT_MS = 2000;

function showFatal(err) {
  const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
  root.innerHTML = `
    <div style="padding:16px;max-width:900px;margin:0 auto;">
      <h2 style="margin:8px 0;">display.js 런타임 에러</h2>
      <p style="opacity:.8">아래 메시지를 그대로 캡쳐해서 보내면 원인 바로 잡을 수 있음</p>
      <pre style="white-space:pre-wrap;background:rgba(0,0,0,.35);padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.12);">${escapeHtml(msg)}</pre>
      <button id="reloadBtn" style="margin-top:10px;padding:10px 14px;">새로고침</button>
    </div>
  `;
  const btn = document.getElementById('reloadBtn');
  if (btn) btn.onclick = () => location.reload();
}

window.addEventListener('error', (e) => {
  showFatal(e?.error || e?.message || e);
});
window.addEventListener('unhandledrejection', (e) => {
  showFatal(e?.reason || e);
});

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function setConnected(flag) {
  connected = !!flag;
}

function renderDisconnectedScreen() {
  root.innerHTML = `
    <div class="display-wrap">
      <div class="panel">
        <div class="row">
          <div class="badge">진행자 연결 (방코드)</div>
          <div class="badge">상태: ${connected ? '🟢' : '🔴'}</div>
        </div>
        <div class="row" style="margin-top:12px;gap:8px;align-items:flex-end;">
          <div style="flex:1">
            <label>방 코드</label>
            <input id="roomInput" value="${roomCode}" placeholder="4자리 코드" inputmode="numeric" />
          </div>
          <button id="joinBtn" class="primary">접속</button>
          <button id="newBtn">새로고침</button>
        </div>
        <p class="muted" style="margin-top:10px;">사회자가 만든 4자리 코드를 입력 후 접속하세요.</p>
      </div>
    </div>
  `;

  document.getElementById('joinBtn').onclick = async () => {
    const code = (document.getElementById('roomInput').value || '').trim();
    await joinRoom(code);
  };
  document.getElementById('newBtn').onclick = () => location.reload();
}

function renderTable(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const phase = state?.phase || PHASE.SETUP;
  const timer = state?.timer || { mode: 'STOPPED' };

  const aliveCount = players.filter(p => p?.alive !== false).length;
  const timerText = (() => {
    if (timer?.mode === 'INFINITE') return '∞';
    if (timer?.mode === 'COUNTDOWN') {
      const endAt = timer?.running && timer?.endAt ? timer.endAt : null;
      const remain = endAt ? Math.max(0, Math.ceil((endAt - Date.now()) / 1000)) : Math.max(0, Number(timer?.durationSec || 0));
      const m = Math.floor(remain / 60);
      const s = remain % 60;
      return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    return '--:--';
  })();

  const seats = buildSeats(players.length); // layout.js 기준 (이미 너가 레이아웃 맞춘 상태)
  const seatHtml = seats.map((seat, idx) => {
    const p = players[idx] || { name: `P${idx + 1}`, publicCard: 'CITIZEN', alive: true };
    const dead = p.alive === false;
    const label = p.publicCard && p.publicCard !== 'CITIZEN' ? (ROLE_LABEL[p.publicCard] || p.publicCard) : 'CITIZEN';
    return `
      <div class="seat ${seat.cls}">
        <div class="card ${dead ? 'dead' : ''}">
          <div class="card-top">${label}</div>
          <div class="card-body"></div>
        </div>
        <div class="name">${escapeHtml(p.name || `P${idx + 1}`)}</div>
      </div>
    `;
  }).join('');

  root.innerHTML = `
    <div class="table-wrap">
      <div class="hud">
        <div class="hud-left">
          <div class="badge">${phase}</div>
          <div class="badge">타이머 ${timerText}</div>
          <div class="badge">생존 ${aliveCount}/${players.length}</div>
        </div>
        <div class="hud-right">
          <div class="badge">연결 ${connected ? '🟢' : '🔴'}</div>
          <div class="badge">방코드 ${roomCode || '-'}</div>
        </div>
      </div>

      <div class="table-area">
        <div class="seat-layer">
          ${seatHtml}
          <div class="host-anchor">사회자</div>
        </div>
      </div>

      ${phase === PHASE.DEAL ? renderDealPanel(state) : ''}
    </div>
  `;

  // DEAL: 카드 선택 버튼 이벤트
  if (phase === PHASE.DEAL) wireDeal(state);
}

function renderDealPanel(state) {
  const deck = Array.isArray(state?.deckUsed) ? state.deckUsed : [];
  const left = deck.filter(v => !v).length;

  // 0~(n-1) 카드
  const cards = deck.map((used, i) => {
    return `<button class="deal-card" data-idx="${i}" ${used ? 'disabled' : ''}>${used ? '사용' : `카드 ${i + 1}`}</button>`;
  }).join('');

  return `
    <div class="deal-panel">
      <div class="deal-title">직업 배정 (남은 카드: ${left})</div>
      <div class="deal-grid">${cards}</div>
    </div>
  `;
}

function wireDeal(state) {
  document.querySelectorAll('.deal-card').forEach(btn => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.idx);
      // 즉시 비활성화 (중복 클릭/연결 흔들림 방지)
      btn.disabled = true;
      try {
        await pushAction(roomCode, { type: 'DEAL_PICK', cardIndex: idx, playerId: guessNextPlayerId(state) });
      } catch (e) {
        // 실패시 다시 활성화
        btn.disabled = false;
        alert(`전송 실패: ${e?.message || e}`);
      }
    };
  });
}

// 간단: 아직 assigned=false인 사람에게 순서대로 배정
function guessNextPlayerId(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const p = players.find(x => x && x.assigned === false);
  return p ? Number(p.id) : 0;
}

async function joinRoom(code) {
  roomCode = String(code || '').trim();
  if (!/^\d{4}$/.test(roomCode)) {
    alert('4자리 코드가 필요합니다.');
    return;
  }

  failures = 0;
  lastRenderToken = null;

  // 먼저 state가 존재하는지 확인
  const st = await getState(roomCode);
  if (!st || st.ok === false || st.error === 'not_found') {
    alert('해당 방을 찾을 수 없습니다. 방 코드가 맞는지 확인하세요.');
    renderDisconnectedScreen();
    return;
  }

  // 접속 직후 heartbeat 시작
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(async () => {
    try { await patchState(roomCode, { clientHeartbeat: Date.now() }); }
    catch {}
  }, BEAT_MS);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);

  setConnected(true);
  renderTable(st);
}

async function poll() {
  if (!roomCode) return;

  try {
    // clientHeartbeat 계속
    await patchState(roomCode, { clientHeartbeat: Date.now() });

    const st = await getState(roomCode);
    if (!st || st.ok === false) {
      failures += 1;
      if (failures >= FAIL_TO_DISCONNECT) setConnected(false);
      return;
    }

    failures = 0;

    // hostHeartbeat 보고 연결 상태 판정 (있으면 더 정확)
    const hb = Number(st.hostHeartbeat || 0);
    if (hb && hb !== lastHostBeatSeen) lastHostBeatSeen = hb;
    if (hb) setConnected(Date.now() - hb < 30000);

    // 토큰 기반으로 과도한 렌더 줄이기 (이벤트/상태 변경 있을 때만)
    const token = st.eventQueue?.token || `${st.phase}-${hb}-${st.timer?.endAt || ''}-${st.timer?.durationSec || ''}`;
    if (token !== lastRenderToken) {
      lastRenderToken = token;
      renderTable(st);
    } else {
      // 타이머 텍스트만 움직여야 하니 최소 렌더: 그냥 전체 렌더 허용해도 되지만, 여기선 유지
      // 필요하면 여기서 HUD만 업데이트하도록 확장 가능
    }
  } catch {
    failures += 1;
    if (failures >= FAIL_TO_DISCONNECT) setConnected(false);
  }
}

renderDisconnectedScreen();