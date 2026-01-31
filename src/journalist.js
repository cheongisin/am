export function journalistReveal(state, targetId){
  const p = state.players.find(p=>p.id===targetId);
  if(!p || !p.alive) return false;
  if(!state.journalistReveals.includes(targetId)){
    state.journalistReveals.push(targetId);
  }
  if(p.role) p.publicCard = p.role;
  return true;
}
