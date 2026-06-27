'use strict';
// v9.2.0: TemporalScope duplicate removed — canonical definition in timing/temporal-scope.js

// ═══ VOICE PLAYER (Phase 1.3 + 4.1-4.4) ═══
function VoicePlayer(register,scopeMultiplier){
  this.register=register; // 'bass','rhythm','soloist'
  this.scope=new TemporalScope(scopeMultiplier);
  this.stm={
    pitch:new PPMTrie(4),interval:new PPMTrie(3),sd:new PPMTrie(3),
    contour:new PPMTrie(4),linked:new PPMTrie(3),recent:[]
  };
  this.currentNote=null;
  this.playstring=null;
  this.playstringIdx=0;
  this.crossNotes=[]; // latest notes from other voices
}

VoicePlayer.prototype.observeNote=function(pc){
  var prev=this.currentNote;
  this.stm.pitch.observe(pc);
  if(prev!==null){
    var interval=((pc-prev)%12+12)%12;if(interval>6)interval-=12;
    this.stm.interval.observe(interval+12);
    this.stm.contour.observe(pc>prev?2:pc<prev?0:1);
    var sd=((pc-SharedState.keyC)%12+12)%12;
    this.stm.linked.observe((interval+12)*12+sd);
  }
  this.stm.sd.observe(((pc-SharedState.keyC)%12+12)%12);
  this.currentNote=pc;
  this.stm.recent.push(pc);if(this.stm.recent.length>16)this.stm.recent.shift();
};

VoicePlayer.prototype.predict=function(){
  if(this.currentNote===null)return new Float64Array(12).fill(1/12);
  return SharedState.predict(this.currentNote,this.stm,SharedState.genre);
};

// Phase 4.1: Playstring generation
VoicePlayer.prototype.generatePlaystring=function(){
  var gc=getGenreConfig(SharedState.genre);
  var len=Math.max(2,Math.round(gc.phraseLen*({bass:.5,rhythm:.8,soloist:1.2}[this.register]||1)));
  var plan=[],simCtx=this.stm.pitch.cloneContext();
  var simPC=this.currentNote!==null?this.currentNote:SharedState.keyC;
  
  for(var i=0;i<len;i++){
    var probs=SharedState.predict(simPC,this.stm,SharedState.genre);
    
    // Phase 4.2: Phrase arc shaping
    var arcPos=i/len;
    var tension=arcPos<0.6?arcPos/0.6:1-(arcPos-0.6)/0.4;
    // Modulate temperature by arc
    var arcTemp=0.8+tension*0.5; // 0.8 at edges, 1.3 at peak
    
    // Boost tonic at end, dominant in middle
    probs[SharedState.keyC]*=(1-tension)*0.3+1;
    probs[(SharedState.keyC+7)%12]*=tension*0.3+1;
    
    // Normalize
    var s=0;for(var t=0;t<12;t++)s+=probs[t];if(s>0)for(var t=0;t<12;t++)probs[t]/=s;
    
    var chosen=tempSample(probs,arcTemp*getBaseTemperature());
    
    // Phase 4.4: Cross-voice consonance check
    for(var cv=0;cv<this.crossNotes.length;cv++){
      var diff=Math.abs(chosen-this.crossNotes[cv]);
      if(diff===1||diff===11){// minor 2nd clash
        // Resample avoiding the clash
        probs[chosen]*=0.2;
        s=0;for(var t=0;t<12;t++)s+=probs[t];if(s>0)for(var t=0;t<12;t++)probs[t]/=s;
        chosen=tempSample(probs,arcTemp*getBaseTemperature());
        break;
      }
    }
    
    plan.push({pc:chosen,confidence:probs[chosen]});
    simCtx.observe(chosen);simPC=chosen;
  }
  return plan;
};

// Phase 4.3: Should replan?
VoicePlayer.prototype.shouldReplan=function(event){
  if(!this.playstring||this.playstringIdx>=this.playstring.length)return true;
  var gc=getGenreConfig(SharedState.genre);
  if(event&&event.type==='chordChanged')return Math.random()>(gc.replanThresh-0.3);
  if(event&&event.type==='keyChanged')return true;
  return false;
};

VoicePlayer.prototype.onTick=function(){
  if(this.scope.muted||this.scope.frozen)return null;
  if(!this.playstring||this.playstringIdx>=this.playstring.length){
    this.playstring=this.generatePlaystring();
    this.playstringIdx=0;
  }
  var planned=this.playstring[this.playstringIdx];
  this.playstringIdx++;
  return planned.pc;
};

VoicePlayer.prototype.reset=function(){
  this.stm.pitch.reset();this.stm.interval.reset();this.stm.sd.reset();
  this.stm.contour.reset();this.stm.linked.reset();this.stm.recent=[];
  this.currentNote=null;this.playstring=null;this.playstringIdx=0;
};

// Temperature helpers
function getBaseTemperature(){
  var manual=(+document.getElementById('tempSlider').value)/100;
  return 0.1+manual*2.4;
}

// [BUG #8 FIX] Complementary temperature respects manual as ceiling
function getComplementaryTemp(){
  var humanAdv=SharedState.getHumanAdventurousness();
  var manual=getBaseTemperature();
  var complement=0.3+(1-humanAdv)*1.0;
  // Manual is ceiling: system can push but never exceed 1.5x manual
  return Math.min(manual*1.5,complement);
}

function tempSample(probs,temperature){
  if(typeof AssistantShared!=='undefined')return AssistantShared.tempSample(probs,temperature);
  var tp=new Float64Array(12);
  for(var i=0;i<12;i++)tp[i]=Math.pow(Math.max(probs[i],.0001),1/Math.max(0.1,temperature));
  var tw=0;for(var i=0;i<12;i++)tw+=tp[i];
  if(tw<.001)return(SharedState.keyC+7)%12;
  var r=Math.random()*tw;
  for(var i=0;i<12;i++){r-=tp[i];if(r<=0)return i;}
  return 0;
}
