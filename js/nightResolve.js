import {ROLE} from '../src/constants.js';

export function resolveNight(state, draft){
  const dead = new Set();
  const events = [];
  const alive = (id)=> state.players[id]?.alive;

  const mafiaAttack = draft.mafiaId!=null && alive(draft.mafiaId) && draft.mafiaTarget!=null && alive(draft.mafiaTarget);
  const doctorSave = mafiaAttack && draft.doctorId!=null && alive(draft.doctorId) && draft.doctorTarget!=null && draft.doctorTarget === draft.mafiaTarget;

  if(mafiaAttack && !doctorSave) dead.add(draft.mafiaTarget);

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

  if(doctorSave) events.push({type:'DOCTOR_SAVE'});
  else if(dead.size>0){
    events.push({type:'MAFIA_KILL'});
    if(dead.size>1) events.push({type:'SPECIAL_KILL'});
  }

  let reporterRevealTarget = null;
  if(draft.reporterUsed && state.night>=2 && draft.reporterId!=null && alive(draft.reporterId) && !dead.has(draft.reporterId) && draft.reporterTarget!=null){
    events.push({type:'REPORTER_NEWS', targetId:draft.reporterTarget});
    reporterRevealTarget = draft.reporterTarget;
  }

  return {dead:[...dead], events, reporterRevealTarget};
}
