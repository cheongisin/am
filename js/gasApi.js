// Netlify Functions API

const API = "/.netlify/functions/state";

async function jfetch(url, opts = {}) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  const txt = await res.text();
  if (!res.ok) throw new Error(txt);
  return txt ? JSON.parse(txt) : null;
}

export function genRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function getState(roomCode) {
  try {
    const res = await jfetch(`${API}?room=${roomCode}`);
    return res.state;
  } catch {
    return null;
  }
}

export async function setState(roomCode, state) {
  const payload = { ...state, roomCode };
  return await jfetch(API, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function patchState(roomCode, patch) {
  const cur = await getState(roomCode);
  if (!cur) return;
  return await setState(roomCode, { ...cur, ...patch });
}

// 사용 안 하지만 인터페이스 유지
export async function pushAction() {}
export async function pullActions() { return { actions: [] }; }
export async function clearActions() {}