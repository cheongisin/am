# Google Apps Script (웹 앱) 코드

> 이 파일의 코드를 그대로 붙여넣고 **웹 앱**으로 배포하세요.
> - 실행 사용자: 나
> - 액세스: 모든 사용자

```javascript
// Mafia42 State Sync API (GAS)
// - public_<roomCode>: 진행자(Display)용 공개 상태
// - private_<roomCode>: 사회자(Host)용 비공개 상태(역할/덱 포함)
// - actions_<roomCode>: (구버전 호환) 진행자 -> 사회자 액션 큐
// - JSONP(GET) 전용 (CORS 회피)

function key_(type, room){
  return type + '_' + room;
}

function jsonpOut_(obj, callback){
  var payload = JSON.stringify(obj || {});
  if(callback){
    return ContentService
      .createTextOutput(callback + '(' + payload + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}

function decodePayload_(raw){
  if(!raw) return {};
  try{
    var bytes = Utilities.base64DecodeWebSafe(raw);
    var json = Utilities.newBlob(bytes).getDataAsString('UTF-8');
    return JSON.parse(json || '{}');
  }catch(err){
    return {};
  }
}

function parseJson_(raw){
  if(!raw) return {};
  try{ return JSON.parse(raw); }catch(err){ return {}; }
}

function doGet(e){
  var params = e && e.parameter ? e.parameter : {};
  var op = (params.op||'').toLowerCase();
  var room = (params.room||'').trim();
  var callback = params.callback;
  var payload = decodePayload_(params.payload);

  if(op === 'ping'){
    return jsonpOut_({ok:true, now: Date.now()}, callback);
  }

  if(!room){
    return jsonpOut_({ok:false, error:'room required'}, callback);
  }

  var props = PropertiesService.getScriptProperties();

  // 공개 상태
  if(op === 'state'){
    var rawPublic = props.getProperty(key_('public', room));
    // 구버전 호환(state_<room>)
    if(!rawPublic) rawPublic = props.getProperty(key_('state', room));
    return jsonpOut_({ok:true, state: parseJson_(rawPublic)}, callback);
  }

  // 비공개 상태(토큰 기반. 필요 시 확장)
  if(op === 'private'){
    var token = (payload && payload.token) ? String(payload.token) : '';
    var savedToken = props.getProperty(key_('token', room));
    if(savedToken && token !== savedToken){
      return jsonpOut_({ok:false, error:'unauthorized'}, callback);
    }
    var rawPrivate = props.getProperty(key_('private', room));
    return jsonpOut_({ok:true, privateState: parseJson_(rawPrivate)}, callback);
  }

  if(op === 'actions'){
    var rawActions = props.getProperty(key_('actions', room));
    return jsonpOut_({ok:true, actions: parseJson_(rawActions) || []}, callback);
  }

  var lock = LockService.getScriptLock();
  try{
    lock.waitLock(10000);

    // 공개+비공개 동시 저장(권장)
    if(op === 'setboth'){
      var publicState = payload.publicState || {};
      var privateState = payload.privateState || {};
      props.setProperty(key_('public', room), JSON.stringify(publicState));
      props.setProperty(key_('private', room), JSON.stringify(privateState));
      return jsonpOut_({ok:true}, callback);
    }

    // DEAL 배정: 서버에서 원자 처리(배정 1회=요청 1회)
    if(op === 'dealpick'){
      var idx = Number(payload.cardIndex);
      var pid = Number(payload.playerId);
      if(!(idx >= 0) || !(pid >= 0)) return jsonpOut_({ok:false, error:'bad args'}, callback);

      var priv = parseJson_(props.getProperty(key_('private', room)));
      if(!priv || !priv.players) return jsonpOut_({ok:false, error:'no private state'}, callback);
      if(priv.phase !== 'DEAL') return jsonpOut_({ok:false, error:'not in DEAL'}, callback);
      if(!priv.deck || !priv.deckUsed) return jsonpOut_({ok:false, error:'no deck'}, callback);

      if(priv.deckUsed[idx]) return jsonpOut_({ok:false, error:'card used'}, callback);
      var p = priv.players[pid];
      if(!p || p.assigned) return jsonpOut_({ok:false, error:'player assigned'}, callback);

      var role = priv.deck[idx];
      priv.deckUsed[idx] = true;
      p.role = role;
      p.assigned = true;
      // 공개 카드 기본 유지
      if(!p.publicCard) p.publicCard = 'CITIZEN';
      if(typeof p.alive !== 'boolean') p.alive = true;

      priv.eventQueue = { token: Date.now(), events: [{ type:'DEAL_REVEAL', playerId: pid, role: role, cardIndex: idx }] };

      // 공개 상태 갱신(역할은 숨김)
      var pub = parseJson_(props.getProperty(key_('public', room)));
      if(!pub || typeof pub !== 'object') pub = {};
      pub.phase = priv.phase;
      pub.night = priv.night;
      pub.timer = priv.timer;
      pub.timerConfig = priv.timerConfig;
      pub.winner = priv.winner;
      pub.eventQueue = priv.eventQueue;
      pub.deckInfo = { count: (priv.deckUsed || []).length, used: priv.deckUsed };
      pub.players = (priv.players || []).map(function(pp){
        return {
          id: pp.id,
          name: pp.name,
          alive: pp.alive,
          assigned: pp.assigned,
          publicCard: pp.publicCard,
          terroristTarget: pp.terroristTarget,
          role: null
        };
      });

      props.setProperty(key_('private', room), JSON.stringify(priv));
      props.setProperty(key_('public', room), JSON.stringify(pub));
      return jsonpOut_({ok:true, state: pub, reveal: { playerId: pid, role: role, cardIndex: idx } }, callback);
    }

    if(op === 'setstate'){
      props.setProperty(key_('state', room), JSON.stringify(payload.state || {}));
      return jsonpOut_({ok:true}, callback);
    }

    if(op === 'patchstate'){
      var existing = parseJson_(props.getProperty(key_('state', room)));
      var patch = payload.patch || {};
      for(var k in patch){ existing[k] = patch[k]; }
      props.setProperty(key_('state', room), JSON.stringify(existing));
      return jsonpOut_({ok:true}, callback);
    }

    if(op === 'pushaction'){
      var arr = parseJson_(props.getProperty(key_('actions', room)));
      if(!Array.isArray(arr)) arr = [];
      var id = (arr.length ? arr[arr.length-1].id : 0) + 1;
      arr.push({id:id, msg: payload.action || {}});
      props.setProperty(key_('actions', room), JSON.stringify(arr));
      return jsonpOut_({ok:true, id:id}, callback);
    }

    if(op === 'clearactions'){
      var existingActions = parseJson_(props.getProperty(key_('actions', room)));
      if(!Array.isArray(existingActions)) existingActions = [];
      var upto = payload.uptoId;
      if(typeof upto !== 'number'){
        props.deleteProperty(key_('actions', room));
        return jsonpOut_({ok:true}, callback);
      }
      var remain = [];
      for(var i=0;i<existingActions.length;i++){
        if(existingActions[i].id > upto) remain.push(existingActions[i]);
      }
      if(remain.length) props.setProperty(key_('actions', room), JSON.stringify(remain));
      else props.deleteProperty(key_('actions', room));
      return jsonpOut_({ok:true}, callback);
    }

    return jsonpOut_({ok:false, error:'unknown op'}, callback);
  } catch(err) {
    return jsonpOut_({ok:false, error: String(err && err.message ? err.message : err)}, callback);
  } finally {
    try{ lock.releaseLock(); }catch(err){}
  }
}
```
