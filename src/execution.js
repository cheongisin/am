import {ROLE} from './constants.js';

export function execute(state, targetId){
  const t = state.players.find(p=>p.id==targetId);
  if(!t || !t.alive) return {executed:[], chain:[]};
  t.alive=false;
  const executed=[t.id];
  const chain=[];
  if(t.role===ROLE.TERRORIST && t.terroristTarget!=null){
    const x = state.players.find(p=>p.id===t.terroristTarget);
    if(x && x.alive){ x.alive=false; chain.push(x.id); }
  }
  return {executed, chain};
}
