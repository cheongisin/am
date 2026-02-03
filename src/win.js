import {ROLE} from './constants.js';
export function checkWin(state){
  const alive = state.players.filter(p=>p.alive);
  const mafia = alive.filter(p=>p.role===ROLE.MAFIA || p.role===ROLE.SPY || p.role===ROLE.WEREWOLF || p.role===ROLE.MADAM).length;
  const citizen = alive.length - mafia;
  const hasPolitician = alive.some(p => p.role === ROLE.POLITICIAN);
  const effectiveCitizen = citizen + (hasPolitician ? 1 : 0);
  if(mafia===0) return 'CITIZEN';
  if(mafia>=effectiveCitizen) return 'MAFIA';
  return null;
}
