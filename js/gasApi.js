// js/gasApi.js - JSONP only (CORS 회피), GAS Web App Sync Layer

export const GAS_URL = "https://script.google.com/macros/s/AKfycbwC23PdK8meMGDsm-UBYkOpjk61JFOeRTLAPihKX-g0oG7j0sio3C7bylAObvW_DAtQ2g/exec"; // https://script.google.com/macros/s/XXXX/exec

function mustHaveUrl(){
  if(!GAS_URL) throw new Error("GAS_URL이 비어있습니다. js/gasApi.js에 exec URL을 넣으세요.");
}

function b64urlEncode(str){
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  return b64;
}

function jsonp(params){
  mustHaveUrl();
  return new Promise((resolve, reject) => {
    const cbName = "__gas_cb_" + Math.random().toString(16).slice(2);
    const url = new URL(GAS_URL);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, String(v)));

    url.searchParams.set("callback", cbName);

    const script = document.createElement("script");
    script.async = true;
    script.src = url.toString();

    const cleanup = () => {
      delete window[cbName];
      script.remove();
    };

    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP load failed (네트워크/배포URL/권한 확인)"));
    };

    document.head.appendChild(script);
  });
}

function unwrap(resp){
  // 서버가 {ok:true,state:{...}} 형태로 주므로 여기서 통일
  if (resp && resp.ok === false) return resp; // caller가 판단
  return resp;
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

export async function ping(){
  const r = unwrap(await jsonp({ op:"ping" }));
  if (r.ok === false) throw new Error(r.error || "ping_failed");
  return r;
}

export async function getState(roomCode){
  const r = unwrap(await jsonp({ op:"state", room: roomCode }));
  if (r.ok === false) return r;          // {ok:false,error:"not_found"...}
  return r.state ?? r;                   // 혹시 예전 포맷도 허용
}

export async function setState(roomCode, state){
  const data = b64urlEncode(JSON.stringify({ roomCode, state }));
  const r = unwrap(await jsonp({ op:"setState", data }));
  if (r.ok === false) throw new Error(r.error || "setState_failed");
  return r;
}

export async function patchState(roomCode, patch){
  const data = b64urlEncode(JSON.stringify({ roomCode, patch }));
  const r = unwrap(await jsonp({ op:"patchState", data }));
  if (r.ok === false) throw new Error(r.error || "patchState_failed");
  return r;
}

export async function pushAction(roomCode, action){
  const data = b64urlEncode(JSON.stringify({ roomCode, action }));
  const r = unwrap(await jsonp({ op:"pushAction", data }));
  if (r.ok === false) throw new Error(r.error || "pushAction_failed");
  return r;
}

export async function pullActions(roomCode){
  const r = unwrap(await jsonp({ op:"actions", room: roomCode }));
  if (r.ok === false) return r;
  return r.actions ?? [];
}

export async function clearActions(roomCode, uptoId=null){
  const data = b64urlEncode(JSON.stringify({ roomCode, uptoId }));
  const r = unwrap(await jsonp({ op:"clearActions", data }));
  if (r.ok === false) throw new Error(r.error || "clearActions_failed");
  return r;
}
