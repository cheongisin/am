import {ROLE} from './constants.js';
export function checkWin(state){
  const alive = state.players.filter(p=>p.alive);
  const mafia = alive.filter(p=>p.role===ROLE.MAFIA).length;
  const citizen = alive.length - mafia;
  if(mafia===0) return 'CITIZEN';
  if(mafia>=citizen) return 'MAFIA';
  return null;
}
