// GAS JSONP client (CORS 우회 / POST 미사용)

export const GAS_URL = "https://script.google.com/macros/s/AKfycbzI27Gw3Uam7az9BwT4yWeehbcRQD8bdwNJNeU2uhlB-Oe2BHkzC6RfScYnIqTAG0HN-g/exec"; // .../exec

function mustHaveUrl(){
  if(!GAS_URL) throw new Error("GAS_URL이 비어있습니다. js/gasApi.js에 설정하세요.");
}

function b64UrlEncodeJson(obj){
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  const b64 = btoa(bin);
  // url-safe
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function jsonpFetch(url){
  return new Promise((resolve, reject) => {
    const cb = "__cb_" + Math.random().toString(36).slice(2);
    const sep = url.includes("?") ? "&" : "?";
    const full = url + sep + "callback=" + encodeURIComponent(cb);

    const script = document.createElement("script");
    script.src = full;
    script.async = true;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP timeout"));
    }, 8000);

    function cleanup(){
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }

    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP load failed"));
    };

    document.head.appendChild(script);
  });
}

async function call(op, params={}){
  mustHaveUrl();
  const q = new URLSearchParams({ op, ...params });
  return await jsonpFetch(`${GAS_URL}?${q.toString()}`);
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

export async function getState(roomCode){
  const res = await call("state", { room: roomCode });
  if(res && res.ok) return res.state;
  throw new Error((res && res.error) ? res.error : "getState failed");
}

export async function setState(roomCode, state){
  const b64 = b64UrlEncodeJson(state);
  const res = await call("setState", { room: roomCode, b64 });
  if(res && res.ok) return true;
  throw new Error((res && res.error) ? res.error : "setState failed");
}

export async function patchState(roomCode, patch){
  const b64 = b64UrlEncodeJson(patch);
  const res = await call("patchState", { room: roomCode, b64 });
  if(res && res.ok) return true;
  throw new Error((res && res.error) ? res.error : "patchState failed");
}

export async function pullActions(roomCode){
  const res = await call("actions", { room: roomCode });
  if(res && res.ok) return res.actions || [];
  throw new Error((res && res.error) ? res.error : "pullActions failed");
}

export async function pushAction(roomCode, action){
  const b64 = b64UrlEncodeJson(action);
  const res = await call("pushAction", { room: roomCode, b64 });
  if(res && res.ok) return res.pushed;
  throw new Error((res && res.error) ? res.error : "pushAction failed");
}

export async function clearActions(roomCode, uptoId=null){
  const params = { room: roomCode };
  if(uptoId != null) params.uptoId = String(uptoId);
  const res = await call("clearActions", params);
  if(res && res.ok) return true;
  throw new Error((res && res.error) ? res.error : "clearActions failed");
}
