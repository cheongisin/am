import {modalConfirm} from './util.js';
import {genRoomCode, getState, setState, patchState, pullActions, clearActions} from './gasApi.js';
import {PHASE, ROLE, ROLE_LABEL} from '../src/constants.js';
import {createGame, publicState, snapshot, undo} from '../src/gameState.js';
import {journalistReveal} from '../src/journalist.js';
import {tallyVotes, clearVotes} from '../src/vote.js';
import {execute} from '../src/execution.js';
import {checkWin} from '../src/win.js';
import {resolveNight} from './nightResolve.js';

let wakeLock=null;
async function keepAwake(){ try{ wakeLock = await navigator.wakeLock.request('screen'); }catch{} }
document.addEventListener('click', keepAwake, {once:true});

const app=document.getElementById('app');
let connected=false;
let roomCode='';
let hostBeatTimer=null;
let actionPollTimer=null;
let lastActionId=null;
let pendingReporterReveal=null;

let game = createGame(Array.from({length:8}).map((_,i)=>({id:i,name:`P${i+1}`})));
let nightDraft=null;

function shuffle(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function rolePoolFor(n){
  const pool=[ROLE.MAFIA, ROLE.POLICE, ROLE.DOCTOR, ROLE.REPORTER, ROLE.DETECTIVE, ROLE.TERRORIST, ROLE.SPY];
  while(pool.length<n) pool.push(ROLE.CITIZEN);
  return pool.slice(0,n);
}
function initNightDraft(){
  const find=(r)=>game.players.find(p=>p.role===r && p.alive)?.id ?? null;
  nightDraft = {
    mafiaId: find(ROLE.MAFIA), mafiaTarget: null,
    doctorId: find(ROLE.DOCTOR), doctorTarget: null,
    policeId: find(ROLE.POLICE), policeTarget: null,
    reporterId: find(ROLE.REPORTER), reporterUsed: false, reporterTarget: null,
    terroristId: find(ROLE.TERRORIST), terroristTarget: null
  };
}
async function sync(){
  if(!roomCode) return;
  const state = {
    roomCode,
    hostHeartbeat: Date.now(),
    ...publicState(game),
  };
  await setState(roomCode, state);
}

async function heartbeat(){
  if(!roomCode) return;
  try{
    await patchState(roomCode, {hostHeartbeat: Date.now()});
  }catch{}
}

function setConnected(flag){
  connected = !!flag;
}

async function startRoom(code){
  roomCode = String(code||'').trim();
  if(!/^\d{4}$/.test(roomCode)) throw new Error('4자리 코드가 필요합니다.');

  // 상태가 없으면 새로 생성(호스트 기준)
  let st=null;
  try{ st = await getState(roomCode); }catch{}
  if(!st || !st.phase){
    await sync();
  }

  // 폴링 시작
  if(hostBeatTimer) clearInterval(hostBeatTimer);
  hostBeatTimer = setInterval(heartbeat, 2000);

  if(actionPollTimer) clearInterval(actionPollTimer);
  actionPollTimer = setInterval(pollActions, 500);

  render();
}

async function pollActions(){
  if(!roomCode) return;
  try{
    const res = await pullActions(roomCode);
    const actions = (res && res.actions) ? res.actions : [];
    if(!actions.length) {
      // 연결 판정: 진행자 heartbeat가 최근 6초 이내면 connected
      const st = await getState(roomCode);
      const ok = st?.clientHeartbeat && (Date.now()-st.clientHeartbeat < 6500);
      setConnected(!!ok);
      renderBadgeOnly();
      return;
    }

    // 순서대로 처리
    for(const a of actions){
      if(lastActionId!=null && a.id<=lastActionId) continue;
      lastActionId = a.id;
      await onAction(a);
    }
    await clearActions(roomCode, lastActionId);

    // 처리 후 상태 동기화
    await sync();
    render();
  }catch(e){
    // 폴링 에러면 연결 끊김으로 표시만
    setConnected(false);
    renderBadgeOnly();
  }
}

function renderBadgeOnly(){
  const b = document.getElementById('connBadge');
  if(b) b.textContent = `연결 ${connected?'🟢':'🔴'}`;
}

function render(){
  const aliveCount = game.players.filter(p=>p.alive).length;
  app.innerHTML = `
  <div class="topbar"><div class="topbar-inner">
    <div class="actions">
      <span class="badge night">${game.phase} ${game.phase===PHASE.NIGHT?`N${game.night}`:''}</span>
      <span class="badge">생존 ${aliveCount}/${game.players.length}</span>
      <span class="badge" id="connBadge">연결 ${connected?'🟢':'🔴'}</span>
      <span class="badge">방코드 ${roomCode? `<b>${roomCode}</b>` : '-'}</span>
      ${game.winner? `<span class="badge">승리: ${game.winner}</span>`:''}
    </div>
    <div class="actions">
      <button id="undoBtn" ${game.history.length?'':'disabled'}>되돌리기</button>
    </div>
  </div></div>

  <div class="app">
    <div class="grid cols2">
      <div class="card">
        <h3>방 연결 (GAS)</h3>
        <p class="muted small">WebRTC 없이 동작합니다. 사회자가 4자리 코드를 만들고, 진행자는 그 코드로 접속합니다.</p>
        <div class="grid cols2">
          <div>
            <label>방 코드</label>
            <input id="roomCode" placeholder="예: 4831" value="${roomCode}">
          </div>
          <div>
            <label>&nbsp;</label>
            <div class="actions">
              <button class="primary" id="mkRoom">방 생성</button>
              <button id="startRoomBtn">연결 시작</button>
            </div>
          </div>
        </div>
        <p class="muted small">기본 상태는 연결 실패(🔴)이며, 진행자가 접속하면 자동으로 연결 성공(🟢)으로 바뀝니다.</p>
      </div>
      <div class="card">
        <h3>게임 세팅</h3>
        <div class="grid cols2">
          <div><label>인원(8~12)</label><input id="count" type="number" min="8" max="12" value="${game.players.length}"></div>
          <div><label>Phase</label>
            <select id="phaseSel">
              ${Object.values(PHASE).map(p=>`<option value="${p}" ${game.phase===p?'selected':''}>${p}</option>`).join('')}
            </select>
          </div>
        </div>
        <label>플레이어 이름</label>
        <div id="names" class="grid cols2"></div>
        <div class="actions" style="margin-top:10px">
          <button id="applyBtn">적용</button>
          <button class="primary" id="dealStartBtn" ${connected && !game.winner ? '' : 'disabled'}>배정 시작</button>
          <button class="danger" id="forceEndBtn">강제 종료</button>
        </div>
      </div>
    </div>

    <div class="grid cols2" style="margin-top:12px">
      <div class="card">
        <h3>배정/공개 현황</h3>
        <div id="assignList"></div>
      </div>
      <div class="card">
        <h3>컨트롤</h3>
        <div id="controlPanel"></div>
      </div>
    </div>
  </div>`;

  app.querySelector('#undoBtn').onclick=()=>{
    const ok=undo(game);
    if(ok){
      if(game.phase===PHASE.NIGHT) initNightDraft();
      pendingReporterReveal=null;
      sync(); render();
    }
  };

  // room
  app.querySelector('#mkRoom').onclick=async()=>{
    const code = genRoomCode();
    app.querySelector('#roomCode').value = code;
    await startRoom(code);
  };
  app.querySelector('#startRoomBtn').onclick=async()=>{
    const code = app.querySelector('#roomCode').value;
    try{ await startRoom(code); }
    catch(e){ alert(e.message || String(e)); }
  };

  // names
  const namesWrap=app.querySelector('#names');
  namesWrap.innerHTML='';
  game.players.forEach(p=>{
    const inp=document.createElement('input');
    inp.dataset.i=p.id;
    inp.value=p.name;
    namesWrap.appendChild(inp);
  });

  app.querySelector('#applyBtn').onclick=async()=>{
    const n = Math.max(8, Math.min(12, parseInt(app.querySelector('#count').value||'8',10)));
    const ok = await modalConfirm('세팅 적용','인원/이름을 적용할까요? (배정은 초기화)');
    if(!ok) return;
    snapshot(game);
    const newPlayers = Array.from({length:n}).map((_,i)=>{
      const inp = app.querySelector(`input[data-i="${i}"]`);
      const name = inp ? (inp.value.trim()||`P${i+1}`) : `P${i+1}`;
      return {id:i,name};
    });
    game = createGame(newPlayers);
    sync(); render();
  };

  app.querySelector('#phaseSel').onchange=()=>{
    snapshot(game);
    game.phase = app.querySelector('#phaseSel').value;
    if(game.phase===PHASE.NIGHT) initNightDraft();
    sync(); render();
  };

  app.querySelector('#dealStartBtn').onclick=async()=>{
    const ok = await modalConfirm('배정 시작','카드 배정을 시작할까요?');
    if(!ok) return;
    snapshot(game);
    game.phase=PHASE.DEAL;
    game.winner=null;
    game.players.forEach(p=>{ p.role=null; p.publicCard='CITIZEN'; p.alive=true; p.assigned=false; p.terroristTarget=null; });
    game.deck = shuffle(rolePoolFor(game.players.length));
    game.deckUsed = Array.from({length:game.players.length}).map(()=>false);
    // 진행자는 state.phase === DEAL로 판단하므로 별도 메시지 불필요
    sync(); render();
  };

  app.querySelector('#forceEndBtn').onclick=async()=>{
    const ok = await modalConfirm('강제 종료','SETUP으로 초기화할까요? (되돌리기 가능)');
    if(!ok) return;
    snapshot(game);
    game.phase=PHASE.SETUP;
    game.winner=null;
    game.votes={};
    game.executionTarget=null;
    pendingReporterReveal=null;
    sync(); render();
  };

  // assign list
  app.querySelector('#assignList').innerHTML = game.players.map(p=>{
    const r = p.role ? ROLE_LABEL[p.role] : '미배정';
    const pub = p.publicCard && p.publicCard!=='CITIZEN' ? ` / 공개:${ROLE_LABEL[p.publicCard]||p.publicCard}` : '';
    return `<div style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div>${p.name}${p.alive?'':' <span class="muted">(사망)</span>'}</div>
      <div class="muted small">${r}${pub}</div>
    </div>`;
  }).join('');

  // control panel
  app.querySelector('#controlPanel').innerHTML = buildControlPanel();
  wireControlPanel();
}

function buildControlPanel(){
  if(game.winner){
    return `<p class="muted">게임 종료: <b>${game.winner}</b></p>`;
  }
  if(game.phase===PHASE.DEAL){
    return `<p class="muted">배정 진행: ${game.players.filter(p=>p.assigned).length}/${game.players.length}</p>`;
  }
  if(game.phase===PHASE.NIGHT){
    if(!nightDraft) initNightDraft();
    return `
      <div class="grid cols2">
        <div>
          ${sel('마피아 공격', nightDraft.mafiaId, 'mafiaTarget', false)}
          ${sel('의사 보호', nightDraft.doctorId, 'doctorTarget', true)}
          ${sel('경찰 조사', nightDraft.policeId, 'policeTarget', true)}
        </div>
        <div>
          ${reporterBlock()}
          ${sel('테러리스트 지목', nightDraft.terroristId, 'terroristTarget', true)}
        </div>
      </div>
      <div class="actions" style="margin-top:10px"><button class="primary" id="nightResolve">밤 확정 → DAY</button></div>
    `;
  }
  if(game.phase===PHASE.DAY){
    return `
      <p class="muted">낮 토론</p>
      <div class="actions">
        <button class="primary" id="toVote">투표로 이동</button>
        <button id="skipDay">토론 스킵</button>
        <button id="manualReveal">기자 공개(수동)</button>
      </div>
    `;
  }
  if(game.phase===PHASE.VOTE){
    const target = tallyVotes(game);
    return `
      <p class="muted">투표</p>
      <div class="actions">
        <button class="primary" id="tallyBtn">집계 → 처형</button>
        <button id="invBtn">무효 → 처형</button>
        <button id="clearBtn">투표 초기화</button>
      </div>
      <p class="muted small">미확정 집계: ${target===null?'동점/무효':(game.players.find(p=>p.id==target)?.name ?? '-')}</p>
    `;
  }
  if(game.phase===PHASE.EXECUTION){
    const t=game.executionTarget;
    const name = (t==null)? '무효(처형 없음)' : (game.players.find(p=>p.id==t)?.name ?? '-');
    return `
      <p class="muted">처형 단계: <b>${name}</b></p>
      <div class="actions">
        <button class="primary" id="execConfirm">처형 확정</button>
        <button id="execCancel">처형 취소(무효)</button>
      </div>
    `;
  }
  return `<p class="muted">SETUP</p>`;
}

function wireControlPanel(){
  if(game.winner) return;

  if(game.phase===PHASE.NIGHT){
    app.querySelectorAll('select[data-key]').forEach(s=>{
      s.onchange=()=>{
        snapshot(game);
        const key=s.dataset.key;
        nightDraft[key] = (s.value===''? null : Number(s.value));
        render();
      };
    });
    const rep=app.querySelector('#repUsed');
    if(rep){
      rep.onchange=()=>{
        snapshot(game);
        nightDraft.reporterUsed = rep.checked;
        if(!nightDraft.reporterUsed) nightDraft.reporterTarget=null;
        render();
      };
    }
    app.querySelector('#nightResolve').onclick=async()=>{
      const ok = await modalConfirm('밤 확정','밤 결과를 확정할까요? (연출 후 DAY)');
      if(!ok) return;
      snapshot(game);
      const res = resolveNight(game, nightDraft);
      res.dead.forEach(id=>{ if(game.players[id]) game.players[id].alive=false; });
      // 아침 연출 이벤트
      game.fx = { token: Date.now(), events: res.events||[] };
      pendingReporterReveal = res.reporterRevealTarget;
      game.phase=PHASE.DAY;
      game.votes={}; game.executionTarget=null;
      const winner=checkWin(game);
      if(winner){ game.phase=PHASE.END; game.winner=winner; }
      sync(); render();
    };
    return;
  }

  if(game.phase===PHASE.DAY){
    app.querySelector('#toVote').onclick=async()=>{
      const ok = await modalConfirm('투표로 이동','투표로 이동할까요? (되돌리기 가능)');
      if(!ok) return;
      snapshot(game);
      game.phase=PHASE.VOTE;
      sync(); render();
    };
    app.querySelector('#skipDay').onclick=async()=>{
      const ok = await modalConfirm('토론 스킵','토론을 스킵하고 투표로 넘어갈까요?');
      if(!ok) return;
      snapshot(game);
      game.phase=PHASE.VOTE;
      sync(); render();
    };
    app.querySelector('#manualReveal').onclick=async()=>{
      const ok = await modalConfirm('기자 공개','기자 공개(수동)를 진행할까요?');
      if(!ok) return;
      const alive = game.players.filter(p=>p.alive);
      const id = alive[0]?.id;
      if(id!=null){
        snapshot(game);
        journalistReveal(game, id); // 간단: 첫 번째 생존자 공개 (테스트용). 필요하면 드롭다운으로 확장
        sync(); render();
      }
    };
    return;
  }

  if(game.phase===PHASE.VOTE){
    app.querySelector('#tallyBtn').onclick=async()=>{
      const ok = await modalConfirm('투표 집계','집계하고 처형 단계로 이동할까요?');
      if(!ok) return;
      snapshot(game);
      const target = tallyVotes(game);
      game.executionTarget = (target===null? null : Number(target));
      game.phase=PHASE.EXECUTION;
      game.fx = { token: Date.now(), events:[{type:'VOTE'}] };
      sync(); render();
    };
    app.querySelector('#invBtn').onclick=async()=>{
      const ok = await modalConfirm('무효 처리','무효로 처리하고 처형 단계로 이동할까요?');
      if(!ok) return;
      snapshot(game);
      game.executionTarget=null;
      game.phase=PHASE.EXECUTION;
      game.fx = { token: Date.now(), events:[{type:'VOTE'}] };
      sync(); render();
    };
    app.querySelector('#clearBtn').onclick=async()=>{
      const ok = await modalConfirm('투표 초기화','투표를 초기화할까요?');
      if(!ok) return;
      snapshot(game);
      clearVotes(game);
      sync(); render();
    };
    return;
  }

  if(game.phase===PHASE.EXECUTION){
    app.querySelector('#execConfirm').onclick=async()=>{
      const ok = await modalConfirm('처형 확정','처형을 확정할까요? (되돌리기 가능)');
      if(!ok) return;
      snapshot(game);
      let result={executed:[],chain:[]};
      if(game.executionTarget!=null){
        result=execute(game, game.executionTarget);
      }
      const evs=[{type:'EXECUTION'}];
      if(result.chain.length) evs.push({type:'TERROR_CHAIN'});
      game.fx = { token: Date.now(), events: evs };
      const winner=checkWin(game);
      if(winner){ game.phase=PHASE.END; game.winner=winner; }
      else { game.night+=1; game.phase=PHASE.NIGHT; game.votes={}; game.executionTarget=null; initNightDraft(); }
      sync(); render();
    };
    app.querySelector('#execCancel').onclick=async()=>{
      const ok = await modalConfirm('처형 취소','처형 없이 다음 밤으로 넘어갈까요?');
      if(!ok) return;
      snapshot(game);
      game.night+=1; game.phase=PHASE.NIGHT; game.votes={}; game.executionTarget=null; initNightDraft();
      sync(); render();
    };
    return;
  }
}

function sel(title, actorId, key, optional){
  const actor = actorId!=null ? game.players[actorId] : null;
  if(!actor || !actor.alive) return `<p class="muted small">${title}: 사용 불가</p>`;
  const opts = game.players.filter(p=>p.alive && p.id!==actorId).map(p=>`<option value="${p.id}" ${nightDraft[key]===p.id?'selected':''}>${p.name}</option>`).join('');
  return `
    <label>${title} <span class="muted small">(${actor.name})</span></label>
    <select data-key="${key}">
      <option value="">${optional?'미사용 / 선택안함':'대상 선택'}</option>
      ${opts}
    </select>
  `;
}
function reporterBlock(){
  const rid = nightDraft.reporterId;
  const actor = rid!=null ? game.players[rid] : null;
  if(!actor || !actor.alive) return `<p class="muted small">기자: 사용 불가</p>`;
  const disabled = game.night < 2;
  const checked = nightDraft.reporterUsed && !disabled;
  const opts = game.players.filter(p=>p.alive && p.id!==rid).map(p=>`<option value="${p.id}" ${nightDraft.reporterTarget===p.id?'selected':''}>${p.name}</option>`).join('');
  return `
    <label>기자 특보 <span class="muted small">(${actor.name})</span></label>
    <div class="actions" style="margin:6px 0">
      <input id="repUsed" type="checkbox" style="width:auto" ${checked?'checked':''} ${disabled?'disabled':''}>
      <span class="muted small">${disabled?'첫밤 불가':'사용'}</span>
    </div>
    <select data-key="reporterTarget" ${checked?'':'disabled'}>
      <option value="">대상 선택</option>
      ${opts}
    </select>
  `;
}

function onMsg(msg){
  // (WebRTC 제거) legacy
}

async function onAction(action){
  const msg = action?.msg || action; // {type,...}
  if(msg.type==='REQ_SYNC'){
    if(pendingReporterReveal!=null){
      snapshot(game);
      journalistReveal(game, pendingReporterReveal);
      pendingReporterReveal=null;
    }
    return;
  }
  if(msg.type==='DEAL_PICK'){
    if(game.phase!==PHASE.DEAL || !game.deck || !game.deckUsed) return;
    const {cardIndex, playerId} = msg;
    if(game.deckUsed[cardIndex]) return;
    const p=game.players[playerId];
    if(!p || p.assigned) return;
    snapshot(game);
    const role = game.deck[cardIndex];
    game.deckUsed[cardIndex]=true;
    p.role=role; p.assigned=true;
    // 공개/연출: fx 이벤트로 전달 (display가 token 기준으로 1회만 재생)
    game.fx = { token: Date.now(), events: [{type:'DEAL_REVEAL', playerId, role, cardIndex}] };
    await sync();
    render();
    if(game.players.every(x=>x.assigned)){
      snapshot(game);
      game.phase=PHASE.NIGHT;
      initNightDraft();
      await sync();
      render();
    }
  }

  if(msg.type==='VOTE'){
    // 투표는 display에서 보내고, host가 game.votes에 반영
    const {voterId, targetId} = msg;
    if(game.phase!==PHASE.VOTE) return;
    snapshot(game);
    game.votes[String(voterId)] = (targetId==null? null : Number(targetId));
    return;
  }
}

render();
