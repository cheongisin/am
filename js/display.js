import { getState, patchState, pushAction } from './gasApi.js';
import { PHASE, ROLE_LABEL } from '../src/constants.js';
import { buildSeats } from './layout.js';

/* =========================
   DOM / 상태
========================= */
const root = document.getElementById('display');
if (!root) {
  throw new Error('#display element not found. display.html을 확인하세요.');
}

let connected = false;
let roomCode = '';
let pollTimer = null;
let beatTimer = null;
let failures = 0;
let lastHostBeatSeen = 0;
let lastRenderToken = null;

/* =========================
   튜닝 파라미터
========================= */
const FAIL_TO_DISCONNECT = 6;
const POLL_MS = 700;
const BEAT_MS = 2000;

/* =========================
   공통 유틸
========================= */
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
function setConnected(v){ connected = !!v; }

/* =========================
   에러 가드 (모바일 포함)
========================= */
function showFatal(err) {
  const msg = err?.stack || err?.message || String(err);
  root.innerHTML = `
    <div style="padding:16px;max-width:900px;margin:0 auto;">
      <h2>display.js 런타임 에러</h2>
      <pre style="white-space:pre-wrap">${escapeHtml(msg)}</pre>
      <button id="reloadBtn">새로고침</button>
    </div>`;
  document.getElementById('reloadBtn').onclick = () => location.reload();
}
window.addEventListener('error', e => showFatal(e.error || e.message || e));
window.addEventListener('unhandledrejection', e => showFatal(e.reason || e));

/* =========================
   연결 전 화면
========================= */
function renderDisconnectedScreen(){
  root.innerHTML = `
    <div class="display-wrap">
      <div class="panel">
        <div class="row">
          <div class="badge">진행자 연결</div>
          <div class="badge">상태 ${connected?'🟢':'🔴'}</div>
        </div>
        <div class="row" style="margin-top:12px;gap:8px">
          <input id="roomInput" placeholder="4자리 코드" inputmode="numeric" />
          <button id="joinBtn" class="primary">접속</button>
        </div>
      </div>
    </div>`;
  document.getElementById('joinBtn').onclick = async ()=>{
    const code = document.getElementById('roomInput').value.trim();
    await joinRoom(code);
  };
}

/* =========================
   메인 테이블 렌더
========================= */
function renderTable(state){
  const players = Array.isArray(state?.players) ? state.players : [];
  const phase = state?.phase || PHASE.SETUP;
  const timer = state?.timer || { mode:'STOPPED' };

  const aliveCount = players.filter(p=>p?.alive!==false).length;
  const timerText = (()=>{
    if(timer.mode==='INFINITE') return '∞';
    if(timer.mode==='COUNTDOWN'){
      const endAt = timer.running && timer.endAt ? timer.endAt : null;
      const remain = endAt
        ? Math.max(0, Math.ceil((endAt-Date.now())/1000))
        : Math.max(0, Number(timer.durationSec||0));
      const m=Math.floor(remain/60), s=remain%60;
      return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }
    return '--:--';
  })();

  const seats = buildSeats(players.length);
  const seatHtml = seats.map((seat, i)=>{
    const p = players[i] || {name:`P${i+1}`, publicCard:'CITIZEN', alive:true};
    const dead = p.alive===false;
    const label = p.publicCard!=='CITIZEN'
      ? (ROLE_LABEL[p.publicCard]||p.publicCard)
      : 'CITIZEN';
    return `
      <div class="seat ${seat.cls}">
        <div class="card ${dead?'dead':''}">
          <div class="card-top">${label}</div>
          <div class="card-body"></div>
        </div>
        <div class="name">${escapeHtml(p.name||`P${i+1}`)}</div>
      </div>`;
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
          <span class="badge">연결 ${connected?'🟢':'🔴'}</span>
          <span class="badge">방 ${roomCode||'-'}</span>
        </div>
      </div>

      <div class="table-area">
        <div class="seat-layer">
          ${seatHtml}
          <div class="host-anchor">사회자</div>
        </div>
      </div>

      ${phase===PHASE.DEAL ? renderDealPanel(state) : ''}
    </div>`;

  if(phase===PHASE.DEAL) wireDeal(state);
}

/* =========================
   DEAL (중복/스킵 방지)
========================= */
function renderDealPanel(state){
  const used = Array.isArray(state?.deckUsed)?state.deckUsed:[];
  const left = used.filter(v=>!v).length;
  return `
    <div class="deal-panel">
      <div class="deal-title">직업 배정 (남은 카드 ${left})</div>
      <div class="deal-grid">
        ${used.map((u,i)=>`
          <button class="deal-card" data-idx="${i}" ${u?'disabled':''}>
            ${u?'사용':'카드 '+(i+1)}
          </button>`).join('')}
      </div>
    </div>`;
}
function wireDeal(state){
  document.querySelectorAll('.deal-card').forEach(btn=>{
    btn.onclick = async ()=>{
      btn.disabled = true; // 즉시 잠금
      try{
        await pushAction(roomCode,{
          type:'DEAL_PICK',
          cardIndex:Number(btn.dataset.idx),
          playerId:guessNextPlayerId(state)
        });
      }catch(e){
        btn.disabled=false;
        alert('전송 실패');
      }
    };
  });
}
function guessNextPlayerId(state){
  const p = (state.players||[]).find(x=>x && x.assigned===false);
  return p ? Number(p.id) : 0;
}

/* =========================
   접속 / 폴링
========================= */
async function joinRoom(code){
  roomCode = String(code||'').trim();
  if(!/^\d{4}$/.test(roomCode)){
    alert('4자리 코드 필요');
    return;
  }

  failures=0; lastRenderToken=null;

  const st = await getState(roomCode);
  if(!st || st.ok===false){
    alert('방 없음');
    renderDisconnectedScreen();
    return;
  }

  if(beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(()=>patchState(roomCode,{clientHeartbeat:Date.now()}).catch(()=>{}), BEAT_MS);

  if(pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, POLL_MS);

  setConnected(true);
  renderTable(st);
}

async function poll(){
  try{
    await patchState(roomCode,{clientHeartbeat:Date.now()});
    const st = await getState(roomCode);
    if(!st || st.ok===false){
      failures++; if(failures>=FAIL_TO_DISCONNECT) setConnected(false);
      return;
    }
    failures=0;

    const hb = Number(st.hostHeartbeat||0);
    if(hb){ lastHostBeatSeen=hb; setConnected(Date.now()-hb<30000); }

    const token = st.eventQueue?.token || `${st.phase}-${hb}-${st.timer?.endAt||''}`;
    if(token!==lastRenderToken){
      lastRenderToken=token;
      renderTable(st);
    }
  }catch{
    failures++; if(failures>=FAIL_TO_DISCONNECT) setConnected(false);
  }
}

/* =========================
   시작
========================= */
renderDisconnectedScreen();