'use strict';
// ═══ TEMPORAL SCOPE (Phase 2.2) ═══
// Beat accumulator — drives per-voice timing with independent multipliers.
// Extracted from voice-player.js (v3.0.0) since VoicePlayer is Gen2 legacy
// but TemporalScope is used by all pitch assistants + metronome.
function TemporalScope(multiplier){
  this.multiplier=multiplier;
  this.accumulator=0;
  this.frozen=false;
  this.muted=false;
}
TemporalScope.prototype.tick=function(dtMs){
  if(this.frozen||this.muted)return false;
  var bpm=TempoEngine.getEffectiveBPM()*this.multiplier;
  var beatsPerMs=bpm/60000;
  this.accumulator+=dtMs*beatsPerMs;
  if(this.accumulator>=1.0){this.accumulator-=1.0;return true;}
  return false;
};
