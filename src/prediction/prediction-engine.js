'use strict';
// ═══ SHARED PREDICTION ENGINE (with all 11 bug fixes) ═══
// This is a SHARED module — key detection, chord detection, theory prior
// Individual voices have their own STM tries but share LTM and key/chord state
var SharedState=(function(){
  // Krumhansl-Schmuckler key profiles
  var MAJOR_PROF=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  var MINOR_PROF=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  
  var keyC=0,mode='minor',genre='pop';
  var autoKeyNotes=[],pendingKey=0,pendingMode='major';

  // ── Voice-weighted key histogram (Berlin School: bass defines root) ──
  var weightedKeyHist=new Float64Array(12);
  var weightedKeyCount=0;
  var VOICE_KEY_WEIGHT={bass:2.5,rhythm:1.0,soloist:0.5,human:1.5};
  var _keyDistCache=null; // invalidated on any key note update
  var currentChord=null;
  // v9.2.0: chordTrie removed (was observed but never queried — dead PPMTrie)
  var phraseIC=[],phraseStrength=0,lastNoteTime=0;
  var humanIC=[],lastHumanNotes=[];

  // ── Surprise Thermostat (Phase A — Hierarchical Prediction) ──
  var surpriseHistory=[];
  var _surpriseTarget=typeof SURPRISE_TARGET!=='undefined'?SURPRISE_TARGET:0.45;
  var _surpriseWindow=typeof SURPRISE_WINDOW!=='undefined'?SURPRISE_WINDOW:20;
  var _surpriseGain=typeof SURPRISE_GAIN!=='undefined'?SURPRISE_GAIN:0.3;

  function getTemperatureAdjust(){
    if(surpriseHistory.length<3)return 0;
    var avg=surpriseHistory.reduce(function(a,b){return a+b;},0)/surpriseHistory.length;
    return(_surpriseTarget-avg)*_surpriseGain;
  }
  function getSurpriseAvg(){
    if(surpriseHistory.length===0)return 0;
    return surpriseHistory.reduce(function(a,b){return a+b;},0)/surpriseHistory.length;
  }
  // Expose recent IC values for surprise-delta computation (observation channel)
  function getRecentSurprises(n){
    n=n||10;
    return surpriseHistory.slice(-n);
  }
  
  // LTM state
  var ltm={pitch:null,interval:null,sd:null,contour:null,linked:null};
  var ltmLoaded=false;
  
  function detectKey(notes){
    if(notes.length<8)return null;
    var hist=Array(12).fill(0);notes.forEach(function(n){hist[n%12]++;});
    var bestKey=0,bestScore=-Infinity,bestMode='major';
    for(var k=0;k<12;k++){var majS=0,minS=0;
      for(var i=0;i<12;i++){majS+=hist[(k+i)%12]*MAJOR_PROF[i];minS+=hist[(k+i)%12]*MINOR_PROF[i];}
      if(majS>bestScore){bestScore=majS;bestKey=k;bestMode='major';}
      if(minS>bestScore){bestScore=minS;bestKey=k;bestMode='minor';}}
    return{key:bestKey,mode:bestMode};
  }
  
  function updateKey(pc){
    autoKeyNotes.push(pc);if(autoKeyNotes.length>20)autoKeyNotes.shift();
    _keyDistCache=null; // invalidate distribution cache
    if(autoKeyNotes.length>=8){
      var det=detectKey(autoKeyNotes);
      if(det){var newKey=det.key,newMode=det.mode;
        if(newKey===pendingKey&&newMode===pendingMode){
          if(newKey!==keyC||newMode!==mode){keyC=newKey;mode=newMode;
            EventBus.emit('keyChanged',{key:keyC,mode:mode});}}
        pendingKey=newKey;pendingMode=newMode;}}
  }
  
  // [BUG #6] Phrase boundary detection improved
  function updatePhraseBoundary(pc,stmTotal){
    var now=Date.now();
    if(stmTotal>5){
      var ic=4; // default moderate IC
      // Simple IC estimate from shared key context
      var scNotes=getScale(keyC,mode);
      ic=scNotes.indexOf(pc)>=0?2:6; // very rough: in-scale=low IC, chromatic=high
      phraseIC.push(ic);
      if(phraseIC.length>20)phraseIC.shift();
      var silenceGap=now-lastNoteTime;
      var bpm=TempoEngine.getEffectiveBPM();
      var beatMs=60000/Math.max(30,bpm);
      if(phraseIC.length>4){
        var recent5=phraseIC.slice(-5,-1);
        var avg=recent5.reduce(function(a,b){return a+b},0)/recent5.length;
        var variance=recent5.reduce(function(a,b){return a+(b-avg)*(b-avg)},0)/recent5.length;
        var stdev=Math.sqrt(variance);
        // [BUG #6] Use stdev, longer silence threshold, float strength
        var icTrigger=ic>avg+1.5*Math.max(stdev,0.5);
        var silenceTrigger=silenceGap>beatMs*1.5;
        if(icTrigger||silenceTrigger){
          var icStrength=icTrigger?Math.min(1,(ic-avg)/(stdev+.5)*.3):0;
          var silStrength=silenceTrigger?Math.min(1,(silenceGap-beatMs)/(beatMs*2)):0;
          phraseStrength=Math.min(1,icStrength+silStrength);
          EventBus.emit('phraseBoundary',{strength:phraseStrength});
        }else{phraseStrength*=0.8;} // decay
      }
    }
    lastNoteTime=now;
  }
  
  var ltmCache={};
  function applyLTMData(data){
    // Format guard: skip lexicon files (they have bass_lexicon, not pitch tries)
    if(data.bass_lexicon||data.rhythm_lexicon||data.solo_lexicon){
      console.log('LTM skip: lexicon file (not a trie export)');ltmLoaded=false;return;
    }
    // Format guard: skip if not a valid trie export
    if(!data.pitch||!data.pitch.t){
      console.log('LTM skip: not a trie export');ltmLoaded=false;return;
    }
    try{
      ltm.pitch=new PPMTrie(4);ltm.pitch.loadFromJSON(data.pitch);
      ltm.interval=new PPMTrie(3);ltm.interval.loadFromJSON(data.interval);
      ltm.sd=new PPMTrie(3);ltm.sd.loadFromJSON(data.sd);
      ltm.contour=new PPMTrie(4);ltm.contour.loadFromJSON(data.contour);
      ltm.linked=new PPMTrie(3);ltm.linked.loadFromJSON(data.linked);
      ltmLoaded=true;
    }catch(e){console.log('LTM load error: '+e.message);ltmLoaded=false;}
    try{document.getElementById('bLoadLTM').style.color='';}catch(x){}
  }
  function loadLTMFromJSON(name,data){ltmCache[name]=data;console.log('LTM cached: '+name);}
  function loadLTM(g){
    genre=g;
    if(ltmCache[g]){applyLTMData(ltmCache[g]);console.log('LTM from cache: '+g);return;}
    var path='data/ltm/'+g+'.json';
    fetch(path).then(function(r){if(!r.ok){ltmLoaded=false;try{document.getElementById('bLoadLTM').style.color='#d4b040';}catch(x){}return null;}return r.json();})
    .then(function(data){
      if(!data)return;
      ltmCache[g]=data;
      applyLTMData(data);
      console.log('LTM loaded: '+g+' — '+data.meta.melodies+' melodies, '+data.meta.notes+' notes');
    }).catch(function(e){console.log('LTM unavailable: '+e.message);ltmLoaded=false;});
  }
  
  function blendLTMSTM(ltmP,stmP,size){
    var result=new Float64Array(size);
    function ent(p,n){var h=0;for(var i=0;i<n;i++)if(p[i]>0)h-=p[i]*Math.log2(p[i]);return h;}
    var maxE=Math.log2(size),ltmC=Math.max(.01,maxE-ent(ltmP,size)),stmC=Math.max(.01,maxE-ent(stmP,size)),tw=ltmC+stmC;
    for(var i=0;i<size;i++)result[i]=(ltmP[i]*ltmC+stmP[i]*stmC)/tw;
    return result;
  }
  
  // Predict function with ALL bug fixes applied
  function predict(cur,stmTries,voiceGenre){
    var g=voiceGenre||genre;
    var gc=getGenreConfig(g);
    var sc=new Set(getScale(keyC,mode));
    var probs=new Float64Array(12);
    
    // Viewpoint 1: Pitch PPM
    var stmPitch=stmTries.pitch.predict(12);
    var ppmProbs=ltmLoaded&&ltm.pitch?blendLTMSTM(ltm.pitch.predict(12),stmPitch,12):stmPitch;
    
    // Viewpoint 2: Interval PPM
    var stmInt=stmTries.interval.predict(25);
    var rawInt=ltmLoaded&&ltm.interval?blendLTMSTM(ltm.interval.predict(25),stmInt,25):stmInt;
    var intMapped=new Float64Array(12);
    for(var t=0;t<12;t++){var interval=((t-cur)%12+12)%12;if(interval>6)interval-=12;var idx=interval+12;
      if(idx>=0&&idx<25)intMapped[t]+=rawInt[idx];}
    
    // Viewpoint 3: Scale degree PPM
    var stmSD=stmTries.sd.predict(12);
    var rawSD=ltmLoaded&&ltm.sd?blendLTMSTM(ltm.sd.predict(12),stmSD,12):stmSD;
    var sdMapped=new Float64Array(12);
    for(var t=0;t<12;t++)sdMapped[t]=rawSD[((t-keyC)%12+12)%12];
    
    // Viewpoint 4: Contour PPM (used in combination only)
    // [BUG #1 FIX] contour is only used in entropy-weighted blend, NOT applied again as post-processing
    
    // Viewpoint 5: Linked
    var stmLinked=stmTries.linked.predict(300);
    var rawLinked=ltmLoaded&&ltm.linked?blendLTMSTM(ltm.linked.predict(300),stmLinked,300):stmLinked;
    var linkedMapped=new Float64Array(12);
    for(var t=0;t<12;t++){var interval2=((t-cur)%12+12)%12;if(interval2>6)interval2-=12;
      var sd2=((t-keyC)%12+12)%12;var lIdx=(interval2+12)*12+sd2;
      if(lIdx>=0&&lIdx<300)linkedMapped[t]+=rawLinked[lIdx];}
    
    // Entropy-weighted combination
    function entropy(p,len){var h=0;for(var i=0;i<len;i++)if(p[i]>0)h-=p[i]*Math.log2(p[i]);return h;}
    var maxEnt=Math.log2(12);
    var ppmConf=Math.max(.01,maxEnt-entropy(ppmProbs,12));
    var intConf=Math.max(.01,maxEnt-entropy(intMapped,12));
    var sdConf=Math.max(.01,maxEnt-entropy(sdMapped,12));
    var linkedConf=Math.max(.01,maxEnt-entropy(linkedMapped,12));
    var totalConf=ppmConf+intConf+sdConf+linkedConf;
    for(var t=0;t<12;t++)probs[t]=(ppmProbs[t]*ppmConf+intMapped[t]*intConf+sdMapped[t]*sdConf+linkedMapped[t]*linkedConf)/totalConf;
    
    // [BUG #1 FIX] NO post-combination contour bias — contour PPM already contributed through blend
    
    // Chord conditioning [BUG #4 FIX: weighted root>5th>3rd]
    if(currentChord){
      var chRoot=currentChord.rootPC;
      var chThird=(chRoot+(currentChord.type==='major'?4:3))%12;
      var chFifth=(chRoot+7)%12;
      probs[chRoot]*=1.6; probs[chFifth]*=1.3; probs[chThird]*=1.15;
      
      // Chord anticipation [BUG #5 FIX: in-scale only]
      // v9.2.0: Use HarmonicPlanner instead of removed chordTrie
      if(typeof HarmonicPlanner!=='undefined'&&HarmonicPlanner.getNextChords){
        var _nextCh=HarmonicPlanner.getNextChords();
        if(_nextCh&&_nextCh.length>0&&_nextCh[0].confidence>0.05){
          var nextRoot=_nextCh[0].rootPC,nextType=_nextCh[0].type||'minor';
          var nextTones=[nextRoot,(nextRoot+(nextType==='major'?4:3))%12,(nextRoot+7)%12];
          for(var nt=0;nt<nextTones.length;nt++){
            var lt2=(nextTones[nt]-1+12)%12;
            if(sc.has(lt2))probs[lt2]*=1.15;
            probs[nextTones[nt]]*=1.1;
          }
        }
      }
    }
    
    // Theory prior [BUG #3, #9, #11 FIXES]
    var theory=new Float64Array(12);
    var ton=keyC,dom=(keyC+7)%12;
    for(var t=0;t<12;t++){
      theory[t]=sc.has(t)?1:.02*(sc.size/12); // smaller scales → stricter penalty
      var dist=((t-cur)%12+12)%12;if(dist>6)dist=12-dist;
      // [BUG #11] Separate repeat probability from distance — unison handled by recency, not theory
      if(dist===0)theory[t]*=0.9; // slight neutral penalty, not genre-dependent
      else if(dist<=2)theory[t]*=gc.stepB+.3;
      else if(dist<=4)theory[t]*=.5;
      else if(dist<=5)theory[t]*=.3;
      else theory[t]*=.1;
    }
    theory[ton]*=1.3;theory[dom]*=1.15;
    var lt3=(keyC+11)%12;
    if(cur===lt3&&sc.has(lt3))theory[ton]*=2;
    if(cur===(keyC+5)%12)theory[(keyC+4)%12]*=1.5;
    
    // Narmour
    var recent=stmTries.recent;
    if(recent.length>=2){
      var prev=recent[recent.length-2],li=((cur-prev)%12+12)%12;if(li>6)li-=12;var al=Math.abs(li);
      if(al>0&&al<=4){for(var t=0;t<12;t++){var ni=((t-cur)%12+12)%12;if(ni>6)ni-=12;if(li>0&&ni>0&&ni<=4)theory[t]*=1.3;if(li<0&&ni<0&&ni>=-4)theory[t]*=1.3;}}
      else if(al>4){for(var t=0;t<12;t++){var ni=((t-cur)%12+12)%12;if(ni>6)ni-=12;if(li>0&&ni<0)theory[t]*=1.5;if(li<0&&ni>0)theory[t]*=1.5;}}
    }
    var ts=0;for(var i=0;i<12;i++)ts+=theory[i];for(var i=0;i<12;i++)theory[i]/=ts;
    
    // Blend: [BUG #7 FIX] slower STM ramp
    var stmW=Math.min(stmTries.pitch.root.total/100,.25); // was /30 and .35
    var ltmW=ltmLoaded?0.5:0;
    var dataWeight=Math.min(ltmW+stmW,0.85);
    for(var i=0;i<12;i++)probs[i]=probs[i]*dataWeight+theory[i]*(1-dataWeight);
    
    // Phrase-aware bias (using float strength, not boolean)
    if(phraseStrength>0.1){
      probs[keyC]*=(1+phraseStrength*0.5);probs[(keyC+7)%12]*=(1+phraseStrength*0.3);
    }
    
    // Recency penalty
    if(recent.length>=1)probs[recent[recent.length-1]]*=.35;
    if(recent.length>=2)probs[recent[recent.length-2]]*=.65;
    
    // [BUG #2 FIX] Genre-aware anti-oscillation
    if(recent.length>=3&&recent[recent.length-1]===recent[recent.length-3]){
      var oscPenalty=gc.antiOsc; // genre-specific: electronic=0.85, pop=0.4
      // If LTM strongly predicts this note, reduce penalty further
      if(ltmLoaded&&ltm.pitch){
        var ltmPred=ltm.pitch.predict(12);
        if(ltmPred[recent[recent.length-1]]>0.2)oscPenalty=Math.min(1,oscPenalty+0.3);
      }
      probs[recent[recent.length-1]]*=oscPenalty;
    }
    // Anti-4-loop
    if(recent.length>=8){var last4=recent.slice(-4),prev4=recent.slice(-8,-4);
      if(last4.join()===prev4.join())for(var li=0;li<4;li++)probs[last4[li]]*=.6;}
    
    // Surprise thermostat temperature adjustment
    var tempAdj=getTemperatureAdjust();
    if(Math.abs(tempAdj)>0.01){
      // tempAdj>0: too predictable → flatten (raise temperature)
      // tempAdj<0: too chaotic → sharpen (lower temperature)
      var temp=1.0-tempAdj; // invert: positive deficit → flatten
      temp=Math.max(0.3,Math.min(2.0,temp)); // clamp to safe range
      for(var i=0;i<12;i++)probs[i]=Math.pow(probs[i],temp);
    }

    // Normalize
    var s=0;for(var i=0;i<12;i++)s+=probs[i];if(s>0)for(var i=0;i<12;i++)probs[i]/=s;
    return probs;
  }
  
  // v9.2.0: Extended chord shape with confidence, source, timestamp (backward-compatible)
  function recordChord(rootPC,type,confidence,source){currentChord={rootPC:rootPC,type:type,confidence:confidence||1.0,source:source||'legacy',timestamp:Date.now()};}
  
  function trackHumanIC(pc,pcProbs){
    if(pcProbs&&pcProbs[pc]>0){
      var ic=-Math.log2(Math.max(pcProbs[pc],.001));
      humanIC.push(ic);if(humanIC.length>20)humanIC.shift();
      // Feed surprise thermostat
      surpriseHistory.push(ic);
      if(surpriseHistory.length>_surpriseWindow)surpriseHistory.shift();
    }
    lastHumanNotes.push(pc);if(lastHumanNotes.length>12)lastHumanNotes.shift();
  }
  
  function getHumanAdventurousness(){
    if(humanIC.length<3)return 0.5;
    var r=humanIC.slice(-8),avg=r.reduce(function(a,b){return a+b},0)/r.length;
    return Math.min(1,Math.max(0,(avg-1)/5));
  }
  
  // ═══ KEY DISTRIBUTION — Full 24-value K-S correlation profile ═══
  // Returns the probability that the current music is in each of 24 keys
  // (12 roots × 2 modes), plus entropy, confidence, and top key/mode.
  // Uses weighted histogram when available, falls back to autoKeyNotes.
  function getKeyDistribution(){
    if(_keyDistCache)return _keyDistCache;

    // Build histogram: prefer weighted if populated, else raw autoKeyNotes
    var hist;
    if(weightedKeyCount>=8){
      hist=weightedKeyHist;
    }else if(autoKeyNotes.length>=8){
      hist=new Float64Array(12);
      for(var i=0;i<autoKeyNotes.length;i++)hist[autoKeyNotes[i]%12]++;
    }else{
      // Not enough data — return uniform
      var uniform=1/24;
      var dist=new Float64Array(24);for(var i=0;i<24;i++)dist[i]=uniform;
      _keyDistCache={distribution:dist,entropy:Math.log2(24),confidence:0,topKey:keyC,topMode:mode};
      return _keyDistCache;
    }

    // Compute K-S correlation for all 24 keys (12 major + 12 minor)
    var scores=new Float64Array(24);
    for(var k=0;k<12;k++){
      var majS=0,minS=0;
      for(var i=0;i<12;i++){
        majS+=hist[(k+i)%12]*MAJOR_PROF[i];
        minS+=hist[(k+i)%12]*MINOR_PROF[i];
      }
      scores[k*2]=majS;     // even indices = major
      scores[k*2+1]=minS;   // odd indices = minor
    }

    // Softmax normalization (temperature=1)
    var maxS=-Infinity;
    for(var i=0;i<24;i++)if(scores[i]>maxS)maxS=scores[i];
    var expSum=0;
    var dist=new Float64Array(24);
    for(var i=0;i<24;i++){dist[i]=Math.exp(scores[i]-maxS);expSum+=dist[i];}
    for(var i=0;i<24;i++)dist[i]/=expSum;

    // Entropy and confidence
    var entropy=0;
    for(var i=0;i<24;i++)if(dist[i]>0)entropy-=dist[i]*Math.log2(dist[i]);
    var maxEntropy=Math.log2(24);
    var confidence=Math.max(0,1-entropy/maxEntropy);

    // Top key
    var topIdx=0;
    for(var i=1;i<24;i++)if(dist[i]>dist[topIdx])topIdx=i;
    var topKey=Math.floor(topIdx/2);
    var topMode=topIdx%2===0?'major':'minor';

    _keyDistCache={distribution:dist,entropy:entropy,confidence:confidence,topKey:topKey,topMode:topMode};
    return _keyDistCache;
  }

  // ═══ VOICE-WEIGHTED KEY UPDATE ═══
  // Bass notes count 2.5×, human 1.5×, rhythm 1.0×, soloist 0.5×.
  // Maintains a decaying histogram (recent notes matter more).
  function updateKeyWeighted(pc,voiceRole){
    var w=VOICE_KEY_WEIGHT[voiceRole]||1.0;
    // Decay existing histogram slightly (exponential forgetting)
    var decay=0.98;
    for(var i=0;i<12;i++)weightedKeyHist[i]*=decay;
    weightedKeyHist[pc%12]+=w;
    weightedKeyCount++;
    _keyDistCache=null; // invalidate cache
  }

  function reset(){
    // v9.2.0: chordTrie removed — no trie to reset
    autoKeyNotes=[];pendingKey=0;pendingMode='major';
    currentChord=null;phraseIC=[];phraseStrength=0;lastNoteTime=0;
    humanIC=[];lastHumanNotes=[];surpriseHistory=[];
    weightedKeyHist=new Float64Array(12);weightedKeyCount=0;_keyDistCache=null;
  }
  
  return{
    get keyC(){return keyC;},set keyC(v){keyC=v;},
    get mode(){return mode;},set mode(v){mode=v;},
    get genre(){return genre;},set genre(v){genre=v;},
    get ltmLoaded(){return ltmLoaded;},
    get currentChord(){return currentChord;},
    get phraseStrength(){return phraseStrength;},
    get lastHumanNotes(){return lastHumanNotes;},
    predict:predict,updateKey:updateKey,updatePhraseBoundary:updatePhraseBoundary,
    loadLTM:loadLTM,loadLTMFromJSON:loadLTMFromJSON,recordChord:recordChord,trackHumanIC:trackHumanIC,
    getHumanAdventurousness:getHumanAdventurousness,
    getTemperatureAdjust:getTemperatureAdjust,getSurpriseAvg:getSurpriseAvg,getRecentSurprises:getRecentSurprises,
    getKeyDistribution:getKeyDistribution,updateKeyWeighted:updateKeyWeighted,
    reset:reset,
    setKey:function(k){keyC=k;},setMode:function(m){mode=m;}
  };
})();
