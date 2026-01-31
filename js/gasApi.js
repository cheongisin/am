// ===== GAS API Client (CORS SAFE) =====

export const GAS_URL =
  "https://script.google.com/macros/s/AKfycbyxcw93fSSBD640z9xRTmEMky77aS5gpciCHWBM_c9rZpwGl4QbVpKYO2c3BimmInrBpw/exec";

function must(){
  if (!GAS_URL) throw new Error("GAS_URL not set");
}

async function jfetch(url, opts={}){
  const res = await fetch(url, {
    cache: "no-store",
    ...opts // ⚠️ headers 없음 (preflight 방지)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt);
  return txt ? JSON.parse(txt) : null;
}

export function genRoomCode(){
  return String(Math.floor(1000 + Math.random()*9000));
}

// ===== state write =====
export async function saveState(state){
  must();
  const res = await jfetch(GAS_URL, {
    method: "POST",
    body: JSON.stringify(state)
  });
  if (!res || res.ok !== true) throw new Error("saveState failed");
  return true;
}

// ===== state read =====
export async function loadState(roomCode){
  must();
  const res = await jfetch(`${GAS_URL}?room=${encodeURIComponent(roomCode)}`);
  if (!res || res.ok !== true) return null;
  return res.state;
}
