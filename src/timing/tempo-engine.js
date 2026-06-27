'use strict';
// ═══ TEMPO ENGINE (v2.1 — Thin Wrapper over PhaseCoupling Tempo Negotiation) ═══
//
// TempoEngine is now a facade over PhaseCoupling's 5-party tempo consensus.
// All tempo tracking, coupling, and consensus happens in PhaseCoupling.
//
// This module:
//   - Provides backward-compatible API (onHumanNote, getEffectiveBPM, etc.)
//   - Delegates to PhaseCoupling when available
//   - Falls back to manualBPM when PhaseCoupling isn't loaded yet
//
// The old L&J oscillator code has moved to PhaseCoupling.onHumanTempo().
// See phase-coupling.js "TEMPO NEGOTIATION" section for the full system.

var TempoEngine=(function(){
  var manualBPM=120;

  // ── onNote(role, time, isIndependent) ──
  // Unified entry point. Only independent sources feed tempo.
  function onNote(role,time,isIndependent){
    if(!isIndependent) return;
    if(typeof PhaseCoupling!=='undefined'){
      PhaseCoupling.onHumanTempo(time,role);
    }
  }

  // ── Backward-compatible wrapper ──
  function onHumanNote(time,register){
    onNote(register||'rhythm',time,true);
    _updateDisplay();
  }

  function getEffectiveBPM(){
    if(typeof PhaseCoupling!=='undefined'){
      return PhaseCoupling.getConsensusBPM();
    }
    return manualBPM;
  }

  function setManualBPM(v){
    manualBPM=v;
    if(typeof PhaseCoupling!=='undefined'){
      PhaseCoupling.setManualTempo(v);
    }
    try{document.getElementById('tempoDisp').textContent=Math.round(v);}catch(e){}
  }

  function reset(){
    if(typeof PhaseCoupling!=='undefined'){
      PhaseCoupling.setManualTempo(manualBPM);
    }
  }

  function getConfidence(){
    if(typeof PhaseCoupling!=='undefined'){
      return PhaseCoupling.getHumanConfidence();
    }
    return 0;
  }

  function _updateDisplay(){
    try{
      var disp=document.getElementById('tempoDisp');
      var conf=document.getElementById('tempoConf');
      var eff=getEffectiveBPM();
      disp.textContent=Math.round(eff);
      var c=getConfidence();
      if(c>0.3)disp.classList.add('inferred');else disp.classList.remove('inferred');
      conf.className='conf-dot'+(c>0.6?' high':c>0.3?' med':'');
    }catch(e){}
  }

  return{
    onNote:onNote,
    onHumanNote:onHumanNote,
    getEffectiveBPM:getEffectiveBPM,
    setManualBPM:setManualBPM,
    reset:reset,
    getConfidence:getConfidence,
    _updateDisplay:_updateDisplay
  };
})();

console.log('%cTempoEngine loaded (delegates to PhaseCoupling)', 'color:#af8;font-family:monospace');
