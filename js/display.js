import {el} from './util.js';
import {getState, patchState, pushAction} from './gasApi.js';
import {PHASE, CARD, EVENT_IMG, ROLE_LABEL} from '../src/constants.js';

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
let lastFxToken=0;

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

  if(state.phase===PHASE.VOTE){
    const alive = state.players.filter(p=>p.alive);
    root.innerHTML = `
      <div class="app">
        <div class="card">
          <h3>투표</h3>
          <p class="muted small">투표자 → 대상 (기권 가능)</p>
        </div>
        <div class="grid cols2" style="margin-top:12px">
          <div class="card">
            <h3>투표자</h3>
            <div class="voteGrid" id="voters"></div>
          </div>
          <div class="card">
            <h3>대상</h3>
            <div class="voteGrid" id="targets"></div>
            <p class="muted small">투표자를 먼저 선택</p>
          </div>
        </div>
      </div>
    `;
    const voters=root.querySelector('#voters');
    const targets=root.querySelector('#targets');
    let current=null;
    alive.forEach(v=>{
      const b=el(`<div class="pill">${v.name}</div>`);
      b.onclick=()=>{
        current=v.id;
        targets.innerHTML='';
        const abst=el(`<div class="pill">기권</div>`);
        abst.onclick=()=>pushAction(roomCode, {type:'VOTE', voterId: current, targetId: null}).catch(()=>{});
        targets.appendChild(abst);
        alive.filter(t=>t.id!==v.id).forEach(t=>{
          const tb=el(`<div class="pill">${t.name}</div>`);
          tb.onclick=()=>pushAction(roomCode, {type:'VOTE', voterId: current, targetId: t.id}).catch(()=>{});
          targets.appendChild(tb);
        });
      };
      voters.appendChild(b);
    });
    return;
  }

  // Table view
  root.innerHTML = `
    <div class="board">
      <div class="hud">
        <span class="badge night">${state.phase} ${state.phase===PHASE.NIGHT?`N${state.night}`:''}</span>
        <span class="badge">생존 ${state.players.filter(p=>p.alive).length}/${state.players.length}</span>
        <span class="badge" id="connBadge">연결 ${connected?'🟢':'🔴'}</span>
        ${state.winner? `<span class="badge">승리: ${state.winner}</span>`:''}
      </div>
      <div class="table" id="table"></div>
      <p class="muted small">이벤트 연출은 자동</p>
    </div>
  `;
  const table=root.querySelector('#table');
  const n=state.players.length;
  state.players.forEach((p,i)=>{
    const ang=(Math.PI*2)*(i/n)-Math.PI/2;
    const r=40;
    const x=50+Math.cos(ang)*r;
    const y=50+Math.sin(ang)*r;
    const img = CARD[p.publicCard] || CARD.CITIZEN;
    const seat=el(`
      <div class="seat ${p.alive?'':'dead'}" style="left:${x}%; top:${y}%">
        <div class="imgwrap"><img src="${img}" alt="${p.publicCard}"></div>
        <div class="name">${p.name}</div>
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

async function showEvent(type){
  const src = EVENT_IMG[type] || EVENT_IMG.MAFIA_KILL;
  const overlay = el(`
    <div class="event-overlay">
      <img class="event-img" src="${src}" alt="${type}">
      <div class="event-caption">8초</div>
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
  pollTimer = setInterval(pollOnce, 800);
  if(beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(()=>{
    if(roomCode) patchState(roomCode, {clientHeartbeat: Date.now()}).catch(()=>{});
  }, 2000);
}

async function pollOnce(){
  if(!roomCode) return;
  try{
    const st = await getState(roomCode);
    if(!st || !st.phase){
      connected=false;
      state=null;
      render();
      return;
    }
    // 연결 판정: hostHeartbeat가 최근 6.5초 이내면 연결 성공
    connected = !!(st.hostHeartbeat && (Date.now()-st.hostHeartbeat < 6500));
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

  // fx(이벤트/연출) 처리: token이 바뀔 때 1회 재생
  if(st.fx && typeof st.fx.token === 'number' && st.fx.token !== lastFxToken){
    lastFxToken = st.fx.token;
    const events = Array.isArray(st.fx.events) ? st.fx.events : [];
    for(const ev of events){
      if(ev.type==='DEAL_REVEAL'){
        // 카드 사용 표시
        if(typeof ev.cardIndex==='number') deal.used[ev.cardIndex]=true;
        render();
        const p = st.players?.find(x=>x.id===ev.playerId);
        await showReveal(p?.name || 'PLAYER', ev.role);
      }else{
        await showEvent(ev.type);
      }
    }
  }
}
