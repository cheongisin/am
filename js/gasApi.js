// GAS JSONP sync layer (NO POST, NO CORS)
// ✅ 너가 배포한 GAS Web App URL 넣기
export const GAS_URL = "https://script.google.com/macros/s/AKfycbxgT6w9FvpexHQEfa16SPzI36hbPM3MurdbjSdkXp5F4j3aIuP_hKHPrYq8LAlhS9r5bQ/exec";

function mustHaveUrl(){
  if(!GAS_URL) throw new Error("GAS_URL이 비어있습니다. js/gasApi.js에 GAS_URL을 넣어주세요");
}

function b64Json(obj){
  const json = JSON.stringify(obj);
  // utf8-safe base64
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}

function jsonp(params, timeoutMs=8000){
  mustHaveUrl();
  return new Promise((resolve, reject) => {
    const cb = "__gas_cb_" + Math.random().toString(36).slice(2);
    const u = new URL(GAS_URL);

    params.callback = cb;
    Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, String(v)));

    let done = false;
    const timer = setTimeout(() => {
      if(done) return;
      done = true;
      cleanup();
      reject(new Error("GAS JSONP timeout"));
    }, timeoutMs);

    function cleanup(){
      clearTimeout(timer);
      try{ delete window[cb]; }catch{}
      if(script && script.parentNode) script.parentNode.removeChild(script);
    }

    window[cb] = (data) => {
      if(done) return;
      done = true;
      cleanup();
      resolve(data);
    };

    const script = document.createElement("script");
    script.src = u.toString();
    script.onerror = () => {
      if(done) return;
      done = true;
      cleanup();
      reject(new Error("GAS JSONP load failed"));
    };
    document.head.appendChild(script);
  });
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

export async function ping(){
  const r = await jsonp({ op:"ping" });
  return r;
}

export async function getState(roomCode){
  const r = await jsonp({ op:"state", room: roomCode });
  return r;
}

export async function setState(roomCode, state){
  const payload = b64Json({ roomCode, state });
  const r = await jsonp({ op:"setState", payload });
  return r;
}

export async function patchState(roomCode, patch){
  const payload = b64Json({ roomCode, patch });
  const r = await jsonp({ op:"patchState", payload });
  return r;
}

export async function pushAction(roomCode, action){
  const payload = b64Json({ roomCode, action });
  const r = await jsonp({ op:"pushAction", payload });
  return r;
}

export async function pullActions(roomCode){
  const r = await jsonp({ op:"actions", room: roomCode });
  return r;
}

export async function clearActions(roomCode, uptoId=null){
  const payload = b64Json({ roomCode, uptoId });
  const r = await jsonp({ op:"clearActions", payload });
  return r;
}
