import {getState, patchState, pushAction} from './gasApi.js';
import {PHASE, ROLE_LABEL} from '../src/constants.js';

const app = document.getElementById('app');

let connected=false;
let roomCode='';
let pollTimer=null;
let beatTimer=null;
let timerTick=null;

let state=null;

let deal = {
  active:false,
  deckCount:0,
  used:[]
};

let lastEventToken=0;
let lastRenderSig='';

function makeRenderSig(st){
  if(!st) return 'null';
  const t = st.timer || {};
  const timerSig = [t.mode||'', t.durationSec||0, t.endAt||0, t.running?1:0].join(':');
  const tc = st.timerConfig || {};
  const tcSig = [tc.daySec||0].join(':');
  const players = Array.isArray(st.players) ? st.players.map(p=>[
    p.id,
    p.alive?1:0,
    p.assigned?1:0,
    p.publicCard||'',
    p.terroristTarget==null?'':p.terroristTarget
  ].join('.')).join('|') : '';
  const deck = st.deckInfo ? [
    st.deckInfo.count||0,
    Array.isArray(st.deckInfo.used) ? st.deckInfo.used.map(v=>v?1:0).join('') : ''
  ].join(':') : 'no';
  const evTok = st.eventQueue && typeof st.eventQueue.token==='number' ? st.eventQueue.token : 0;
  const accused = st.executionTarget==null?'':st.executionTarget;
  const jr = Array.isArray(st.journalistReveals) ? st.journalistReveals.join(',') : '';
  return [
    st.phase||'',
    st.night||0,
    st.winner||'',
    accused,
    timerSig,
    tcSig,
    deck,
    evTok,
    jr,
    players
  ].join('||');
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

function render(){
  const st = state;

  if(!st){
    app.innerHTML = `
      <div class="topbar"><div class="topbar-inner">
        <div class="actions">
          <span class="badge" id="connBadge">연결 🔴</span>
        </div>
      </div></div>

      <div class="app">
        <div class="card">
          <h3>진행자(배정/표시) 연결</h3>
          <div class="grid cols2">
            <div>
              <label>방 코드</label>
              <input id="roomCode" placeholder="예: 4831" value="${roomCode}">
            </div>
            <div>
              <label>&nbsp;</label>
              <div class="actions">
                <button class="primary" id="connectBtn">접속</button>
              </div>
            </div>
          </div>
          <p class="muted small">사회자(host)가 만든 4자리 코드를 입력하고 접속합니다.</p>
        </div>
      </div>
    `;
    const btn = document.getElementById('connectBtn');
    if(btn){
      btn.onclick = connectRoom;
    }
    updateHudBadge();
    return;
  }

  const aliveCount = st.players?.filter(p=>p.alive).length ?? 0;
  const totalCount = st.players?.length ?? 0;

  const timer = st.timer;
  const remaining = getTimerRemaining(timer);
  const timerText = timer?.mode==='INFINITE' ? '∞' : (timer?.mode==='COUNTDOWN' ? formatTimer(remaining) : '--:--');

  app.innerHTML = `
    <div class="topbar"><div class="topbar-inner">
      <div class="actions">
        <span class="badge night">${st.phase} ${st.phase===PHASE.NIGHT?`N${st.night}`:''}</span>
        <span class="badge" id="timerBadge">타이머 ${timerText}</span>
        <span class="badge">생존 ${aliveCount}/${totalCount}</span>
        <span class="badge" id="connBadge">연결 ${connected?'🟢':'🔴'}</span>
        <span class="badge">방코드 ${roomCode? `<b>${roomCode}</b>` : '-'}</span>
        ${st.winner? `<span class="badge">승리: ${st.winner}</span>`:''}
      </div>
    </div></div>

    <div class="app">
      <div class="card">
        <div id="phaseCenter" class="phaseCenter"></div>
        <div class="timerBar" id="timerBar" style="display:none">
          <div class="timerFill" id="timerFill"></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:12px">
        <div class="card">
          <h3>플레이어</h3>
          <div id="playerList"></div>
        </div>
        <div class="card">
          <h3>배정</h3>
          <div id="dealPanel"></div>
        </div>
      </div>
    </div>
  `;

  // player list
  const listEl = document.getElementById('playerList');
  if(listEl){
    listEl.innerHTML = (st.players||[]).map(p=>{
      const status = p.alive ? '' : '<span class="muted"> (사망)</span>';
      const pub = (p.publicCard && p.publicCard!=='CITIZEN') ? ` / 공개:${ROLE_LABEL[p.publicCard]||p.publicCard}` : '';
      return `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
          <div>${p.name}${status}</div>
          <div class="muted small">${p.assigned?'배정됨':'미배정'}${pub}</div>
        </div>
      `;
    }).join('');
  }

  // deal panel
  const dealEl = document.getElementById('dealPanel');
  if(dealEl){
    if(st.phase!==PHASE.DEAL){
      dealEl.innerHTML = `<p class="muted">배정 단계가 아닙니다.</p>`;
    }else{
      const options = (st.players||[]).filter(p=>!p.assigned).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
      dealEl.innerHTML = `
        <p class="muted small">카드를 선택하고, 배정할 플레이어를 선택한 뒤 “배정”을 누르세요.</p>
        <div class="grid cols2">
          <div>
            <label>플레이어</label>
            <select id="dealPlayerSel">${options}</select>
          </div>
          <div>
            <label>카드</label>
            <select id="dealCardSel"></select>
          </div>
        </div>
        <div class="actions" style="margin-top:10px">
          <button class="primary" id="dealPickBtn" ${connected?'':'disabled'}>직업을 뽑아 배정하기</button>
        </div>
        <p class="muted small">연결이 흔들려도 입력이 씹히지 않도록 렌더링을 최소화했습니다.</p>
      `;

      // cards
      const cardSel = document.getElementById('dealCardSel');
      if(cardSel){
        cardSel.innerHTML = '';
        for(let i=0;i<deal.deckCount;i++){
          const used = deal.used[i];
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = used ? `카드 ${i+1} (사용됨)` : `카드 ${i+1}`;
          opt.disabled = !!used;
          cardSel.appendChild(opt);
        }
      }

      const btn = document.getElementById('dealPickBtn');
      if(btn){
        // 모바일에서 click이 DOM 교체로 씹히는 문제를 피하려고 pointerup 사용
        btn.onpointerup = async ()=>{
          const ps = document.getElementById('dealPlayerSel');
          const cs = document.getElementById('dealCardSel');
          const playerId = ps ? Number(ps.value) : null;
          const cardIndex = cs ? Number(cs.value) : null;
          if(playerId==null || Number.isNaN(playerId)) return alert('플레이어를 선택하세요.');
          if(cardIndex==null || Number.isNaN(cardIndex)) return alert('카드를 선택하세요.');
          if(deal.used[cardIndex]) return alert('이미 사용된 카드입니다.');

          try{
            await pushAction(roomCode, {type:'DEAL_PICK', playerId, cardIndex});
            // 낙관적 반영: 즉시 사용 처리(중복 클릭 방지)
            deal.used[cardIndex]=true;
            // render는 시그니처 변화 없으면 큰 폭으로 안 돌지만, 배정 UI는 즉시 갱신
            render();
            updateHudBadge();
            updateTimerBadge();
            updatePhaseCenter();
          }catch(e){
            alert('배정 전송 실패: ' + (e.message || String(e)));
          }
        };
      }
    }
  }

  updateHudBadge();
  updateTimerBadge();
  updatePhaseCenter();
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
    const remaining = getTimerRemaining(timer);
    text = formatTimer(remaining);
  }else{
    text = '--:--';
  }
  badge.textContent = `타이머 ${text}`;

  const bar = document.getElementById('timerBar');
  const fill = document.getElementById('timerFill');
  if(!bar || !fill) return;

  if(timer?.mode==='COUNTDOWN' && timer.durationSec){
    bar.style.display = 'block';
    const remaining = getTimerRemaining(timer);
    const pct = Math.max(0, Math.min(100, (remaining / timer.durationSec) * 100));
    fill.style.width = `${pct}%`;
  }else{
    bar.style.display = 'none';
  }
}

function updatePhaseCenter(){
  const el = document.getElementById('phaseCenter');
  if(!el) return;
  const st = state;
  if(!st){
    el.textContent = '';
    return;
  }
  if(st.winner){
    el.innerHTML = `<div class="big">${st.winner} 승리</div>`;
    return;
  }
  if(st.phase===PHASE.SETUP){
    el.innerHTML = `<div class="big">게임 진행 준비 중</div><div class="muted">사회자 화면에서 배정을 시작하세요</div>`;
    return;
  }
  if(st.phase===PHASE.DEAL){
    const assigned = (st.players||[]).filter(p=>p.assigned).length;
    el.innerHTML = `<div class="big">배정 중</div><div class="muted">${assigned}/${(st.players||[]).length}</div>`;
    return;
  }
  if(st.phase===PHASE.NIGHT){
    el.innerHTML = `<div class="big">밤</div><div class="muted">사회자가 밤 행동을 종합 중</div>`;
    return;
  }
  if(st.phase===PHASE.DAY){
    el.innerHTML = `<div class="big">낮</div><div class="muted">토론</div>`;
    return;
  }
  if(st.phase===PHASE.VOTE){
    el.innerHTML = `<div class="big">투표</div><div class="muted">최후 변론 대상 선택/투표</div>`;
    return;
  }
  if(st.phase===PHASE.EXECUTION){
    const accused = st.executionTarget;
    const accusedName = accused!=null ? (st.players.find(p=>p.id===accused)?.name || '') : '';
    el.innerHTML = `<div class="big">처형</div><div class="muted">${accusedName ? accusedName+' 대상' : '무효 가능'}</div>`;
    return;
  }
  el.textContent = st.phase;
}

async function applyState(st){
  // 연결 뱃지/타이머는 항상 갱신 (heartbeat 변화로 렌더가 흔들리지 않게)
  updateHudBadge();
  updateTimerBadge();

  // render는 "게임 화면에 영향을 주는 값"이 바뀔 때만 수행
  const sig = makeRenderSig(st);
  const needRender = (sig !== lastRenderSig);

  // deck 캐시(배정 화면에서 카드 X표 표시용)
  if(st && st.deckInfo){
    deal.active = (st.phase===PHASE.DEAL);
    deal.deckCount = st.deckInfo.count || 0;
    deal.used = st.deckInfo.used || Array.from({length:deal.deckCount}).map(()=>false);
  }else{
    deal.active=false;
  }

  // state 갱신
  state = st;

  if(needRender){
    lastRenderSig = sig;
    render();
    updatePhaseCenter();
  }else{
    // 중앙 문구/바만 가볍게 갱신
    updatePhaseCenter();
  }

  // eventQueue(이벤트/연출) 처리: token이 바뀔 때 1회 재생
  // (eventQueue.token은 sig에 포함되어 있어 token이 바뀌면 needRender=true가 됨)
  if(st.eventQueue && typeof st.eventQueue.token === 'number' && st.eventQueue.token !== lastEventToken){
    lastEventToken = st.eventQueue.token;
    // 이벤트로 카드 사용 처리(이중 안전장치)
    const evs = st.eventQueue.events || [];
    for(const ev of evs){
      if(ev.type==='DEAL_REVEAL'){
        if(typeof ev.cardIndex==='number') deal.used[ev.cardIndex]=true;
      }
    }
  }
}

async function connectRoom(){
  const inp = document.getElementById('roomCode');
  roomCode = String(inp?.value || roomCode || '').trim();

  if(!/^\d{4}$/.test(roomCode)){
    connected=false;
    alert('4자리 방 코드가 필요합니다.');
    render();
    return;
  }

  try{
    const st = await getState(roomCode);
    if(!st || !st.phase){
      connected=false;
      alert('해당 방을 찾을 수 없습니다. 방 코드가 맞는지 확인하세요.');
      render();
      return;
    }
    if(!st.hostHeartbeat || (Date.now()-st.hostHeartbeat > 5000)){
      connected=false;
      alert('사회자 연결이 감지되지 않습니다. 잠시 후 다시 시도하세요.');
      render();
      return;
    }
    connected=true;
    await patchState(roomCode, {clientHeartbeat: Date.now()});
    state = st;
    await applyState(st);
    startTimers();
  }catch(e){
    connected=false;
    alert('접속 실패: ' + (e.message || String(e)));
    render();
  }
}

function startTimers(){
  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, 1000);

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
      state=null;
      render();
      return;
    }
    connected = !!(st.hostHeartbeat && (Date.now()-st.hostHeartbeat < 5000));
    await applyState(st);
  }catch{
    connected=false;
    // 화면은 유지하되 뱃지만 끈다
    updateHudBadge();
  }
}

// 초기 렌더
render();
