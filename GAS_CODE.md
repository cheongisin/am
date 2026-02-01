# Google Apps Script (웹 앱) 코드

> 이 파일의 코드를 그대로 붙여넣고 **웹 앱**으로 배포하세요.
> - 실행 사용자: 나
> - 액세스: 모든 사용자

```javascript
// Mafia42 State Sync API (GAS)
// - state_<roomCode>: 방 상태(JSON)
// - actions_<roomCode>: 진행자 -> 사회자 액션 큐
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

  if(op === 'state'){
    var rawState = props.getProperty(key_('state', room));
    return jsonpOut_({ok:true, state: parseJson_(rawState)}, callback);
  }

  if(op === 'actions'){
    var rawActions = props.getProperty(key_('actions', room));
    return jsonpOut_({ok:true, actions: parseJson_(rawActions) || []}, callback);
  }

  var lock = LockService.getScriptLock();
  lock.tryLock(3000);
  try{
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
  } finally {
    try{ lock.releaseLock(); }catch(err){}
  }
}
```
