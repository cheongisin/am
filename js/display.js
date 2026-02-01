import {el} from './util.js';
import {getState, patchState, pushAction} from './gasApi.js';
import {PHASE, CARD, DEAD_CARD, ROLE_LABEL, EVENT_IMG} from '../src/constants.js';

let wakeLock=null;
async function keepAwake(){ try{ wakeLock = await navigator.wakeLock.request('screen'); }catch{} }
document.addEventListener('click', keepAwake, {once:true});

const root = document.getElementById('display');

let connected = false;
let roomCode = '';
let state = null;

let pollTimer = null;
let beatTimer = null;
let timerTick = null;

let lastEventToken = 0;
let eventPlayback = Promise.resolve();

// DOM refs (부분 업데이트용)
let dom = {
  inited: false,
  hud: null,
  connBadge: null,
  roomBadge: null,
  winnerBadge: null,
  phaseTitle: null,
  phaseSub: null,
  timerBadge: null,
  timerBar: null,
  timerBarFill: null,
  table: null,
  dealWrap: null,
  dealGrid: null,
  dealHint: null,
};

let seats = {
  hostEl: null,
  playerEls: new Map(), // playerId -> element
};

let deal = { active:false, deckCount:0, used:[] };

// -------------------------
// Utils
// -------------------------
function formatTimer(seconds){
  const s = Math.max(0, Number(seconds)||0);
  const m = Math.floor(s/60);
  const r = s%60;
  return `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
}
function getTimerRemaining(timer){
  if(!timer || timer.mode!=='COUNTDOWN') return 0;
  if(timer.running && timer.endAt){
    return Math.max(0, Math.ceil((timer.endAt - Date.now())/1000));
  }
  return Math.max(0, Math.floor(timer.durationSec || 0));
}

function setConnected(flag){
  connected = !!flag;
  if(dom.connBadge) dom.connBadge.textContent = `연결 ${connected ? '🟢' : '🔴'}`;
}

function safeText(elm, text){
  if(!elm) return;
  elm.textContent = text ?? '';
}

function ensureSkeleton(){
  if(dom.inited) return;

  // 연결 전 화면 (state 없을 때)
  root.innerHTML = `
    <div class="app">
      <div class="card" id="joinCard">
        <h3>진행자 연결 (방코드)</h3>
        <p class="muted small">사회자가 만든 4자리 코드를 입력하면 연결됩니다. (기본은 연결 실패 🔴)</p>
        <label>방 코드</label>
        <input id="code" placeholder="예: 4831" value="">
        <div class="actions" style="margin-top:10px">
          <button class="primary" id="join">접속</button>
          <button id="retry">새로고침</button>
        </div>
        <div class="muted small" id="msg">상태: 연결 실패 🔴</div>
      </div>
    </div>
  `;

  const joinBtn = root.querySelector('#join');
  const retryBtn = root.querySelector('#retry');
  const codeInp = root.querySelector('#code');
  const msg = root.querySelector('#msg');

  joinBtn.onclick = async ()=>{
    const code = (codeInp.value||'').trim();
    try{
      await connectToRoom(code);
    }catch(e){
      msg.textContent = `오류: ${e?.message || String(e)}`;
    }
  };
  retryBtn.onclick = ()=> location.reload();

  dom.inited = true;
}

function ensureMainUI(){
  // state가 생기면 메인 UI로 전환(1회)
  if(dom.hud) return;

  root.innerHTML = `
    <div class="board">
      <div class="hud">
        <div class="actions">
          <span class="badge" id="roomBadge">방코드 -</span>
          <span class="badge" id="connBadge">연결 🔴</span>
          <span class="badge" id="winnerBadge" style="display:none"></span>
        </div>
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

      <div class="deal-wrap" id="dealWrap" style="display:none">
        <div class="card">
          <h3 style="margin:0 0 8px">카드 배정</h3>
          <p class="muted small" id="dealHint" style="margin:0 0 10px"></p>
          <div class="deal-grid" id="dealGrid"></div>
        </div>
      </div>
    </div>
  `;

  dom.hud = root.querySelector('.hud');
  dom.connBadge = root.querySelector('#connBadge');
  dom.roomBadge = root.querySelector('#roomBadge');
  dom.winnerBadge = root.querySelector('#winnerBadge');
  dom.phaseTitle = root.querySelector('#phaseTitle');
  dom.phaseSub = root.querySelector('#phaseSub');
  dom.timerBadge = root.querySelector('#timerBadge');
  dom.timerBar = root.querySelector('#timerBar');
  dom.timerBarFill = root.querySelector('#timerBarFill');
  dom.table = root.querySelector('#table');

  dom.dealWrap = root.querySelector('#dealWrap');
  dom.dealGrid = root.querySelector('#dealGrid');
  dom.dealHint = root.querySelector('#dealHint');

  // host seat 1회 생성
  buildHostSeat();
}

function buildHostSeat(){
  if(seats.hostEl || !dom.table) return;

  // “사회자 왼쪽 고정” 버전:
  // left: 6%, top: 50% 로 고정
  const hostEl = el(`
    <div class="seat" style="left:6%; top:50%">
      <div class="imgwrap"><img src="assets/pront.svg" alt="사회자"></div>
      <div class="name">사회자</div>
    </div>
  `);
  dom.table.appendChild(hostEl);
  seats.hostEl = hostEl;
}

function computeSeatPositions(n){
  // 좌석은 “도박 테이블(가로)” 기준으로 오른쪽에 8~12명 배치
  // host는 왼쪽 고정(6%, 50%), 플레이어는 오른쪽 영역에 타원 형태로 분산
  // 좌표는 % 기반: left 25~95 / top 10~90 정도
  const center = {x: 62, y: 50};
  const radius = {x: 33, y: 36};

  // 위쪽부터 아래쪽으로 부드럽게 배치(오른쪽 반원 느낌)
  // angle: -70deg ~ +70deg
  const start = (-70 * Math.PI) / 180;
  const end   = ( 70 * Math.PI) / 180;
  const span = end - start;
  const step = n > 1 ? span / (n - 1) : 0;

  const pos = [];
  for(let i=0;i<n;i++){
    const ang = start + step*i;
    const x = center.x + Math.cos(ang) * radius.x;
    const y = center.y + Math.sin(ang) * radius.y;
    pos.push({x, y});
  }
  return pos;
}

function ensurePlayerSeats(){
  if(!state?.players || !dom.table) return;

  const players = state.players;
  const positions = computeSeatPositions(players.length);

  players.forEach((p, idx)=>{
    let node = seats.playerEls.get(p.id);
    if(!node){
      node = el(`
        <div class="seat" style="left:0%; top:0%">
          <div class="imgwrap"><img src="${CARD.CITIZEN}" alt="card"></div>
          <div class="name"></div>
        </div>
      `);
      dom.table.appendChild(node);
      seats.playerEls.set(p.id, node);
    }
    // 위치 업데이트
    node.style.left = `${positions[idx].x}%`;
    node.style.top  = `${positions[idx].y}%`;
  });

  // 인원이 줄어든 경우(세팅 변경) 기존 좌석 정리
  const validIds = new Set(players.map(p=>p.id));
  for(const [pid, node] of seats.playerEls.entries()){
    if(!validIds.has(pid)){
      node.remove();
      seats.playerEls.delete(pid);
    }
  }
}

function updateSeats(){
  if(!state?.players) return;
  ensurePlayerSeats();

  state.players.forEach((p)=>{
    const node = seats.playerEls.get(p.id);
    if(!node) return;

    const alive = !!p.alive;
    const cardKey = state.winner ? (p.role || p.publicCard) : p.publicCard;
    const img = !alive
      ? (DEAD_CARD?.[cardKey] || CARD?.[cardKey] || CARD.CITIZEN)
      : (CARD?.[cardKey] || CARD.CITIZEN);

    node.classList.toggle('dead', !alive);

    const imgEl = node.querySelector('img');
    const nameEl = node.querySelector('.name');

    if(imgEl && imgEl.getAttribute('src') !== img){
      imgEl.setAttribute('src', img);
      imgEl.setAttribute('alt', String(cardKey||'CARD'));
    }
    if(nameEl) nameEl.textContent = p.name || '';
  });
}

function updateHud(){
  if(!dom.roomBadge) return;
  dom.roomBadge.innerHTML = `방코드 <b>${roomCode || '-'}</b>`;

  if(state?.winner){
    dom.winnerBadge.style.display = '';
    const t = state.winner === 'MAFIA' ? '마피아 승리' : (state.winner === 'CITIZEN' ? '시민 승리' : String(state.winner));
    dom.winnerBadge.textContent = `승리: ${t}`;
  }else{
    dom.winnerBadge.style.display = 'none';
    dom.winnerBadge.textContent = '';
  }
}

function updatePhaseCenter(){
  if(!state) return;
  const timer = state.timer;
  const accused = state.executionTarget;
  const accusedName = accused!=null ? (state.players.find(p=>p.id===accused)?.name || '') : '';

  let title = '';
  let sub = '';

  if(state.winner){
    title = state.winner === 'MAFIA' ? '마피아 팀 승리' : (state.winner === 'CITIZEN' ? '시민 팀 승리' : '');
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
  }else{
    title = '게임 준비 중';
  }

  safeText(dom.phaseTitle, title);
  safeText(dom.phaseSub, sub);

  // timer badge / bar
  let text = '';
  if(state.winner){
    text = '';
  }else if(timer?.mode==='INFINITE'){
    text = '∞';
  }else if(timer?.mode==='COUNTDOWN'){
    text = formatTimer(getTimerRemaining(timer));
  }else{
    text = '--:--';
  }
  safeText(dom.timerBadge, text ? `타이머 ${text}` : '');

  if(timer?.mode==='COUNTDOWN' && timer.durationSec){
    dom.timerBar.style.display = 'block';
    const remaining = getTimerRemaining(timer);
    const pct = Math.max(0, Math.min(100, Math.round((remaining / timer.durationSec) * 100)));
    dom.timerBarFill.style.width = `${pct}%`;
  }else{
    dom.timerBar.style.display = 'none';
    dom.timerBarFill.style.width = '0%';
  }
}

function updateDealUI(){
  if(!dom.dealWrap || !dom.dealGrid) return;

  const active = (state?.phase === PHASE.DEAL) && deal.active;
  dom.dealWrap.style.display = active ? '' : 'none';
  if(!active) return;

  // 안내
  const left = (deal.used || []).filter(x=>!x).length;
  dom.dealHint.textContent = `남은 카드: ${left}/${deal.deckCount} · 카드를 눌러 직업을 선택하고, 플레이어를 지정해 배정하세요.`;

  // grid 구성(부분 업데이트: 간단하게 재생성)
  dom.dealGrid.innerHTML = '';
  for(let i=0;i<deal.deckCount;i++){
    const used = !!deal.used[i];
    const btn = el(`
      <button class="deal-card ${used?'used':''}" data-idx="${i}" ${used?'disabled':''}>
        <div class="deal-num">${i+1}</div>
        <div class="deal-state">${used?'사용됨':'선택'}</div>
      </button>
    `);
    btn.onclick = ()=>{
      if(used) return;
      openPickModal(i);
    };
    dom.dealGrid.appendChild(btn);
  }
}

function openPickModal(cardIndex){
  // 모달은 DOM을 갈아엎지 않으므로 클릭 스킵 없음
  const options = state.players.filter(p=>!p.assigned).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
  const bd = el(`
    <div class="modal-backdrop">
      <div class="modal">
        <h3 style="margin:0 0 10px">카드 #${cardIndex+1} 배정</h3>
        <label>플레이어 선택</label>
        <select id="pickPlayer">${options}</select>
        <div class="actions" style="margin-top:12px; justify-content:flex-end">
          <button id="cancel">취소</button>
          <button class="primary" id="ok">직업을 뽑아 배정하기</button>
        </div>
      </div>
    </div>
  `);
  root.appendChild(bd);

  bd.querySelector('#cancel').onclick = ()=> bd.remove();
  bd.querySelector('#ok').onclick = async ()=>{
    const pid = Number(bd.querySelector('#pickPlayer').value);
    try{
      // 액션 전송
      await pushAction(roomCode, {msg:{type:'DEAL_PICK', cardIndex, playerId: pid}});
      // UI 즉시 반영(optimistic)
      deal.used[cardIndex] = true;
      bd.remove();
      updateDealUI();
    }catch(e){
      alert(e?.message || String(e));
    }
  };
}

async function showOverlayImage(src, durationMs=8000){
  const ov = el(`
    <div class="event-overlay">
      <img src="${src}" alt="event">
    </div>
  `);
  root.appendChild(ov);
  await new Promise(res=>setTimeout(res, durationMs));
  ov.remove();
}

async function showEvent(ev){
  // EVENT_IMG 매핑이 프로젝트에 이미 있다고 가정
  // 예: {type:'DOCTOR_SAVE'} -> EVENT_IMG.DOCTOR_SAVE
  const key = ev?.type;
  const img = EVENT_IMG?.[key];
  if(img) await showOverlayImage(img, 8000);
}

async function showReveal(playerName, roleKey){
  // 카드 공개 연출: 직업 카드 이미지를 8초 표시
  const img = CARD?.[roleKey] || CARD.CITIZEN;
  await showOverlayImage(img, 8000);
}

// -------------------------
// Connect / Poll
// -------------------------
async function connectToRoom(code){
  roomCode = String(code||'').trim();
  if(!/^\d{4}$/.test(roomCode)) throw new Error('4자리 방 코드를 입력하세요.');

  // 첫 state 확인
  const st = await getState(roomCode);
  if(!st || !st.phase){
    setConnected(false);
    throw new Error('해당 방을 찾을 수 없습니다. 방 코드가 맞는지 확인하세요.');
  }

  // 메인 UI 전환
  state = st;
  ensureMainUI();
  setConnected(true);
  updateFromState(st, {force:true});

  // heartbeat
  if(beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(()=>{
    if(roomCode) patchState(roomCode, {clientHeartbeat: Date.now()}).catch(()=>{});
  }, 2000);

  // poll
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, 500);

  // timer tick (표시만)
  if(timerTick) clearInterval(timerTick);
  timerTick = setInterval(()=>{
    updatePhaseCenter();
  }, 500);
}

async function pollOnce(){
  if(!roomCode) return;
  try{
    const st = await getState(roomCode);

    if(!st || !st.phase){
      setConnected(false);
      return;
    }

    // 연결 판정: hostHeartbeat가 최근 60초 이내면 연결 성공
    const ok = !!(st.hostHeartbeat && (Date.now()-st.hostHeartbeat < 60000));
    setConnected(ok);

    updateFromState(st);
  }catch(e){
    // 화면은 유지 + 뱃지만 빨강
    setConnected(false);
  }
}

function updateFromState(st, {force=false} = {}){
  // deckInfo
  if(st.deckInfo){
    deal.active = (st.phase===PHASE.DEAL);
    deal.deckCount = st.deckInfo.count;
    deal.used = st.deckInfo.used || Array.from({length:deal.deckCount}).map(()=>false);
  }else{
    deal.active = false;
    deal.deckCount = 0;
    deal.used = [];
  }

  // state swap
  state = st;

  // UI update (부분 업데이트만)
  updateHud();
  updateSeats();
  updatePhaseCenter();
  updateDealUI();

  // eventQueue 재생(토큰 바뀔 때만 1회)
  if(st.eventQueue && typeof st.eventQueue.token === 'number' && st.eventQueue.token !== lastEventToken){
    lastEventToken = st.eventQueue.token;
    const events = Array.isArray(st.eventQueue.events) ? st.eventQueue.events : [];
    eventPlayback = eventPlayback.then(async ()=>{
      for(const ev of events){
        if(ev.type==='DEAL_REVEAL'){
          if(typeof ev.cardIndex==='number') deal.used[ev.cardIndex] = true;
          updateDealUI();
          const p = st.players?.find(x=>x.id===ev.playerId);
          await showReveal(p?.name || 'PLAYER', ev.role);
        }else{
          await showEvent(ev);
        }
      }
    }).catch(()=>{});
  }
}

// -------------------------
// Boot
// -------------------------
(function boot(){
  ensureSkeleton();

  // preview mode 지원(프로젝트에 있던 기능 유지)
  const previewState = typeof window !== 'undefined' ? window.__AM_PREVIEW_STATE__ : null;
  if(previewState){
    roomCode = 'PREVIEW';
    ensureMainUI();
    setConnected(true);
    updateFromState(previewState, {force:true});
  }
})();
