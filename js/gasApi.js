// Google Apps Script (GAS) sync layer
// CORS 우회: 읽기=JSONP(GET), 쓰기=Simple POST(text/plain) + no-cors
// ✅ 아래 GAS_URL만 본인 /exec 로 바꿔주세요.
export const GAS_URL = "https://script.google.com/macros/s/AKfycbzkFy0YQflrMWDx3Fqm6oXDE4oyApQ-9bGrvFdKdEJ_8T0nyRSdc0IhFOixvh-1mc1Wjw/exec";

function mustHaveUrl(){
  if(!GAS_URL) throw new Error("GAS_URL이 비어있습니다. js/gasApi.js의 GAS_URL을 설정하세요.");
}

// ---------- JSONP (GET only) ----------
function jsonp(url){
  return new Promise((resolve, reject) => {
    const cb = "__gas_cb_" + Math.random().toString(36).slice(2);
    const cleanup = () => {
      try { delete window[cb]; } catch(e){ window[cb] = undefined; }
      if (script && script.parentNode) script.parentNode.removeChild(script);
    };

    window[cb] = (data) => { cleanup(); resolve(data); };

    const sep = url.includes("?") ? "&" : "?";
    const full = `${url}${sep}cb=${encodeURIComponent(cb)}&ts=${Date.now()}`;

    const script = document.createElement("script");
    script.src = full;
    script.async = true;
    script.onerror = () => { cleanup(); reject(new Error("JSONP load failed")); };
    document.head.appendChild(script);
  });
}

// ---------- Write (POST) without CORS preflight ----------
async function postNoCors(payload){
  mustHaveUrl();
  // text/plain은 "simple request"라 preflight를 피함
  // mode:no-cors로 응답을 읽지 않고도 전송 성공 처리
  await fetch(GAS_URL, {
    method: "POST",
    mode: "no-cors",
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  // no-cors라 응답 내용을 읽을 수 없으니, 여기서는 성공했다고만 간주
  return { ok: true };
}

// ---------- Helpers ----------
export function genRoomCode(){
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function ping(){
  mustHaveUrl();
  // ping은 JSONP로 안전하게 읽기
  return await jsonp(`${GAS_URL}?op=ping`);
}

export async function getState(roomCode){
  mustHaveUrl();
  return await jsonp(`${GAS_URL}?op=state&room=${encodeURIComponent(roomCode)}`);
}

export async function pullActions(roomCode){
  mustHaveUrl();
  return await jsonp(`${GAS_URL}?op=actions&room=${encodeURIComponent(roomCode)}`);
}

export async function setState(roomCode, state){
  return await postNoCors({ op:"setState", roomCode, state });
}

export async function patchState(roomCode, patch){
  return await postNoCors({ op:"patchState", roomCode, patch });
}

export async function pushAction(roomCode, action){
  return await postNoCors({ op:"pushAction", roomCode, action });
}

export async function clearActions(roomCode, uptoId=null){
  return await postNoCors({ op:"clearActions", roomCode, uptoId });
}
