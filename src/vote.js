export function clearVotes(state){ state.votes = {}; }
export function vote(state, voterId, targetId){ state.votes[voterId] = targetId; }
export function tallyVotes(state){
  const tally = {};
  Object.values(state.votes).forEach(v=>{ if(v==null) return; tally[v]=(tally[v]||0)+1; });
  let max=0, target=null, tie=false;
  for(const k in tally){
    if(tally[k]>max){ max=tally[k]; target=k; tie=false; }
    else if(tally[k]===max){ tie=true; }
  }
  return tie ? null : target;
}
