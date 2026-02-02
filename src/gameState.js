import {PHASE} from './constants.js';

export function createGame(players){
  return {
    phase: PHASE.SETUP,
    night: 1,
    timer: {mode: 'STOPPED', durationSec: 0, endAt: null, running: false},
    timerConfig: {daySec: 300},
    players: players.map(p=>({
      id:p.id,
      name:p.name,
      role: p.role ?? null,
      publicCard: 'CITIZEN',
      alive: true,
      assigned: false,
      armorUsed: false,
      terroristTarget: null
    })),
    deck: null,
    deckUsed: null,
    votes: {},
    executionTarget: null,
    journalistReveals: [],
    reporterUsedOnce: false,
    // 출력(태블릿) 연출용 이벤트 큐
    eventQueue: { token: 0, events: [] },
    winner: null,
    history: []
  };
}

export function snapshot(state){
  state.history.push(JSON.parse(JSON.stringify({
    phase: state.phase,
    night: state.night,
    timer: state.timer,
    timerConfig: state.timerConfig,
    players: state.players,
    deck: state.deck,
    deckUsed: state.deckUsed,
    votes: state.votes,
    executionTarget: state.executionTarget,
    journalistReveals: state.journalistReveals,
    reporterUsedOnce: state.reporterUsedOnce,
    eventQueue: state.eventQueue,
    winner: state.winner
  })));
  if(state.history.length>40) state.history.shift();
}

export function undo(state){
  if(state.history.length===0) return false;
  const prev = state.history.pop();
  Object.assign(state, prev, {history: state.history});
  return true;
}

export function publicState(state){
  return {
    phase: state.phase,
    night: state.night,
    timer: state.timer,
    timerConfig: state.timerConfig,
    players: state.players.map(p=>({
      id:p.id,
      name:p.name,
      alive:p.alive,
      assigned:p.assigned,
      publicCard:p.publicCard,
      terroristTarget:p.terroristTarget,
      role: state.winner ? p.role : null
    })),
    deckInfo: state.deckUsed ? {count: state.deckUsed.length, used: state.deckUsed} : null,
    votes: state.votes,
    executionTarget: state.executionTarget,
    journalistReveals: state.journalistReveals,
    reporterUsedOnce: state.reporterUsedOnce,
    eventQueue: state.eventQueue,
    winner: state.winner
  };
}
