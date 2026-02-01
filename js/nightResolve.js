// am/js/nightResolve.js
import { ROLE } from '../src/constants.js';

/**
 * @param {object} state - game state (createGame 결과)
 * @param {object} draft - host.js에서 만든 nightDraft
 * @returns {{ dead:number[], events:any[], reporterRevealTarget:(number|null) }}
 */
export function resolveNight(state, draft){
  const events = [];
  const deadSet = new Set();

  const byId = (id) => state.players?.find(p => p.id === id) ?? null;
  const alive = (p) => !!p && p.alive;

  // draft 값 정리
  const mafiaTargetId = (draft?.mafiaTarget ?? null);
  const doctorTargetId = (draft?.doctorTarget ?? null);
  const terroristTargetId = (draft?.terroristTarget ?? null);

  // 테러리스트 지목값은 상태에 저장(다음에 쓰기 위해)
  if (draft?.terroristId != null) {
    const t = byId(draft.terroristId);
    if (t) t.terroristTarget = terroristTargetId ?? null;
  }

  // 1) 마피아 공격 처리
  let mafiaVictim = mafiaTargetId != null ? byId(mafiaTargetId) : null;

  if (alive(mafiaVictim)) {
    const victimId = mafiaVictim.id;

    // 의사 보호 성공
    if (doctorTargetId != null && doctorTargetId === victimId) {
      events.push({ type: 'DOCTOR_SAVE', targetId: victimId });
    } else {
      // 군인(ARMY) 1회 방어(armorUsed) 처리
      if (mafiaVictim.role === ROLE.ARMY && !mafiaVictim.armorUsed) {
        mafiaVictim.armorUsed = true;
        events.push({ type: 'ARMY_SAVE', targetId: victimId });
      } else {
        deadSet.add(victimId);
        events.push({ type: 'MAFIA_KILL', targetId: victimId });
      }
    }
  }

  // 2) 테러리스트가 이번 밤에 죽었으면 연쇄 살인(지목 대상)
  // - “테러리스트가 죽는 경우”는 일단 마피아에게 죽었을 때로 처리
  // - (다른 사유로 죽는 로직이 있으면 deadSet에 테러리스트 id가 추가되면 동일하게 작동)
  const terrorist = state.players?.find(p => p.role === ROLE.TERRORIST) ?? null;
  const terroristDiesTonight = terrorist && deadSet.has(terrorist.id);

  if (terroristDiesTonight) {
    const targetId = terrorist.terroristTarget ?? null;
    const target = targetId != null ? byId(targetId) : null;

    if (alive(target) && !deadSet.has(target.id)) {
      deadSet.add(target.id);
      events.push({
        type: 'TERROR_CHAIN',
        terroristId: terrorist.id,
        targetId: target.id
      });
    }
  }

  // 3) 기자(특보) 공개 예약값 반환
  // - host.js에서 night>=2 && state.reporterUsedOnce 체크하므로 여기서는 최종만 반영
  let reporterRevealTarget = null;
  if (draft?.reporterUsed && draft?.reporterTarget != null) {
    reporterRevealTarget = Number(draft.reporterTarget);
    // 사용 처리(중복 방지)
    state.reporterUsedOnce = true;
  }

  return {
    dead: Array.from(deadSet),
    events,
    reporterRevealTarget
  };
}