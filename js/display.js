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
          <p class="muted small">사회자가 만든 4자리 코드를 입력하면 연결됩니다. (기본은 연결 실패 🔴)</p>
          <label>방 코드</label>
          <input id="code" placeholder="예: 4831" value="${roomCode}">
          <div class="actions" style="margin-top:10px">
            <button class="primary" id="join">접속</button>
            <button id="retry">새로고침</button>
          </div>
          <div class="muted small" id="msg">상태: ${connected?'연결 성공 🟢':'연결 실패 🔴'}</div>
        </div>
      </div>
    `;
    root.querySelector('#join').onclick = async ()=>{
      const code = root.querySelector('#code').value.trim();
      await connectToRoom(code);
    };
    root.querySelector('#retry').onclick = async ()=>{
      if(roomCode) await connectToRoom(roomCode);
    };
    return;
  }

  if(state.phase===PHASE.DEAL && deal.active){
    root.innerHTML = `
      <div class="dealwrap">
        <div class="card">
          <div class="actions" style="justify-content:space-between">
            <span class="badge night">${state.phase}</span>
            <span class="badge" id="timerBadge"></span>
          </div>
          <h3>카드 뽑기</h3>
          <p class="muted small">카드 선택 → 본인 이름 선택 (역할 5초 표시)</p>
          <div class="deck" id="deck"></div>
        </div>
      </div>
    `;
    const deckEl=root.querySelector('#deck');
    for(let i=0;i<deal.deckCount;i++){
      const used = deal.used[i];
      const btn=el(`<div class="cardbtn ${used?'used':''}" data-i="${i}"><img src="${CARD.BACK}" alt="card"></div>`);
      if(!used) btn.onclick=()=>openPickModal(i);
      deckEl.appendChild(btn);
    }
    return;
  }

  // Table view
  root.innerHTML = `
    <div class="board">
      <div class="hud">
        <span class="badge">생존 ${state.players.filter(p=>p.alive).length}/${state.players.length}</span>
        <span class="badge" id="connBadge">연결 ${connected?'🟢':'🔴'}</span>
        ${state.winner? `<span class="badge">승리: ${state.winner}</span>`:''}
      </div>
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
  `;
  const table=root.querySelector('#table');
  const hostSeat = {
    id: 'host',
    name: '사회자',
    img: 'assets/pront.svg',
    dead: false,
    cardKey: 'host'
  };
  const totalSeats = state.players.length + 1;
  const hostSlotIndex = Math.floor(totalSeats / 2); // 6시 방향
  const slots = Array.from({length: totalSeats}, () => null);
  slots[hostSlotIndex] = hostSeat;
  let playerIndex = 0;
  for(let i=0;i<slots.length;i++){
    if(slots[i]) continue;
    slots[i] = state.players[playerIndex];
    playerIndex += 1;
  }
  slots.forEach((slot, i)=>{
    if(!slot) return;
    const ang=(Math.PI*2)*(i/totalSeats)-Math.PI/2;
    const r=40;
    const x=50+Math.cos(ang)*r;
    const y=50+Math.sin(ang)*r;
    if(slot.id === 'host'){
      const seat=el(`
        <div class="seat" style="left:${x}%; top:${y}%">
          <div class="imgwrap"><img src="${slot.img}" alt="사회자"></div>
          <div class="name">${slot.name}</div>
        </div>
      `);
      table.appendChild(seat);
      return;
    }
    const alive = slot.alive;
    const cardKey = state.winner ? (slot.role || slot.publicCard) : slot.publicCard;
    const img = !alive ? (DEAD_CARD[cardKey] || CARD[cardKey] || CARD.CITIZEN) : (CARD[cardKey] || CARD.CITIZEN);
    const seat=el(`
      <div class="seat ${slot.alive?'':'dead'}" style="left:${x}%; top:${y}%">
        <div class="imgwrap"><img src="${img}" alt="${cardKey}"></div>
        <div class="name">${slot.name}</div>
      </div>
    `);
    table.appendChild(seat);
  });
}

function openPickModal(cardIndex){
  const options = state.players.filter(p=>!p.assigned).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  const bd = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <h3>누구 차례?</h3>
        <p>본인 이름 선택</p>
        <label>플레이어</label>
        <select id="pSel">${options}</select>
        <div class="actions" style="margin-top:10px">
          <button id="cancel">취소</button>
          <button class="primary" id="ok">확인</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(bd);
  bd.querySelector('#cancel').onclick=()=>bd.remove();
  bd.querySelector('#ok').onclick=()=>{
    const pid = Number(bd.querySelector('#pSel').value);
    bd.remove();
    pushAction(roomCode, {type:'DEAL_PICK', cardIndex, playerId: pid}).catch(()=>{});
  };
}

async function showReveal(playerName, role){
  const overlay = el(`
    <div class="reveal">
      <div class="reveal-inner">
        <img src="${CARD[role] || CARD.BACK}" alt="${role}">
        <div class="who">${playerName} → <b>${ROLE_LABEL[role] || role}</b></div>
        <div class="muted small">5초 후 자동 닫힘</div>
      </div>
    </div>
  `);
  document.body.appendChild(overlay);
  await new Promise(r=>setTimeout(r, 5000));
  overlay.remove();
}

function playerNameFrom(stateRef, id){
  if(id==null) return '플레이어';
  const p = stateRef?.players?.find(x=>x.id===id);
  return p?.name || '플레이어';
}

function eventCaption(ev, stateRef){
  const type = ev?.type;
  if(type === 'MAFIA_KILL'){
    const name = playerNameFrom(stateRef, ev.victimId);
    return `${name}이(가) 살해 당하였습니다.`;
  }
  if(type === 'EXECUTION'){
    if(ev.terroristId != null){
      const terrorist = playerNameFrom(stateRef, ev.terroristId);
      const target = ev.executorName || playerNameFrom(stateRef, ev.executorId);
      return `테러리스트 ${terrorist}님이 ${target}님을 습격 하였습니다.`;
    }
    if(ev.executedId != null){
      const name = playerNameFrom(stateRef, ev.executedId);
      return `${name}이(가) 처형되었습니다.`;
    }
    return '';
  }
  if(type === 'TERROR_CHAIN'){
    const terrorist = playerNameFrom(stateRef, ev.terroristId);
    const target = playerNameFrom(stateRef, ev.targetId);
    return `테러리스트 ${terrorist}님이 ${target}님을  습격 하였습니다.`;
  }
  if(type === 'DOCTOR_SAVE'){
    const name = playerNameFrom(stateRef, ev.savedId);
    return `${name}님이 의사의 치료를 받고 살아났습니다.`;
  }
  if(type === 'REPORTER_NEWS'){
    const name = playerNameFrom(stateRef, ev.targetId);
    const roleName = ROLE_LABEL[ev.role] || ev.role || '';
    return `특종입니다! ${name}님이 ${roleName}(이)라는 소식 입니다!.`;
  }
  if(type === 'ARMY_SAVE'){
    const name = playerNameFrom(stateRef, ev.savedId);
    return `군인 ${name}님이 공격을 버텨냈습니다.`;
  }
  return '';
}

async function showEvent(ev){
  const type = ev?.type || 'MAFIA_KILL';
  const src = EVENT_IMG[type] || EVENT_IMG.MAFIA_KILL;
  const caption = eventCaption(ev, state);
  const overlay = el(`
    <div class="event-overlay">
      <img class="event-img" src="${src}" alt="${type}">
      <div class="event-caption">${caption}</div>
    </div>
  `);
  document.body.appendChild(overlay);
  await new Promise(r=>setTimeout(r, 8000));
  overlay.remove();
}

async function connectToRoom(code){
  roomCode = String(code||'').trim();
  if(!/^\d{4}$/.test(roomCode)){
    connected=false;
    alert('4자리 방 코드가 필요합니다.');
    render();
    return;
  }

  try{
    // 최초 상태 조회 (존재 확인)
    const st = await getState(roomCode);
    if(!st || !st.phase){
      connected=false;
      alert('해당 방을 찾을 수 없습니다. 방 코드가 맞는지 확인하세요.');
      render();
      return;
    }

  // hostHeartbeat는 '연결 뱃지'에만 사용하고, 최초 접속을 막지는 않는다.
  // (모바일/백그라운드/절전으로 heartbeat가 늦게 찍히는 경우가 많음)
  const hostOk = !!(st.hostHeartbeat && (Date.now()-st.hostHeartbeat < 60000));
connected=true;
    await patchState(roomCode, {clientHeartbeat: Date.now()});
    state = st;
    applyState(st);
    startTimers();
  }catch(e){
    connected=false;
    alert('접속 실패: ' + (e.message || String(e)));
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
    if(!st || !st.phase){
      connected=false;
      updateHudBadge();
      return;
    }
    // 연결 판정: hostHeartbeat가 최근 5초 이내면 연결 성공
    connected = !!(st.hostHeartbeat && (Date.now()-st.hostHeartbeat < 60000));
    state = st;
    await applyState(st);
  }catch{
    connected=false;
    // 화면은 유지하되 연결 뱃지만 꺼준다
    updateHudBadge();
  }
}

function updateHudBadge(){
  const badge = document.getElementById('connBadge');
  if(badge) badge.textContent = `연결 ${connected?'🟢':'🔴'}`;
}

function updateTimerBadge(){
  const badge = document.getElementById('timerBadge');
  if(!badge) return;
  const timer = state?.timer;
  let text = '';
  if(state?.winner){
    text = '';
  }else if(timer?.mode==='INFINITE'){
    text = '∞';
  }else if(timer?.mode==='COUNTDOWN'){
    text = formatTimer(getTimerRemaining(timer));
  }else{
    text = '--:--';
  }
  badge.textContent = text ? `타이머 ${text}` : '';
}

function updatePhaseCenter(){
  const titleEl = document.getElementById('phaseTitle');
  const subEl = document.getElementById('phaseSub');
  const bar = document.getElementById('timerBar');
  const fill = document.getElementById('timerBarFill');
  if(!titleEl || !subEl || !bar || !fill || !state) return;
  const timer = state.timer;
  const accused = state.executionTarget;
  const accusedName = accused!=null ? (state.players.find(p=>p.id===accused)?.name || '') : '';
  const winnerText = state.winner === 'MAFIA' ? '마피아 팀 승리' : (state.winner === 'CITIZEN' ? '시민 팀 승리' : '');

  let title = '';
  let sub = '';
  if(state.winner){
    title = winnerText;
  }else if(state.phase===PHASE.NIGHT){
    title = '밤이 되었습니다';
  }else if(state.phase===PHASE.DAY){
    title = '낮이 되었습니다';
  }else if(state.phase===PHASE.VOTE){
    title = '최후 변론';
    if(accusedName) sub = `${accusedName} 변론 중`;
  }else if(state.phase===PHASE.EXECUTION){
    title = '투표 시간 입니다';
    if(accusedName) sub = `${accusedName} 처리 여부`;
  }else if(state.phase===PHASE.DEAL){
    title = '카드 배정 중';
  }
  titleEl.textContent = title;
  subEl.textContent = sub;

  if(timer?.mode==='COUNTDOWN' && timer.durationSec){
    bar.style.display = 'block';
    const remaining = getTimerRemaining(timer);
    const pct = Math.max(0, Math.min(100, (remaining / timer.durationSec) * 100));
    fill.style.width = `${pct}%`;
  }else{
    bar.style.display = 'none';
  }
}

async function applyState(st){
  // deck
  if(st.deckInfo){
    deal.active = (st.phase===PHASE.DEAL);
    deal.deckCount = st.deckInfo.count;
    deal.used = st.deckInfo.used || Array.from({length:deal.deckCount}).map(()=>false);
  }else{
    deal.active=false;
  }

  render();
  updateHudBadge();
  updateTimerBadge();
  updatePhaseCenter();

  // eventQueue(이벤트/연출) 처리: token이 바뀔 때 1회 재생
  if(st.eventQueue && typeof st.eventQueue.token === 'number' && st.eventQueue.token !== lastEventToken){
    lastEventToken = st.eventQueue.token;
    const events = Array.isArray(st.eventQueue.events) ? st.eventQueue.events : [];
    eventPlayback = eventPlayback.then(async()=>{
      for(const ev of events){
        if(ev.type==='DEAL_REVEAL'){
          // 카드 사용 표시
          if(typeof ev.cardIndex==='number') deal.used[ev.cardIndex]=true;
          render();
          const p = st.players?.find(x=>x.id===ev.playerId);
          await showReveal(p?.name || 'PLAYER', ev.role);
        }else{
          await showEvent(ev);
        }
      }
    }).catch(()=>{});
  }
}
