# Google Apps Script (웹 앱) 코드

> 이 파일의 코드를 그대로 붙여넣고 **웹 앱**으로 배포하세요.
> - 실행 사용자: 나
> - 액세스: 모든 사용자

```javascript
// Mafia42 State Sync API (GAS)
// - state_<roomCode>: 방 상태(JSON)
// - actions_<roomCode>: 진행자 -> 사회자 액션 큐

function jsonOut_(obj){
  return ContentService
    .createTextOutput(JSON.stringify(obj||{}))
    .setMimeType(ContentService.MimeType.JSON);
}

function key_(type, room){
  return type + '_' + room;
}

function doGet(e){
  var op = (e.parameter.op||'').toLowerCase();
  var room = (e.parameter.room||'').trim();
  if(!room) return jsonOut_({error:'room required'});

  var props = PropertiesService.getScriptProperties();
  if(op === 'state'){
    var raw = props.getProperty(key_('state', room));
    return ContentService
      .createTextOutput(raw || '')
      .setMimeType(ContentService.MimeType.JSON);
  }
  if(op === 'actions'){
    var a = props.getProperty(key_('actions', room));
    var arr = a ? JSON.parse(a) : [];
    return jsonOut_({actions: arr});
  }
  return jsonOut_({error:'unknown op'});
}

function doPost(e){
  var body = {};
  try{ body = JSON.parse(e.postData.contents); }catch(err){ return jsonOut_({error:'bad json'}); }
  var op = (body.op||'').toLowerCase();
  var room = (body.roomCode||'').trim();
  if(!room) return jsonOut_({error:'roomCode required'});

  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.tryLock(3000);
  try{
    if(op === 'setstate'){
      props.setProperty(key_('state', room), JSON.stringify(body.state||{}));
      return jsonOut_({ok:true});
    }

    if(op === 'patchstate'){
      var raw = props.getProperty(key_('state', room));
      var st = raw ? JSON.parse(raw) : {};
      var patch = body.patch || {};
      for(var k in patch){ st[k] = patch[k]; }
      props.setProperty(key_('state', room), JSON.stringify(st));
      return jsonOut_({ok:true});
    }

    if(op === 'pushaction'){
      var rawA = props.getProperty(key_('actions', room));
      var arr = rawA ? JSON.parse(rawA) : [];
      var id = (arr.length ? arr[arr.length-1].id : 0) + 1;
      arr.push({id:id, msg: body.action||{}});
      props.setProperty(key_('actions', room), JSON.stringify(arr));
      return jsonOut_({ok:true, id:id});
    }

    if(op === 'clearactions'){
      var rawB = props.getProperty(key_('actions', room));
      var arr2 = rawB ? JSON.parse(rawB) : [];
      var upto = body.uptoId;
      if(typeof upto !== 'number'){
        props.deleteProperty(key_('actions', room));
        return jsonOut_({ok:true});
      }
      var remain = [];
      for(var i=0;i<arr2.length;i++){
        if(arr2[i].id > upto) remain.push(arr2[i]);
      }
      if(remain.length) props.setProperty(key_('actions', room), JSON.stringify(remain));
      else props.deleteProperty(key_('actions', room));
      return jsonOut_({ok:true});
    }

    return jsonOut_({error:'unknown op'});
  } finally {
    try{ lock.releaseLock(); }catch(err){}
  }
}
```
