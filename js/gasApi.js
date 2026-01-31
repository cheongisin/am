// Sync API layer (GAS or Netlify Functions compatible)
// - Netlify 기본: /.netlify/functions/state
// - GAS 사용 시: 아래 GAS_URL에 Web App URL 넣기

export const GAS_URL = "https://script.google.com/macros/s/AKfycbyYAGFUV1O3wlvyjCyECOza7-2Fx2AcEwUmeKTJJESaUtSq7Xci6UFPRuv97XDHdFYb4Q/exec";

function apiBase(){
  // GAS_URL이 설정돼 있으면 GAS 사용
  if (typeof GAS_URL === "string" && GAS_URL.trim()) return GAS_URL.trim();
  // 아니면 Netlify Functions 기본 경로 사용
  return `${location.origin}/.netlify/functions/state`;
}

async function jfetch(url, opts={}){
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "Content-Type":"application/json", ...(opts.headers||{}) },
    ...opts,
  });
  const text = await res.text();
  if(!res.ok) throw new Error(text || `HTTP ${res.status}`);
  if(!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

// ✅ 핵심: {ok:true, state:{...}} 형태면 state를 꺼내서 반환
export async function getState(roomCode){
  const base = apiBase();

  // GAS 모드: ?op=state&room=...
  if (base.includes("script.google.com")) {
    const res = await jfetch(`${base}?op=state&room=${encodeURIComponent(roomCode)}`);
    // GAS가 혹시 래퍼로 주는 경우도 대비
    return (res && res.state) ? res.state : res;
  }

  // Netlify 모드: ?room=...
  const res = await jfetch(`${base}?room=${encodeURIComponent(roomCode)}`);
  return (res && res.state) ? res.state : res;
}

export async function setState(roomCode, state){
  const base = apiBase();
  if (base.includes("script.google.com")) {
    return await jfetch(base, { method:"POST", body: JSON.stringify({op:"setState", roomCode, state}) });
  }
  return await jfetch(base, { method:"POST", body: JSON.stringify({op:"setState", roomCode, state}) });
}

export async function patchState(roomCode, patch){
  const base = apiBase();
  if (base.includes("script.google.com")) {
    return await jfetch(base, { method:"POST", body: JSON.stringify({op:"patchState", roomCode, patch}) });
  }
  return await jfetch(base, { method:"POST", body: JSON.stringify({op:"patchState", roomCode, patch}) });
}

export async function pushAction(roomCode, action){
  const base = apiBase();
  if (base.includes("script.google.com")) {
    return await jfetch(base, { method:"POST", body: JSON.stringify({op:"pushAction", roomCode, action}) });
  }
  return await jfetch(base, { method:"POST", body: JSON.stringify({op:"pushAction", roomCode, action}) });
}

export async function pullActions(roomCode){
  const base = apiBase();
  if (base.includes("script.google.com")) {
    const res = await jfetch(`${base}?op=actions&room=${encodeURIComponent(roomCode)}`);
    return res;
  }
  const res = await jfetch(`${base}?op=actions&room=${encodeURIComponent(roomCode)}`);
  return res;
}

export async function clearActions(roomCode, uptoId=null){
  const base = apiBase();
  if (base.includes("script.google.com")) {
    return await jfetch(base, { method:"POST", body: JSON.stringify({op:"clearActions", roomCode, uptoId}) });
  }
  return await jfetch(base, { method:"POST", body: JSON.stringify({op:"clearActions", roomCode, uptoId}) });
}