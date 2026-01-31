// Google Apps Script (GAS) sync layer
// ✅ iOS/Safari 안정화: "POST 금지" + "GET(JSONP)만 사용"

export const GAS_URL = "https://script.google.com/macros/s/AKfycbyK1_LzmRSiv4iFAeN5xuU_vFpXj1GgfP5TEHVJ-5xREQvJ_4pCJGql0hR8E-ATakt_mg/exec"; // 예: https://script.google.com/macros/s/XXXX/exec

function mustHaveUrl(){
  if(!GAS_URL) throw new Error('GAS_URL이 비어있습니다. js/gasApi.js의 GAS_URL을 설정하세요');
}

// base64url
function b64urlEncode(str){
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  const b64 = btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return b64;
}

// JSONP 호출 (CORS 회피)
function jsonp(url){
  return new Promise((resolve, reject)=>{
    const cb = '__cb_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    const sep = url.includes('?') ? '&' : '?';
    const full = `${url}${sep}callback=${cb}`;

    window[cb] = (data)=>{
      cleanup();
      resolve(data);
    };

    function cleanup(){
      try{ delete window[cb]; }catch(e){ window[cb]=undefined; }
      if(script && script.parentNode) script.parentNode.removeChild(script);
    }

    script.onerror = ()=>{
      cleanup();
      reject(new Error('Load failed'));
    };

    script.src = full;
    document.head.appendChild(script);
  });
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

export async function ping(){
  mustHaveUrl();
  return await jsonp(`${GAS_URL}?op=ping`);
}

export async function getState(roomCode){
  mustHaveUrl();
  return await jsonp(`${GAS_URL}?op=state&room=${encodeURIComponent(roomCode)}`);
}

// ✅ 쓰기 동작도 전부 GET + payload(base64url JSON)
export async function setState(roomCode, state){
  mustHaveUrl();
  const payload = b64urlEncode(JSON.stringify(state));
  return await jsonp(`${GAS_URL}?op=setState&room=${encodeURIComponent(roomCode)}&payload=${payload}`);
}

export async function patchState(roomCode, patch){
  mustHaveUrl();
  const payload = b64urlEncode(JSON.stringify(patch));
  return await jsonp(`${GAS_URL}?op=patchState&room=${encodeURIComponent(roomCode)}&payload=${payload}`);
}

export async function pushAction(roomCode, action){
  mustHaveUrl();
  const payload = b64urlEncode(JSON.stringify(action));
  return await jsonp(`${GAS_URL}?op=pushAction&room=${encodeURIComponent(roomCode)}&payload=${payload}`);
}

export async function pullActions(roomCode, since=0){
  mustHaveUrl();
  return await jsonp(`${GAS_URL}?op=actions&room=${encodeURIComponent(roomCode)}&since=${encodeURIComponent(String(since))}`);
}

export async function clearActions(roomCode, uptoId=null){
  mustHaveUrl();
  if(uptoId==null){
    return await jsonp(`${GAS_URL}?op=clearActions&room=${encodeURIComponent(roomCode)}`);
  }
  return await jsonp(`${GAS_URL}?op=clearActions&room=${encodeURIComponent(roomCode)}&uptoId=${encodeURIComponent(String(uptoId))}`);
}