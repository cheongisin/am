let pc=null;
export let channel=null;
function mkPC(){ return new RTCPeerConnection({iceServers: []}); }

export async function hostCreate(onMsg, onConn){
  pc = mkPC();
  channel = pc.createDataChannel('mafia42');
  channel.onopen = ()=>onConn?.(true);
  channel.onclose = ()=>onConn?.(false);
  channel.onerror = ()=>onConn?.(false);
  channel.onmessage = e=>{ try{ onMsg(JSON.parse(e.data)); }catch{} };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  return JSON.stringify(offer);
}
export async function hostAcceptAnswer(answerJson){
  await pc.setRemoteDescription(JSON.parse(answerJson));
}
export async function displayJoin(offerJson, onMsg, onConn){
  pc = mkPC();
  pc.ondatachannel = e=>{
    channel = e.channel;
    channel.onopen = ()=>onConn?.(true);
    channel.onclose = ()=>onConn?.(false);
    channel.onerror = ()=>onConn?.(false);
    channel.onmessage = ev=>{ try{ onMsg(JSON.parse(ev.data)); }catch{} };
  };
  await pc.setRemoteDescription(JSON.parse(offerJson));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return JSON.stringify(answer);
}
export function send(msg){
  if(channel && channel.readyState==='open'){
    channel.send(JSON.stringify(msg));
  }
}
