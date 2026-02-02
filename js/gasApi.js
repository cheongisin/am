
// Google Apps Script (GAS) sync layer
// ✅ GET/JSONP only (CORS/프리플라이트 회피 버전)

// ✅ 너가 배포한 GAS Web App URL (…/exec)
export const GAS_URL = "https://script.google.com/macros/s/AKfycbx4hAdB-xLWYzBjLrqc4bl0NCK1wCKY7aEVNhU3rtxf0CPedE_WIbGLbPd3m939bAjv8g/exec";

function mustHaveUrl(){
  if(!GAS_URL){
    throw new Error('GAS_URL이 비어있습니다. js/gasApi.js의 GAS_URL을 설정하세요');
  }
}

// ---- base64 websafe encode(JSON) ----
function b64wsEncode(obj){
  const json = JSON.stringify(obj ?? {});
  const utf8 = new TextEncoder().encode(json);
  let bin = '';
  for (let i=0;i<utf8.length;i++) bin += String.fromCharCode(utf8[i]);
  const b64 = btoa(bin)
    .replace(/\+/g,'-')
    .replace(/\//g,'_')
    .replace(/=+$/,'');
  return b64;
}

// ---- JSONP helper ----
function jsonp(url){
  return new Promise((resolve, reject)=>{
    const cb = 'cb_' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const timeout = setTimeout(()=>{
      cleanup();
      reject(new Error('JSONP timeout'));
    }, 30000);

    function cleanup(){
      clearTimeout(timeout);
      try{ delete window[cb]; }catch(e){ window[cb]=undefined; }
      if(s && s.parentNode) s.parentNode.removeChild(s);
    }

    window[cb] = (data)=>{
      cleanup();
      resolve(data);
    };

    const sep = url.includes('?') ? '&' : '?';
    s.src = url + sep + 'callback=' + encodeURIComponent(cb) + '&_ts=' + Date.now();
    s.onerror = ()=>{
      cleanup();
      reject(new Error('JSONP load failed'));
    };
    document.head.appendChild(s);
  });
}

function assertOk(res, op){
  if(res && typeof res === 'object' && res.ok === false){
    throw new Error(res.error || (op + ' failed'));
  }
  return res;
}

function isUnknownOpError(err){
  const msg = String(err?.message || err || '');
  return /unknown\s+op/i.test(msg);
}

function urlFor(op, roomCode, payloadObj){
  mustHaveUrl();
  const u = new URL(GAS_URL);
  u.searchParams.set('op', op);
  if (roomCode !== undefined && roomCode !== null){
    u.searchParams.set('room', String(roomCode));
  }
  if (payloadObj !== undefined){
    u.searchParams.set('payload', b64wsEncode(payloadObj));
  }
  return u.toString();
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

// ---- READ ----
export async function getState(roomCode){
  const res = await jsonp(urlFor('state', roomCode));
  if(res && res.state && typeof res.state === 'object') return res.state;
  if(res && res.phase) return res;
  if(res && res.state && res.state.state) return res.state.state;
  return {};
}

// ---- NEW API (권장) ----
export async function setBothState(roomCode, { publicState, privateState } = {}){
  try {
    return assertOk(await jsonp(urlFor('setBoth', roomCode, { publicState, privateState })), 'setBoth');
  } catch (e) {
    // 구버전 GAS 폴백
    if (isUnknownOpError(e)) {
      return await setState(roomCode, publicState);
    }
    throw e;
  }
}

export async function getPrivateState(roomCode, token){
  return assertOk(await jsonp(urlFor('private', roomCode, { token })), 'private');
}

export async function dealPick(roomCode, { cardIndex, playerId } = {}){
  return assertOk(await jsonp(urlFor('dealPick', roomCode, { cardIndex, playerId })), 'dealPick');
}

export async function pullActions(roomCode){
  return assertOk(await jsonp(urlFor('actions', roomCode)), 'actions');
}

// ---- WRITE (GET/JSONP) ----
export async function setState(roomCode, state){
  return assertOk(await jsonp(urlFor('setState', roomCode, { state })), 'setState');
}

export async function patchState(roomCode, patch){
  return assertOk(await jsonp(urlFor('patchState', roomCode, { patch })), 'patchState');
}

export async function pushAction(roomCode, action){
  return assertOk(await jsonp(urlFor('pushAction', roomCode, { action })), 'pushAction');
}

export async function clearActions(roomCode, uptoId=null){
  const payload = (uptoId === null) ? {} : { uptoId };
  return assertOk(await jsonp(urlFor('clearActions', roomCode, payload)), 'clearActions');
}

// ---- Health check ----
export async function ping(){
  mustHaveUrl();
  return assertOk(await jsonp(urlFor('ping')), 'ping');
}
