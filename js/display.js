// js/display.js
import {
  getState,
  pullActions,
  clearActions
} from './gasApi.js';
import { PHASE } from '../src/constants.js';

/* =========================
   기본 상태
========================= */
const root = document.getElementById('display');

let state = null;
let roomCode = null;
let pollTimer = null;

let mounted = false;
let lastPhase = null;
let lastDealActive = null;

/* 연결 상태 유예 */
let connected = false;
let lastHostSeenAt = 0;

/* 좌석 DOM 캐시 */
const seatEls = [];

/* =========================
   연결 판정 (유예)
========================= */
function computeConnected(st){
  const now = Date.now();
  if (st?.hostHeartbeat) lastHostSeenAt = now;
  return (now - lastHostSeenAt) < 6000; // 6초 유예
}

/* =========================
   초기 1회 마운트
========================= */
function mountOnce(){
  if(mounted) return;
  mounted = true;

  root.innerHTML = `
    <div id="hud">
      <div id="phaseText"></div>
      <div id="timerText"></div>
      <div id="connBadge">연결 🔴</div>
    </div>

    <div id="centerMessage" class="hidden"></div>

    <div id="table"></div>

    <div id="dealLayer" class="hidden">
      <div id="dealTitle">직업 카드 선택</div>
      <div id="dealCards"></div>
    </div>
  `;
}

/* =========================
   좌석 생성 (1회)
========================= */
function buildSeatsOnce(players){
  const table = document.getElementById('table');
  table.innerHTML = '';
  seatEls.length = 0;

  players.forEach(p=>{
    const el = document.createElement('div');
    el.className = 'seat';
    el.innerHTML = `
      <img />
      <div class="name"></div>
    `;
    table.appendChild(el);
    seatEls[p.id] = el;
  });
}

/* =========================
   좌석 부분 업데이트
========================= */
function updateSeats(){
  if(!state || !seatEls.length) return;

  const players = state.players;
  const total = players.length;
  const topCount = Math.ceil(total/2);
  const bottomCount = total - topCount;

  players.forEach((p,i)=>{
    const el = seatEls[p.id];
    if(!el) return;

    const isTop = i < topCount;
    const idx = isTop ? i : i - topCount;
    const rowCount = isTop ? topCount : bottomCount;

    const x = 10 + (80 / ((rowCount - 1) || 1)) * idx;
    const y = isTop ? 25 : 75;

    el.style.left = `${x}%`;
    el.style.top = `${y}%`;

    el.classList.toggle('dead', !p.alive);
    el.querySelector('.name').textContent = p.name;

    const img = el.querySelector('img');
    if(!p.alive){
      img.src = 'assets/dead.png';
    }else{
      img.src = `assets/${p.publicCard || 'CITIZEN'}.png`;
    }
  });
}

/* =========================
   HUD 업데이트
========================= */
function updateHud(){
  const phaseEl = document.getElementById('phaseText');
  const timerEl = document.getElementById('timerText');
  const connEl = document.getElementById('connBadge');

  phaseEl.textContent = state.phase;
  timerEl.textContent = state.timer?.mode === 'COUNTDOWN'
    ? state.timer.remain
    : state.timer?.mode === 'INFINITE'
      ? '∞'
      : '--:--';

  connected = computeConnected(state);
  connEl.textContent = `연결 ${connected ? '🟢' : '🔴'}`;
}

/* =========================
   중앙 멘트
========================= */
function showCenterMessage(text, duration=2000){
  const el = document.getElementById('centerMessage');
  el.textContent = text;
  el.classList.remove('hidden');

  setTimeout(()=>{
    el.classList.add('hidden');
  }, duration);
}

/* =========================
   DEAL UI
========================= */
function updateDealUI(){
  const layer = document.getElementById('dealLayer');
  const cardsWrap = document.getElementById('dealCards');

  if(state.phase !== PHASE.DEAL){
    layer.classList.add('hidden');
    return;
  }

  layer.classList.remove('hidden');

  cardsWrap.innerHTML = '';
  state.deck.forEach((_,i)=>{
    const used = state.deckUsed[i];
    const btn = document.createElement('button');
    btn.textContent = used ? '사용됨' : `카드 ${i+1}`;
    btn.disabled = used;
    btn.onclick = ()=>{
      // 서버 응답 전 UI 고정
      state.deckUsed[i] = true;
      updateDealUI();
      // action은 host가 처리
    };
    cardsWrap.appendChild(btn);
  });
}

/* =========================
   전체 렌더 (전환용)
========================= */
function renderFull(){
  mountOnce();

  if(seatEls.length === 0){
    buildSeatsOnce(state.players);
  }

  updateHud();
  updateSeats();
  updateDealUI();
}

/* =========================
   빠른 업데이트
========================= */
function renderFast(){
  updateHud();
  updateSeats();
  updateDealUI();
}

/* =========================
   폴링
========================= */
async function poll(){
  if(!roomCode) return;

  try{
    const st = await getState(roomCode);
    if(!st) return;

    const prevPhase = state?.phase;
    const prevDeal = state?.phase === PHASE.DEAL;

    state = st;

    const phaseChanged = prevPhase !== state.phase;
    const dealChanged = prevDeal !== (state.phase === PHASE.DEAL);

    if(!mounted || phaseChanged || dealChanged){
      renderFull();

      if(phaseChanged){
        if(state.phase === PHASE.DAY) showCenterMessage('낮이 되었습니다');
        if(state.phase === PHASE.NIGHT) showCenterMessage('밤이 되었습니다');
      }
    }else{
      renderFast();
    }

    const act = await pullActions(roomCode);
    if(act?.actions?.length){
      await clearActions(roomCode, act.actions.at(-1).id);
    }
  }catch(e){
    // 실패해도 화면 유지
  }
}

/* =========================
   시작
========================= */
export function startDisplay(code){
  roomCode = code;
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, 500);
}

window.startDisplay = startDisplay;
