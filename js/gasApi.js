// Google Apps Script (GAS) sync layer
// WebRTC 제거 버전

// ✅ 너가 배포한 GAS Web App URL을 넣어줘
// 예: https://script.google.com/macros/s/XXXX/exec
export const GAS_URL = "https://script.google.com/macros/s/AKfycbw3uVQs9-nLGMm_eOQAJkVF-Q_GudKkWyYqgu-KlrLtHHFNtSOBRNjOvrjw1eyuj-IMwQ/exec";

async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    cache: 'no-store',
    ...opts // ⚠️ headers 절대 넣지 말 것
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  return text ? JSON.parse(text) : null;
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

// ===== host / display가 기대하는 API 그대로 유지 =====

export async function getState(roomCode){
  const res = await jfetch(`${GAS_URL}?room=${encodeURIComponent(roomCode)}`);
  if (!res || res.ok !== true) return null;
  return res.state;
}

export async function setState(roomCode, state){
  const payload = { ...state, roomCode };
  return await jfetch(GAS_URL, {
    method: 'POST',
    body: JSON.stringify(payload) // text/plain
  });
}

export async function patchState(roomCode, patch){
  const current = await getState(roomCode);
  if (!current) return;
  const next = { ...current, ...patch, roomCode };
  return await setState(roomCode, next);
}

// action 계열은 당장 안 쓰므로 더미 유지
export async function pushAction(){ return; }
export async function pullActions(){ return { actions: [] }; }
export async function clearActions(){ return; }
