// Google Apps Script (GAS) sync layer
// ✅ CORS preflight(OPTIONS) 회피 버전: application/json 헤더 안씀 (URLSearchParams 사용)

export const GAS_URL =
  "https://script.google.com/macros/s/AKfycbyK1_LzmRSiv4iFAeN5xuU_vFpXj1GgfP5TEHVJ-5xREQvJ_4pCJGql0hR8E-ATakt_mg/exec";

function mustHaveUrl() {
  if (!GAS_URL) throw new Error("GAS_URL이 비어있습니다.");
}

async function jget(params) {
  mustHaveUrl();
  const url = `${GAS_URL}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function jpost(params) {
  mustHaveUrl();

  // ✅ form-url-encoded 로 보내면 preflight(OPTIONS) 없이 바로 POST됨
  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  });

  const res = await fetch(GAS_URL, {
    method: "POST",
    cache: "no-store",
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  try { return JSON.parse(text); } catch { return text; }
}

export function genRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export async function ping() {
  return await jget({ op: "ping" });
}

export async function getState(roomCode) {
  return await jget({ op: "state", room: String(roomCode) });
}

export async function setState(roomCode, state) {
  return await jpost({ op: "setState", roomCode: String(roomCode), state });
}

export async function patchState(roomCode, patch) {
  return await jpost({ op: "patchState", roomCode: String(roomCode), patch });
}

export async function pushAction(roomCode, action) {
  return await jpost({ op: "pushAction", roomCode: String(roomCode), action });
}

export async function pullActions(roomCode) {
  return await jget({ op: "actions", room: String(roomCode) });
}

export async function clearActions(roomCode, uptoId = null) {
  return await jpost({ op: "clearActions", roomCode: String(roomCode), uptoId });
}