import {PHASE} from './constants.js';
import {snapshot} from './gameState.js';

export function nextPhase(state){
  snapshot(state);
  switch(state.phase){
    case PHASE.SETUP: state.phase = PHASE.DEAL; break;
    case PHASE.DEAL: state.phase = PHASE.NIGHT; break;
    case PHASE.NIGHT: state.phase = PHASE.DAY; break;
    case PHASE.DAY: state.phase = PHASE.VOTE; break;
    case PHASE.VOTE: state.phase = PHASE.EXECUTION; break;
    case PHASE.EXECUTION:
      state.night += 1;
      state.phase = PHASE.NIGHT;
      state.votes = {};
      state.executionTarget = null;
      break;
  }
}
