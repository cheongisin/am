// GAS JSON API (CORS-safe)

export const GAS_URL =
  "https://script.google.com/macros/s/AKfycby21uL-nW6YVdLtouiP4zmR5-Jsi_02RLAJuufla4Sji7uX4wSW2_4Z7eG-C3YEg5hdzw/exec";

/* ===== Utils ===== */
async function jget(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { return { ok:false, error:'bad_response', raw:text }; }
}

/* ===== API ===== */
export function genRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function ping() {
  return jget(`${GAS_URL}?op=ping`);
}

export async function getState(room) {
  return jget(`${GAS_URL}?op=state&room=${room}`);
}

export async function setState(room, state) {
  return jget(`${GAS_URL}?op=state&room=${room}`)
    .then(() => fetch(GAS_URL, {
      method:'POST',
      body: JSON.stringify({
        op:'setState',
        roomCode: room,
        state
      })
    }));
}

export async function patchState(room, patch) {
  return fetch(GAS_URL, {
    method:'POST',
    body: JSON.stringify({
      op:'patchState',
      roomCode: room,
      patch
    })
  });
}