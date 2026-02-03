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
  const werewolfMarkTargetId = (draft?.werewolfMarkTarget ?? null);
  const madamMarkTargetId = (draft?.madamMarkTarget ?? null);
  const vigilantePurgeTargetId = (draft?.vigilantePurgeTarget ?? null);

  // 테러리스트 지목값은 상태에 저장(다음에 쓰기 위해)
  if (draft?.terroristId != null) {
    const t = byId(draft.terroristId);
    if (t) t.terroristTarget = terroristTargetId ?? null;
  }

  // 1) 마피아 공격 처리 (우선순위: 의사 > 군인 > 킬)
  // - 의사 보호와 군인 방어가 겹치면(군인이면서 의사 보호) ARMY_SAVE는 발동하지 않는다.
  let mafiaOutcome = 'NONE'; // 'NONE' | 'DOCTOR_SAVE' | 'ARMY_SAVE' | 'MAFIA_KILL' | 'WEREWOLF_THIRST' | 'NOTHING'
  const mafiaVictim = mafiaTargetId != null ? byId(mafiaTargetId) : null;

  const werewolf = state.players?.find(p => p.role === ROLE.WEREWOLF) ?? null;
  const werewolfAlive = alive(werewolf);

  // 갈망은 '짐승인간 생존 + 접선 성공'에서만 의미가 있으므로,
  // 짐승인간이 사망했다면 접선 상태를 해제한다.
  if (!werewolfAlive) state.werewolfContact = false;

  // 짐승인간 접선 조건: (짐승인간이 표식한 대상) === (마피아 지목 대상)
  const contactThisNight = werewolfAlive
    && werewolfMarkTargetId != null
    && mafiaTargetId != null
    && Number(werewolfMarkTargetId) === Number(mafiaTargetId);
  if (contactThisNight) state.werewolfContact = true;

  const thirstActive = !!state.werewolfContact && werewolfAlive;

  // 마담 표식: 표식된 대상의 능력을 '다음 밤 전까지' 봉인
  const madam = state.players?.find(p => p.role === ROLE.MADAM) ?? null;
  const madamAlive = alive(madam);

  if (madamAlive && madamMarkTargetId != null) {
    const sealTarget = byId(Number(madamMarkTargetId));
    if (alive(sealTarget)) {
      // 밤 N에 봉인되면, 밤 N의 낮/투표/처형까지 유지되고 밤 N+1 시작 시 자동 만료
      sealTarget.sealedUntilNight = Math.max(Number(sealTarget.sealedUntilNight || 0), Number(state.night || 0) + 1);
    }
  }

  if (alive(mafiaVictim)) {
    const victimId = mafiaVictim.id;

    // (특수) 짐승인간 갈망: 세이브 무시, 확정 처형
    // - 접선 이후(thirstActive)부터 마피아 처형은 갈망으로 처리
    // - 다만, 마피아 처형 대상이 짐승인간이면 죽지 않고 NOTHING 연출
    if (thirstActive) {
      if (mafiaVictim.role === ROLE.WEREWOLF) {
        mafiaOutcome = 'NOTHING';
        events.push({ type: 'NOTHING', reason: 'WEREWOLF_IMMUNE' });
      } else {
        mafiaOutcome = 'WEREWOLF_THIRST';
        deadSet.add(victimId);
        events.push({ type: 'WEREWOLF_THIRST', targetId: victimId });
      }
    } else {
      if (doctorTargetId != null && doctorTargetId === victimId) {
        mafiaOutcome = 'DOCTOR_SAVE';
        events.push({ type: 'DOCTOR_SAVE', targetId: victimId });
      } else if ((mafiaVictim.role === ROLE.ARMY || mafiaVictim.role === ROLE.SOLDIER) && !mafiaVictim.armorUsed) {
        mafiaVictim.armorUsed = true;
        // 방어 성공은 군인임이 공개되며 이후에도 유지
        mafiaVictim.publicCard = ROLE.ARMY;
        mafiaOutcome = 'ARMY_SAVE';
        events.push({ type: 'ARMY_SAVE', targetId: victimId });
      } else {
        if (mafiaVictim.role === ROLE.WEREWOLF) {
          mafiaOutcome = 'NOTHING';
          events.push({ type: 'NOTHING', reason: 'WEREWOLF_IMMUNE' });
        } else {
          mafiaOutcome = 'MAFIA_KILL';
          deadSet.add(victimId);
          events.push({ type: 'MAFIA_KILL', targetId: victimId });
        }
      }
    }
  }

  // 2) 테러리스트 Self-destruct(자폭, 상호 선택)
  // - 조건(강화):
  //   (a) 테러리스트가 밤에 마피아팀(MAFIA+SPY)을 지목했고
  //   (b) 마피아 공격 대상이 테러리스트인 경우(서로 선택)
  // - 우선순위: DOCTOR_SAVE / ARMY_SAVE 이후에만 고려하며,
  //   발동 시 MAFIA_KILL 연출 대신 자폭 연출을 사용한다.
  const terrorist = state.players?.find(p => p.role === ROLE.TERRORIST) ?? null;
  const terroristAlive = alive(terrorist);
  const tTargetId = terroristTargetId != null ? terroristTargetId : (terrorist?.terroristTarget ?? null);
  const tTarget = tTargetId != null ? byId(tTargetId) : null;
  const isMafiaTeam = (pp) => !!pp && (pp.role === ROLE.MAFIA || pp.role === ROLE.SPY || pp.role === ROLE.WEREWOLF || pp.role === ROLE.MADAM);

  const mafiaPickedTerrorist = (mafiaVictim?.id != null && terrorist?.id != null && mafiaVictim.id === terrorist.id);
  const canConsiderSelfDestruct = (mafiaOutcome !== 'DOCTOR_SAVE' && mafiaOutcome !== 'ARMY_SAVE');
  if (canConsiderSelfDestruct && terroristAlive && mafiaPickedTerrorist && alive(tTarget) && isMafiaTeam(tTarget)) {
    // 기존 MAFIA_KILL 연출은 제거하고 자폭 연출로 대체
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'MAFIA_KILL' && Number(events[i]?.targetId) === Number(terrorist.id)) {
        events.splice(i, 1);
        break;
      }
    }
    deadSet.add(terrorist.id);
    deadSet.add(tTarget.id);

    // 자폭은 양쪽 직업이 즉시 공개되어야 한다(사망 카드 반영용)
    terrorist.publicCard = ROLE.TERRORIST;
    // 대상은 마피아팀(MAFIA/SPY) 중 실제 직업을 공개
    tTarget.publicCard = tTarget.role;

    events.push({ type: 'TERROR_SELF_DESTRUCT', terroristId: terrorist.id, targetId: tTarget.id });
  }

  // 2.5) 자경단원 숙청(1회)
  // - 조건1: 자경단원이 마피아 처형 대상이 아니어야 발동
  // - 조건2: 마피아 처형(또는 관련 연출) 이후에 출력
  const vigilante = state.players?.find(p => p.role === ROLE.VIGILANTE) ?? null;
  const vigilanteAlive = alive(vigilante);
  const mafiaPickedVigilante = (vigilante?.id != null && mafiaTargetId != null && Number(vigilante.id) === Number(mafiaTargetId));
  const purgeRequested = !!draft?.vigilantePurgeUsed && vigilantePurgeTargetId != null;
  if (purgeRequested && vigilanteAlive && !state.vigilanteUsedOnce && !mafiaPickedVigilante) {
    state.vigilanteUsedOnce = true;
    const tgt = byId(vigilantePurgeTargetId);
    if (alive(tgt) && isMafiaTeam(tgt)) {
      deadSet.add(tgt.id);
      events.push({ type: 'VIGILANTE_PURGE', targetId: tgt.id });
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

  // 4) 기자 특종(연출용 이벤트는 항상 맨 마지막)
  if (reporterRevealTarget != null) {
    const target = byId(reporterRevealTarget);
    const role = target?.role ?? null;
    events.push({ type: 'REPORTER_NEWS', targetId: reporterRevealTarget, role });
  }

  // 5) 아무 일도 없음
  if (events.length === 0) {
    events.push({ type: 'NOTHING' });
  }

  return {
    dead: Array.from(deadSet),
    events,
    reporterRevealTarget
  };
}