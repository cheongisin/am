// Google Apps Script (GAS) sync layer
// WebRTC 제거 버전

// ✅ 너가 배포한 GAS Web App URL을 넣어줘
// 예: https://script.google.com/macros/s/XXXX/exec
export const GAS_URL = https://script.google.com/macros/s/AKfycbwd2haaD4efa1cgHBOhD9oW7KjUYgUtl4yj0ytupTWEi3nxrGjSKi4iluryKj34cQ_7aQ/exec || '';

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
  try{ return JSON.parse(text); }catch{ return text; }
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

export async function getState(roomCode){
  mustHaveUrl();
  return await jfetch(`${GAS_URL}?op=state&room=${encodeURIComponent(roomCode)}`);
}

export async function setState(roomCode, state){
  mustHaveUrl();
  return await jfetch(GAS_URL, { method:'POST', body: JSON.stringify({op:'setState', roomCode, state})});
}

export async function patchState(roomCode, patch){
  mustHaveUrl();
  return await jfetch(GAS_URL, { method:'POST', body: JSON.stringify({op:'patchState', roomCode, patch})});
}

export async function pushAction(roomCode, action){
  mustHaveUrl();
  return await jfetch(GAS_URL, { method:'POST', body: JSON.stringify({op:'pushAction', roomCode, action})});
}

export async function pullActions(roomCode){
  mustHaveUrl();
  return await jfetch(`${GAS_URL}?op=actions&room=${encodeURIComponent(roomCode)}`);
}

export async function clearActions(roomCode, uptoId=null){
  mustHaveUrl();
  return await jfetch(GAS_URL, { method:'POST', body: JSON.stringify({op:'clearActions', roomCode, uptoId})});
}
