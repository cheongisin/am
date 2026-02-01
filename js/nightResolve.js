import {ROLE} from '../src/constants.js';

export function resolveNight(state, draft){
  const dead = new Set();
  const events = [];
  const alive = (id)=> state.players[id]?.alive;

  const mafiaAttack = draft.mafiaId!=null && alive(draft.mafiaId) && draft.mafiaTarget!=null && alive(draft.mafiaTarget);
  const doctorSave = mafiaAttack && draft.doctorId!=null && alive(draft.doctorId) && draft.doctorTarget!=null && draft.doctorTarget === draft.mafiaTarget;
  const targetPlayer = mafiaAttack ? state.players[draft.mafiaTarget] : null;
  const bulletproofTarget = targetPlayer && [ROLE.SOLDIER, ROLE.ARMY].includes(targetPlayer.role);
  const bulletproofReady = bulletproofTarget && !targetPlayer.armorUsed;
  const bulletproofSave = mafiaAttack && bulletproofReady && !doctorSave;

  if(mafiaAttack && !doctorSave && !bulletproofSave) dead.add(draft.mafiaTarget);
  if(bulletproofSave && targetPlayer){
    targetPlayer.armorUsed = true;
    events.push({type:'ARMY_SAVE', savedId: targetPlayer.id});
  }

  if(draft.terroristId!=null && alive(draft.terroristId)){
    const terr = state.players[draft.terroristId];
    terr.terroristTarget = (draft.terroristTarget ?? null);
  }

  const terrDies = draft.terroristId!=null && alive(draft.terroristId) && dead.has(draft.terroristId);
  if(terrDies){
    const tt = draft.terroristTarget;
    const target = tt!=null ? state.players[tt] : null;
    if(target && target.role===ROLE.MAFIA && draft.mafiaTarget===draft.terroristId){
      dead.add(tt);
    }
  }

  if(doctorSave) events.push({type:'DOCTOR_SAVE', savedId: draft.mafiaTarget});
  else if(dead.size>0){
    const victimId = [...dead][0];
    events.push({type:'MAFIA_KILL', victimId});
    if(dead.size>1) events.push({type:'SPECIAL_KILL'});
  }

  let reporterRevealTarget = null;
  if(draft.reporterUsed && !state.reporterUsedOnce && state.night>=2 && draft.reporterId!=null && alive(draft.reporterId) && !dead.has(draft.reporterId) && draft.reporterTarget!=null){
    const target = state.players[draft.reporterTarget];
    events.push({type:'REPORTER_NEWS', targetId:draft.reporterTarget, role: target?.role || null});
    reporterRevealTarget = draft.reporterTarget;
    state.reporterUsedOnce = true;
  }

  return {dead:[...dead], events, reporterRevealTarget};
}
