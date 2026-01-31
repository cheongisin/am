// Google Apps Script (GAS) sync layer
// ✅ 응답이 {ok:true, state:{...}} 형태로 오는 걸 자동으로 풀어서 반환

export const GAS_URL = "https://script.google.com/macros/s/AKfycbyK1_LzmRSiv4iFAeN5xuU_vFpXj1GgfP5TEHVJ-5xREQvJ_4pCJGql0hR8E-ATakt_mg/exec";

function mustHaveUrl(){
  if(!GAS_URL){
    throw new Error('GAS_URL이 비어있습니다. js/gasApi.js의 GAS_URL을 설정하세요');
  }
}

async function jfetch(url, opts={}){
  const res = await fetch(url, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) },
    ...opts,
  });

  const text = await res.text();
  if(!res.ok) throw new Error(text || `HTTP ${res.status}`);
  if(!text) return null;

  let data;
  try { data = JSON.parse(text); }
  catch { data = text; }

  // ✅ GAS 표준 응답 처리: {ok:false,...}면 throw
  if (data && typeof data === 'object' && 'ok' in data) {
    if (!data.ok) throw new Error(data.error || 'GAS error');
  }

  return data;
}

// ✅ 여기서 state를 자동으로 꺼내서 반환
function unwrapState(resp){
  if(resp && typeof resp === 'object' && 'state' in resp) return resp.state;
  return resp;
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

export async function getState(roomCode){
  mustHaveUrl();
  const resp = await jfetch(`${GAS_URL}?op=state&room=${encodeURIComponent(roomCode)}`);
  return unwrapState(resp);
}

export async function setState(roomCode, state){
  mustHaveUrl();
  return await jfetch(GAS_URL, {
    method:'POST',
    body: JSON.stringify({op:'setState', roomCode, state})
  });
}

export async function patchState(roomCode, patch){
  mustHaveUrl();
  return await jfetch(GAS_URL, {
    method:'POST',
    body: JSON.stringify({op:'patchState', roomCode, patch})
  });
}

export async function pushAction(roomCode, action){
  mustHaveUrl();
  return await jfetch(GAS_URL, {
    method:'POST',
    body: JSON.stringify({op:'pushAction', roomCode, action})
  });
}

export async function pullActions(roomCode){
  mustHaveUrl();
  const resp = await jfetch(`${GAS_URL}?op=actions&room=${encodeURIComponent(roomCode)}`);
  // actions는 서버 구현에 따라 {ok:true,actions:[...]}일 수 있음
  return (resp && resp.actions) ? resp.actions : resp;
}

export async function clearActions(roomCode, uptoId=null){
  mustHaveUrl();
  return await jfetch(GAS_URL, {
    method:'POST',
    body: JSON.stringify({op:'clearActions', roomCode, uptoId})
  });
}