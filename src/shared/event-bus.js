'use strict';
// ═══ EVENTBUS (Phase 1.1 — pub/sub for Event-Action separation) ═══
var EventBus=(function(){
  var listeners={};
  function on(event,fn){if(!listeners[event])listeners[event]=[];listeners[event].push(fn);}
  function emit(event,data){
    var fns=listeners[event]||[];
    for(var i=0;i<fns.length;i++){
      try{fns[i](data);}catch(e){console.error('EventBus['+event+']:',e);}
    }
  }
  function off(event,fn){if(!listeners[event])return;listeners[event]=listeners[event].filter(function(f){return f!==fn;});}
  return{on:on,emit:emit,off:off};
})();
