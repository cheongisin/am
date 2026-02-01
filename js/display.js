import {el} from './util.js';
import {getState, patchState, pushAction} from './gasApi.js';
import {PHASE, CARD, DEAD_CARD, EVENT_IMG, ROLE_LABEL} from '../src/constants.js';

let wakeLock=null;
async function keepAwake(){ try{ wakeLock = await navigator.wakeLock.request('screen'); }catch{} }
document.addEventListener('click', keepAwake, {once:true});

const root=document.getElementById('display');
let connected=false;
let roomCode='';
let state=null;
let deal={active:false, deckCount:0, used:[]};
let pollTimer=null;
let beatTimer=null;
let timerTick=null;
let lastEventToken=0;
let eventPlayback = Promise.resolve();

const previewState = typeof window !== 'undefined' ? window.__AM_PREVIEW_STATE__ : null;
if(previewState){
  state = previewState;
  connected = true;
}

function formatTimer(seconds){
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s/60);
  const r = s%60;
  return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
}
function getTimerRemaining(timer){
  if(!timer || timer.mode!=='COUNTDOWN') return null;
  if(timer.running && timer.endAt){
    return Math.max(0, Math.ceil((timer.endAt - Date.now())/1000));
  }
  return Math.max(0, Math.floor(timer.durationSec || 0));
}

render();

function render(){
  if(!state){
    root.innerHTML = `
      <div class="app">
        <div class="card">
          <h3>진행자 연결 (방코드)</h3>
          <p class="muted small">사회자가 만든 4자리 코드를 입력하면 연결됩니다.</p>
          <label>방 코드</label>
          <input id="code" placeholder="예: 4831" value="${roomCode}">
          <div class="actions" style="margin-top:10px">
            <button class="primary" id="join">접속</button>
          </div>
          <div class="muted small">상태: ${connected?'연결 성공 🟢':'연결 실패 🔴'}</div>
        </div>
      </div>
    `;
    root.querySelector('#join').onclick = async ()=>{
      const code = root.querySelector('#code').value.trim();
      await connectToRoom(code);
    };
    return;
  }

  if(state.phase===PHASE.DEAL && deal.active){
    root.innerHTML = `
      <div class="dealwrap">
        <div class="card">
          <h3>카드 뽑기</h3>
          <div class="deck" id="deck"></div>
        </div>
      </div>
    `;
    const deckEl=root.querySelector('#deck');
    for(let i=0;i<deal.deckCount;i++){
      const used = deal.used[i];
      const btn=el(`<div class="cardbtn ${used?'used':''}" data-i="${i}"><img src="${CARD.BACK}"></div>`);
      if(!used) btn.onclick=()=>openPickModal(i);
      deckEl.appendChild(btn);
    }
    return;
  }

  /* ===== 테이블 뷰 ===== */
  root.innerHTML = `
    <div class="board">
      <div class="hud">
        <span class="badge">생존 ${state.players.filter(p=>p.alive).length}/${state.players.length}</span>
        <span class="badge" id="connBadge">연결 ${connected?'🟢':'🔴'}</span>
        ${state.winner? `<span class="badge">승리: ${state.winner}</span>`:''}
      </div>

      <div class="stage">
        <!-- 사회자 -->
        <div class="hostPanel">
          <div class="seat host">
            <div class="imgwrap">
              <img src="assets/pront.svg" alt="사회자">
            </div>
            <div class="name">사회자</div>
          </div>
        </div>

        <!-- 테이블 -->
        <div class="table" id="table">
          <div class="phase-center">
            <div class="phase-title" id="phaseTitle"></div>
            <div class="phase-time" id="timerBadge"></div>
            <div class="phase-sub" id="phaseSub"></div>
            <div class="timer-bar" id="timerBar">
              <div class="timer-bar-fill" id="timerBarFill"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  renderSeats();
  updateHudBadge();
  updateTimerBadge();
  updatePhaseCenter();
}

/* ===== 좌석 배치 (8~12명 자동, 2열) ===== */
function renderSeats(){
  const table = root.querySelector('#table');
  const players = state.players;
  const total = players.length;

  const topCount = Math.ceil(total / 2);
  const bottomCount = total - topCount;

  players.forEach((player, i)=>{
    const isTop = i < topCount;
    const index = isTop ? i : i - topCount;
    const rowCount = isTop ? topCount : bottomCount;

    const x = 8 + (84 / ((rowCount - 1) || 1)) * index;
    const y = isTop ? 24 : 76;

    const alive = player.alive;
    const cardKey = state.winner ? (player.role || player.publicCard) : player.publicCard;
    const img = !alive
      ? (DEAD_CARD[cardKey] || CARD[cardKey] || CARD.CITIZEN)
      : (CARD[cardKey] || CARD.CITIZEN);

    const seat=el(`
      <div class="seat ${alive?'':'dead'}" style="left:${x}%; top:${y}%">
        <div class="imgwrap"><img src="${img}"></div>
        <div class="name">${player.name}</div>
      </div>
    `);
    table.appendChild(seat);
  });
}

/* ===== 카드 뽑기 ===== */
function openPickModal(cardIndex){
  const options = state.players.filter(p=>!p.assigned)
    .map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  const bd = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <h3>본인 선택</h3>
        <select id="pSel">${options}</select>
        <div class="actions">
          <button id="ok" class="primary">확인</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(bd);
  bd.querySelector('#ok').onclick=()=>{
    const pid = Number(bd.querySelector('#pSel').value);
    bd.remove();
    pushAction(roomCode, {type:'DEAL_PICK', cardIndex, playerId: pid}).catch(()=>{});
  };
}

/* ===== 이벤트/연출 ===== */
async function showEvent(ev){
  const src = EVENT_IMG[ev.type] || EVENT_IMG.MAFIA_KILL;
  const overlay = el(`
    <div class="event-overlay">
      <img class="event-img" src="${src}">
    </div>
  `);
  document.body.appendChild(overlay);
  await new Promise(r=>setTimeout(r, 8000));
  overlay.remove();
}

/* ===== GAS 연결 ===== */
async function connectToRoom(code){
  roomCode = String(code||'').trim();
  if(!/^\d{4}$/.test(roomCode)){
    alert('4자리 코드 필요');
    return;
  }
  try{
    const st = await getState(roomCode);
    if(!st || !st.phase){
      alert('방 없음');
      return;
    }
    connected=true;
    await patchState(roomCode, {clientHeartbeat: Date.now()});
    state = st;
    startTimers();
    render();
  }catch(e){
    connected=false;
    alert('연결 실패');
    render();
  }
}

function startTimers(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, 500);
  if(beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(()=>{
    if(roomCode) patchState(roomCode, {clientHeartbeat: Date.now()}).catch(()=>{});
  }, 2000);
  if(timerTick) clearInterval(timerTick);
  timerTick = setInterval(()=>{
    updateTimerBadge();
    updatePhaseCenter();
  }, 500);
}

async function pollOnce(){
  if(!roomCode) return;
  try{
    const st = await getState(roomCode);
    if(!st) return;
    connected = !!(st.hostHeartbeat && (Date.now()-st.hostHeartbeat < 15000));
    state = st;
    applyState(st);
  }catch{
    connected=false;
    updateHudBadge();
  }
}

function applyState(st){
  if(st.deckInfo){
    deal.active = (st.phase===PHASE.DEAL);
    deal.deckCount = st.deckInfo.count;
    deal.used = st.deckInfo.used || [];
  }else{
    deal.active=false;
  }

  render();

  if(st.eventQueue && st.eventQueue.token !== lastEventToken){
    lastEventToken = st.eventQueue.token;
    eventPlayback = eventPlayback.then(async()=>{
      for(const ev of st.eventQueue.events || []){
        if(ev.type!=='DEAL_REVEAL'){
          await showEvent(ev);
        }
      }
    });
  }
}

function updateHudBadge(){
  const badge = document.getElementById('connBadge');
  if(badge) badge.textContent = `연결 ${connected?'🟢':'🔴'}`;
}

function updateTimerBadge(){
  const badge = document.getElementById('timerBadge');
  if(!badge || !state) return;
  const timer = state.timer;
  let text = '';
  if(timer?.mode==='INFINITE') text='∞';
  else if(timer?.mode==='COUNTDOWN') text=formatTimer(getTimerRemaining(timer));
  badge.textContent = text;
}

function updatePhaseCenter(){
  const t = document.getElementById('phaseTitle');
  if(!t || !state) return;
  if(state.phase===PHASE.NIGHT) t.textContent='밤';
  else if(state.phase===PHASE.DAY) t.textContent='낮';
  else if(state.phase===PHASE.VOTE) t.textContent='투표';
  else if(state.phase===PHASE.EXECUTION) t.textContent='처형';
  else if(state.phase===PHASE.DEAL) t.textContent='배정중';
    }
