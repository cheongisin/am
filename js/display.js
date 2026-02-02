/* js/display.js
 * Display(진행 화면) 전용
 * - 사회자 좌측 고정(플레이어 아님)
 * - 나머지 플레이어 자동 분배: 위/아래 2줄 (ceil/floor)
 * - layout.css가 기대하는 구조(.board .hud .table .seat)를 사용
 * - deckUsed → deckInfo.used로 수정
 * - iOS Safari 포함 안정 렌더를 위해 "스냅샷 토큰" 기반 렌더 제한 + 클릭 pending 잠금
 */

import { GAS } from './constants.js';
import { getState, patchState, pushAction } from './gasApi.js';
import { PHASE } from './constants.js'; // 기존에 PHASE를 constants에서 export한다는 전제
// 만약 PHASE가 없다면 아래 주석 해제해서 사용:
// const PHASE = { SETUP:'SETUP', DEAL:'DEAL', NIGHT:'NIGHT', DAY:'DAY', VOTE:'VOTE', EXECUTION:'EXECUTION', END:'END' };

const root = document.getElementById('display');
if (!root) throw new Error('#display root not found');

let roomCode = '';
let connected = false;

let pollTimer = null;
let hbTimer = null;

let failures = 0;
const FAIL_TO_DISCONNECT = 6; // 기존보다 둔감하게
const POLL_MS = 800;
const HB_MS = 2000;

// 클릭-폴링 레이스 방지용(최소 로컬 상태)
const pendingDealPick = new Set(); // idx 저장

// 렌더 재진입/과다 렌더 방지용
let lastRenderKey = '';

/* ------------------------------
 * 좌석 배치: 사회자(좌측) + 참가자(위/아래)
 * ------------------------------ */
function seatPosPct_rows(n, i) {
  // 위 = ceil(n/2), 아래 = floor(n/2)
  const topCount = Math.ceil(n / 2);
  const bottomCount = n - topCount;

  const isTop = i < topCount;
  const idx = isTop ? i : (i - topCount);
  const cnt = isTop ? topCount : bottomCount;

  // 오른쪽 영역에만 배치
  const xStart = 28; // 좌측 여백(사회자 영역 비우기)
  const xEnd = 96;

  // 위/아래 y
  const yTop = 28;
  const yBottom = 72;

  const x = (cnt <= 1)
    ? (xStart + xEnd) / 2
    : (xStart + (xEnd - xStart) * (idx / (cnt - 1)));

  const y = isTop ? yTop : yBottom;

  return { x, y };
}

/* ------------------------------
 * 유틸
 * ------------------------------ */
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getDeckUsed(state) {
  // 공개 상태 기준: deckInfo.used
  const used = state?.deckInfo?.used;
  return Array.isArray(used) ? used : [];
}

function computeRenderKey(state) {
  // eventQueue.token에만 묶지 말고, phase + deckUsed + timer + players의 핵심만 섞어서 키 생성
  const phase = state?.phase ?? '';
  const night = state?.night ?? '';
  const endAt = state?.timer?.endAt ?? '';
  const timerMode = state?.timer?.mode ?? '';
  const alive = (state?.players || []).map(p => (p?.alive === false ? '0' : '1')).join('');
  const pub = (state?.players || []).map(p => (p?.publicCard || '')).join('|');
  const used = getDeckUsed(state).map(v => (v ? '1' : '0')).join('');
  return `${phase}|${night}|${timerMode}|${endAt}|${alive}|${pub}|${used}`;
}

function formatTimerText(timer) {
  if (!timer) return '--:--';
  if (timer.mode === 'INFINITE') return '∞';
  if (timer.mode === 'COUNTDOWN') {
    const endAt = timer.running ? timer.endAt : null;
    const sec = endAt
      ? Math.max(0, Math.ceil((endAt - Date.now()) / 1000))
      : Number(timer.durationSec || 0);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
  return '--:--';
}

/* ------------------------------
 * DEAL UI
 * ------------------------------ */
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

function wireDeal(state) {
  const used = getDeckUsed(state);
  const buttons = root.querySelectorAll('.cardbtn');
  buttons.forEach(btn => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.idx);
      if (!Number.isFinite(idx)) return;
      if (used[idx]) return; // 이미 사용됨
      if (pendingDealPick.has(idx)) return;

      // 즉시 잠금(렌더 교체/폴링에도 유지)
      pendingDealPick.add(idx);
      btn.disabled = true;

      try {
        await pushAction(roomCode, {
          type: 'DEAL_PICK',
          idx
          // playerId/seat 지정 로직이 기존에 있다면 여기 포함해야 함
          // 현재 구조상 "다음 플레이어"는 Host가 관리하므로 display는 idx만 보내는 형태를 유지
        });
      } catch (e) {
        // 실패 시 잠금 해제(다음 렌더에서 살아남게)
        pendingDealPick.delete(idx);
        btn.disabled = false;
      }
    };
  });
}

/* ------------------------------
 * 렌더
 * ------------------------------ */
function render(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const phase = state?.phase || PHASE.SETUP;
  const timerText = formatTimerText(state?.timer);

  const aliveCount = players.filter(p => p?.alive !== false).length;

  const seatHtml = players.map((p, i) => {
    const dead = p?.alive === false;
    const { x, y } = seatPosPct_rows(players.length, i);

    return `
      <div class="seat ${dead ? 'dead' : ''}" style="left:${x}%; top:${y}%;">
        <div class="imgwrap">
          <img src="assets/cards/back.png" alt="">
        </div>
        <div class="name">${escapeHtml(p?.name || `P${i + 1}`)}</div>
      </div>
    `;
  }).join('');

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

      <div class="table">
        <!-- 사회자(플레이어 아님) 좌측 고정 -->
        <div class="seat host" style="left:10%; top:50%;">
          <div class="imgwrap">
            <img src="assets/cards/back.png" alt="">
          </div>
          <div class="name">HOST</div>
        </div>

        ${seatHtml}
      </div>

      ${phase === PHASE.DEAL ? renderDealPanel(state) : ''}
    </div>
  `;

  if (phase === PHASE.DEAL) wireDeal(state);

  // DEAL이 끝나면 pending 잠금은 의미가 없으니 정리
  if (phase !== PHASE.DEAL) pendingDealPick.clear();
}

/* ------------------------------
 * 연결/폴링
 * ------------------------------ */
async function poll() {
  if (!roomCode) return;

  try {
    const st = await getState(roomCode);
    if (!st) throw new Error('empty state');

    // 연결 판정(hostHeartbeat 기반)
    const hb = st.hostHeartbeat || 0;
    const age = Date.now() - hb;
    const ok = Number.isFinite(hb) && age < (HB_MS * FAIL_TO_DISCONNECT);

    if (ok) {
      failures = 0;
      connected = true;
    } else {
      failures++;
      if (failures >= FAIL_TO_DISCONNECT) connected = false;
    }

    // 렌더 제한(상태가 실질적으로 변할 때만)
    const key = computeRenderKey(st);
    if (key !== lastRenderKey) {
      lastRenderKey = key;
      render(st);
    } else {
      // 타이머만 움직이는 경우도 있으니 HUD 타이머는 필요하면 갱신
      // (현재는 key에 endAt 포함되어 COUNTDOWN이면 자연히 갱신됨)
    }
  } catch (e) {
    failures++;
    if (failures >= FAIL_TO_DISCONNECT) connected = false;
    // 네트워크 실패 시에도 HUD 정도는 갱신되도록 최소 렌더(옵션)
    // 여기서는 그대로 둠
  }
}

async function heartbeat() {
  if (!roomCode) return;
  try {
    await patchState(roomCode, { clientHeartbeat: Date.now() });
  } catch (e) {
    // 무시
  }
}

/* ------------------------------
 * 부팅/입장
 * ------------------------------ */
function getRoomCodeFromUrlOrPrompt() {
  // 1) URL ?room=1234
  const params = new URLSearchParams(location.search);
  const r = params.get('room');
  if (r && /^[0-9]{4}$/.test(r)) return r;

  // 2) localStorage
  const saved = localStorage.getItem('roomCode');
  if (saved && /^[0-9]{4}$/.test(saved)) return saved;

  // 3) prompt
  const input = prompt('방코드(4자리)를 입력하세요');
  if (input && /^[0-9]{4}$/.test(input.trim())) return input.trim();
  return '';
}

async function main() {
  roomCode = getRoomCodeFromUrlOrPrompt();
  if (!roomCode) {
    root.innerHTML = `<div style="padding:16px">방코드가 필요합니다.</div>`;
    return;
  }
  localStorage.setItem('roomCode', roomCode);

  // 초기 상태 로딩
  try {
    const st = await getState(roomCode);
    if (!st) throw new Error('state not found');
    lastRenderKey = ''; // 강제 렌더
    render(st);
  } catch (e) {
    root.innerHTML = `<div style="padding:16px">상태를 불러오지 못했습니다. 방코드를 확인하세요.</div>`;
    return;
  }

  // 루프 시작
  if (pollTimer) clearInterval(pollTimer);
  if (hbTimer) clearInterval(hbTimer);

  pollTimer = setInterval(poll, POLL_MS);
  hbTimer = setInterval(heartbeat, HB_MS);

  // 즉시 한 번 더
  heartbeat();
  poll();
}

document.addEventListener('DOMContentLoaded', main);