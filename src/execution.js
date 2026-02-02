import {ROLE} from './constants.js';

export function execute(state, targetId){
  const t = state.players.find(p=>p.id==targetId);
  if(!t || !t.alive) return {executed:[], chain:[]};
  t.alive=false;
  const executed=[t.id];
  const chain=[];
  return {executed, chain};
}
