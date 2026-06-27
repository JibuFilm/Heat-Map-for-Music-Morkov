'use strict';

// ═══ AUDIO UNLOCK ═══
var _bootDone=false;
var _audioUnlocked=false;
function unlockAudio(){
  if(!_bootDone)return;
  SoundEngine.ensureCtx();
  // Auto-fullscreen on first click (desktop app)
  if(!document.fullscreenElement&&!document.webkitFullscreenElement){
    var el=document.documentElement;
    if(el.requestFullscreen)el.requestFullscreen().catch(function(){});
    else if(el.webkitRequestFullscreen)el.webkitRequestFullscreen();
  }
  document.getElementById('startOverlay').classList.add('hidden');
  setTimeout(function(){var ov=document.getElementById('startOverlay');if(ov)ov.style.display='none';},600);
  // Hide old UI — TimbralSpace is the primary interface
  document.body.classList.add('ui-immersive');
  // Hide mixer subpage if open
  var msp=document.getElementById('mixerSubpage');if(msp)msp.style.display='none';
  // Initialize 3D timbral space and activate it as primary view
  try{if(typeof TimbralSpace!=='undefined'){TimbralSpace.init();if(!TimbralSpace.isActive()){TimbralSpace.toggle();}setTimeout(function(){TimbralSpace.refreshAnalysers();},1000);}}catch(e){console.warn('TimbralSpace init:',e);};
  try{if(typeof RawDump!=='undefined'&&typeof TimbralSpace!=='undefined'){var _rdCtx=TimbralSpace.getProjectionContext();var _rdScene=TimbralSpace.getScene();if(_rdCtx&&_rdCtx.camera&&_rdScene)RawDump.init(_rdCtx.camera,_rdScene);}}catch(e){console.warn('RawDump init:',e);};

  // ═══ AUTO-LOAD ALL INSTRUMENTS + PER-VOICE DEFAULTS ═══
  // Only run once at boot — returning from settings overlay should NOT reset instruments
  if(_audioUnlocked) return;
  _audioUnlocked = true;

  // Load full instrument library (ToneJS local + CDN GM), then assign
  // curated per-voice defaults. Falls back to built-in synth 'piano'.
  //
  // Per-voice instrument choices:
  //   bass:    tj_harmonium    — warm, sustained, sits well in low register
  //   rhythm:  gm_epiano       — clear attack, good for comping/arpeggiation
  //   soloist: gm_saw_lead     — cutting sawtooth, projects over ensemble
  //   lead:    gm_organ        — drawbar organ, rich harmonics, melodic sustain
  //   human:   acoustic_grand_piano — neutral default for the player
  var _VOICE_DEFAULTS = {
    bass:    { inst: 'acoustic_grand_piano',  fallback: 'acoustic_grand_piano' },
    rhythm:  { inst: 'acoustic_grand_piano',  fallback: 'acoustic_grand_piano' },
    soloist: { inst: 'acoustic_grand_piano',  fallback: 'acoustic_grand_piano' },
    lead:    { inst: 'acoustic_grand_piano',  fallback: 'acoustic_grand_piano' },
    human:   { inst: 'acoustic_grand_piano',  fallback: 'acoustic_grand_piano' }
  };

  try{
    if(typeof SampleLoader!=='undefined'){
      // First: quick-load piano as immediate fallback while full library loads
      if(!SampleLoader.isLoaded('acoustic_grand_piano')){
        SampleLoader.loadFromCDN('acoustic_grand_piano',{},function(ok){
          if(ok){
            SoundEngine.setInstrument('acoustic_grand_piano');
            console.log('GM Piano loaded as global fallback');
          }
        });
      }

      // Then: load full instrument library (ToneJS + CDN)
      console.log('Loading full instrument library...');
      SampleLoader.loadDefaults(function(allOk){
        console.log('Instrument library loaded (' + (allOk ? 'all ok' : 'some failed') + ')');

        // Assign per-voice defaults
        for(var voice in _VOICE_DEFAULTS){
          var def = _VOICE_DEFAULTS[voice];
          var instName = SampleLoader.isLoaded(def.inst) ? def.inst :
                         SampleLoader.isLoaded(def.fallback) ? def.fallback :
                         'acoustic_grand_piano';
          SoundEngine.setVoiceInstrument(voice, instName);
          console.log('  ' + voice + ' → ' + instName);
        }

        // Update UI dropdowns
        if(typeof populateInstSelects==='function')populateInstSelects();
        var selMap={instHuman:'human',instBass:'bass',instRhythm:'rhythm',instSoloist:'soloist',instLead:'lead'};
        for(var sid in selMap){
          var voice = selMap[sid];
          var sel=document.getElementById(sid);
          if(sel){
            var def = _VOICE_DEFAULTS[voice];
            sel.value = SampleLoader.isLoaded(def.inst) ? def.inst : def.fallback;
            sel.classList.add('inst-active');
          }
        }
      }, function(loaded, total, name){
        // Progress callback — could wire to boot screen later
        if(loaded % 5 === 0) console.log('  Instruments: ' + loaded + '/' + total);
      });
    }
  }catch(e){console.error('Auto-load instruments error:',e);}
}

// ═══ TERMINAL BOOT SEQUENCE ═══
var _BOOT_STEPS=[
  'BIOS v8.12.1 \u2014 VELES ENSEMBLE SYSTEM',
  'MEMORY TEST... 512K OK',
  'DETECTING AUDIO HARDWARE',
  'INITIALIZING WEB AUDIO CONTEXT',
  'LOADING PREDICTION ENGINE [PPM-5]',
  'MOUNTING LEXICON DATABASE',
  'CALIBRATING PHASE COUPLING [5-PARTY KURAMOTO]',
  'TESTING VOICE CHANNELS [6/6]',
  'HARMONIC PLANNER ONLINE',
  'BELIEF STATE INITIALIZED [POMDP L0-L3]',
  'NARRATIVE ARC ENGINE READY',
  'PEER MODEL LOADED',
  'LTM WARM-START CHECK',
  'SPECTRAL ANALYSIS READY [FFT-1024]',
  'ALL SYSTEMS NOMINAL'
];
function _buildBootUI(){
  var ov=document.getElementById('startOverlay');
  if(!ov)return;
  var now=new Date();
  var ts=now.getFullYear()+'-'+(''+(now.getMonth()+1)).padStart(2,'0')+'-'+(''+ now.getDate()).padStart(2,'0')+' '+(''+ now.getHours()).padStart(2,'0')+':'+(''+ now.getMinutes()).padStart(2,'0')+':'+(''+ now.getSeconds()).padStart(2,'0');
  // Clone the genreSelect from the main UI so boot screen has its own copy
  var origGenre=document.getElementById('genreSelect');
  var genreOpts='';
  if(origGenre){
    for(var gi=0;gi<origGenre.options.length;gi++){
      var opt=origGenre.options[gi];
      genreOpts+='<option value="'+opt.value+'"'+(opt.selected?' selected':'')+'>'+opt.textContent+'</option>';
    }
  }
  ov.innerHTML=
    '<div class="bios-boot">'+
      // Header
      '<div class="bios-header">'+
        '<span class="bios-name">VELES BIOS v8.12.1</span>'+
        '<span class="bios-date">'+ts+'</span>'+
      '</div>'+
      '<div class="bios-divider"></div>'+
      // Boot lines area
      '<div id="bootLines" class="bios-log"></div>'+
      // Progress
      '<div class="bios-progress"><div id="bootProg" class="bios-progress-fill"></div></div>'+
      '<div id="bootProgLbl" style="font-size:10px;color:rgba(51,255,51,0.3);text-align:right;margin-top:-8px;margin-bottom:4px;">0%</div>'+
      // System Ready
      '<div id="bootReady" class="bios-ready"></div>'+
      '<div id="bootHint" style="font-size:11px;color:rgba(51,255,51,0.25);margin-bottom:12px;"></div>'+
      // Divider before resources
      '<div class="bios-divider"></div>'+
      // Preset row
      '<div class="bios-preset-row">'+
        '<span style="color:#c87800;">PRESET:</span>'+
        '<select id="biosGenreSelect" class="bios-select">'+genreOpts+'</select>'+
      '</div>'+
      // Resource buttons row
      '<div class="boot-utils-row bios-controls">'+
        '<button class="bios-btn" id="bootSamples" onclick="event.stopPropagation();if(typeof loadDefaultSamples===\'function\')loadDefaultSamples();this.textContent=\'LOADING...\';this.disabled=true">[SAMPLES]</button>'+
        '<button class="bios-btn" id="bootSoundFile" onclick="event.stopPropagation();if(typeof pickSoundFile===\'function\')pickSoundFile()">[SOUND FILE]</button>'+
        '<button class="bios-btn" id="bootLoadLexicon" onclick="event.stopPropagation();document.getElementById(\'lexiconFileInput\').click()">[LEXICON]</button>'+
        '<button class="bios-btn" id="bootAutoEval" onclick="event.stopPropagation();if(typeof AutoEvaluator!==\'undefined\'){if(AutoEvaluator.isRunning()){AutoEvaluator.stop();this.textContent=\'[AUTO-EVAL]\';this.classList.remove(\'active\');}else{AutoEvaluator.startSuite();this.textContent=\'[STOP EVAL]\';this.classList.add(\'active\');}}">[AUTO-EVAL]</button>'+
      '</div>'+
      '<input type="file" id="lexiconFileInput" accept=".json" multiple style="display:none">'+
      // Footer
      '<div class="bios-footer">VELES v8.12.1 | DECENTRALIZED ENSEMBLE INSTRUMENT | 2026</div>'+
    '</div>';
  // Sync boot genreSelect with the real one
  var biosGenre=document.getElementById('biosGenreSelect');
  if(biosGenre&&origGenre){
    biosGenre.addEventListener('change',function(){origGenre.value=biosGenre.value;origGenre.dispatchEvent(new Event('change'));});
  }
  // Entry point is SYSTEM READY / bootHint, NOT entire overlay (prevents instrument click conflicts)
  // Fullscreen button removed — desktop app auto-fullscreens
  // Phase 14: Wire lexicon file input on boot screen
  var lexInput=document.getElementById('lexiconFileInput');
  if(lexInput){
    lexInput.addEventListener('change',function(e){
      var files=Array.from(e.target.files);if(!files.length)return;
      var btn=document.getElementById('bootLoadLexicon');
      files.forEach(function(f){if(typeof window._loadLexiconFile==='function')window._loadLexiconFile(f);});
      if(btn){btn.textContent='LEXICON \u2713'+files.length;btn.classList.add('boot-util-ok');}
      e.target.value='';
    });
  }
  // Wire sample load status back to boot button
  if(typeof window.loadDefaultSamples!=='undefined'){
    var _origLoadSamples=window.loadDefaultSamples;
    window.loadDefaultSamples=function(){
      _origLoadSamples();
      var _checkStart=Date.now();
      var checkInterval=setInterval(function(){
        var origBtn=document.getElementById('bLoadSamples');
        var bootBtn=document.getElementById('bootSamples');
        if(origBtn&&bootBtn){
          if(origBtn.classList.contains('ok')){
            bootBtn.textContent='SAMPLES \u2713';bootBtn.classList.add('boot-util-ok');bootBtn.disabled=false;
            clearInterval(checkInterval);
          } else if(origBtn.textContent==='Retry'){
            bootBtn.textContent='RETRY';bootBtn.classList.add('boot-util-err');bootBtn.disabled=false;
            clearInterval(checkInterval);
          } else if(Date.now()-_checkStart>30000){
            bootBtn.textContent='TIMEOUT';bootBtn.classList.add('boot-util-err');bootBtn.disabled=false;
            clearInterval(checkInterval);
          }
        }
      },500);
    };
  }
}
function _runBoot(){
  var linesEl=document.getElementById('bootLines');
  var progEl=document.getElementById('bootProg');
  var progLbl=document.getElementById('bootProgLbl');
  var readyEl=document.getElementById('bootReady');
  var hintEl=document.getElementById('bootHint');
  if(!linesEl)return;
  // Show early hint during boot
  if(hintEl){hintEl.textContent='LOADING SYSTEM...';}
  var i=0,N=_BOOT_STEPS.length;
  function step(){
    if(i>=N){
      if(progEl){progEl.style.width='100%';}
      if(progLbl)progLbl.textContent='100%';
      setTimeout(function(){
        if(readyEl){
          readyEl.innerHTML='SYSTEM READY <span class="bios-cursor"></span>';
          readyEl.classList.add('visible');
          readyEl.style.cursor='pointer';
          readyEl.onclick=function(e){e.stopPropagation();unlockAudio();};
        }
        setTimeout(function(){
          _bootDone=true;
          if(hintEl){hintEl.innerHTML='PRESS ENTER OR CLICK TO CONTINUE';hintEl.style.color='#c87800';}
          // Allow Enter key to unlock
          document.addEventListener('keydown',function _biosEnter(e){if(e.key==='Enter'&&_bootDone){document.removeEventListener('keydown',_biosEnter);unlockAudio();}});
        },360);
      },200);
      return;
    }
    var pct=Math.round(i/N*88);
    if(progEl)progEl.style.width=pct+'%';
    if(progLbl)progLbl.textContent=pct+'%';
    var div=document.createElement('div');
    div.className='bios-line';
    div.innerHTML=_BOOT_STEPS[i]+'<span id="bls'+i+'"> ...</span>';
    linesEl.appendChild(div);
    // Auto-scroll to bottom
    linesEl.scrollTop=linesEl.scrollHeight;
    var idx=i;
    setTimeout(function(){
      var el=document.getElementById('bls'+idx);
      if(el){el.textContent=' OK';el.className='bios-ok';}
    },100+Math.random()*80);
    i++;
    setTimeout(step,175+Math.random()*120);
  }
  setTimeout(step,320);
  // Blinking cursor keyframe defined in tonnetz.css (.bios-cursor)
}
(function(){_buildBootUI();_runBoot();})();

// ═══ KEY SELECTOR INIT ═══
// Key selector
var kSel=document.getElementById('keySelect');
kSel.innerHTML='<option value="auto">Auto</option>'+N.map(function(n,i){return'<option value="'+i+'">'+n+'</option>'}).join('');


// ═══ LAYER 4: TONNETZ + APP ═══
(function(){
var cv=document.getElementById('cv'),cx=cv.getContext('2d'),wrap=document.getElementById('cWrap');
var COLS=7,ROWS=5,NR=26;
var nodes=[],edges=[],adjMap={},triangles=[];
var W,H,dpr;
var panX=0,panY=0,isDrag=false,dragSX=0,dragSY=0,panSX=0,panSY=0,dragDist=0;
var zoomLevel=1.0;

// Visual state (supports multiple active notes)
var activeNotes=[]; // [{pc, idx, source:'human'|'bass'|'rhythm'|'soloist', time}]
var pcProbs=new Float64Array(12); // for Tonnetz glow (from human's perspective)
var pcCounts=Array(12).fill(0);
var trail=[],total=0,hovIdx=null,hovTri=null;
var _humanLastTrailIdx=null; // Phase 8: cursor ring tracks human-played nodes only

// Voice players (Phase 1.3 + lead v2.3)
var voices={
  bass:new VoicePlayer('bass',0.5),
  rhythm:new VoicePlayer('rhythm',1.0),
  soloist:new VoicePlayer('soloist',2.0),
  lead:new VoicePlayer('lead',1.5)
};
// metroScope removed — metronome UI removed

// Drone/dial state
var dialAngle=0,dialTargetAngle=0,dialGrabbed=false,dialVisible=true;
var droneStarted=false,droneActive=false,dialManualOverride=false,dialOverrideTimeout=null;
var ringX=0,ringY=0,ringR=46,ringDragging=false,ringDragOX=0,ringDragOY=0;
var COF=[0,7,2,9,4,11,6,1,8,3,10,5];
function pcToDialAngle(pc){var idx=COF.indexOf(pc);if(idx<0)idx=0;return idx*Math.PI*2/12-Math.PI/2;}
function dialAngleToPC(angle){var a=((angle+Math.PI/2)%(Math.PI*2)+Math.PI*2)%(Math.PI*2);return COF[Math.round(a/(Math.PI*2)*12)%12];}
function lerpAngle(a,b,t){var d=b-a;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return a+d*t;}

var nodeRadii=[],nodeTargetRadii=[];

// Phase 8: draw-loop state for mockup parity
var _beatPhase=0,_lastFrameTime=0,_noiseOff=0;
var _beatPulses=[];  // expanding gold rings on tonic nodes per beat

// App state
var autoMode=false;
// metroOn/beatOn removed — metronome UI removed
var lastHumanNoteTime=0;

// Perceptual timing filter — tracks actual audio onset per voice
var _voiceOnsetTimes={bass:0,rhythm:0,soloist:0};

// ═══ WAVEFORM BRIDGE (Phase 10) ═══
// Full oscilloscope pipeline is owned by ui-wiring.js.
// app.js fires trigger events; ui-wiring.js handles Web Audio + AnalyserNode + canvas.
function _wvNoteOn(voice,midi){
  if(typeof window._wvTrigger==='function')window._wvTrigger(voice,midi);
}

// ═══ HIGH-RES MASTER TICK (Phase 2.2 — 5ms / 200Hz) ═══
var masterIv=null,lastTickTime=0,masterBeat=0;
var silenceBeats=0;
var _spectralAccum=0; // Layer 0: spectral forwarding timer (~10Hz)

function startMasterTick(){
  if(masterIv)return;
  lastTickTime=Date.now();
  masterIv=setInterval(highResTick,5);
}
function stopMasterTick(){if(masterIv)clearInterval(masterIv);masterIv=null;}

function highResTick(){
  var now=Date.now(),dt=now-lastTickTime;
  lastTickTime=now;if(dt>50)dt=50; // cap to prevent spiral
  
  // Phase 2.3: Graceful decay
  var bpm=TempoEngine.getEffectiveBPM();
  if(!isFinite(bpm)||bpm<30)bpm=120;
  var beatMs=60000/bpm;
  silenceBeats=(now-lastHumanNoteTime)/beatMs;
  
  // Phase 7: VoiceManager tick ALWAYS runs (sustain release even when auto off)
  try{VoiceManager.tick(dt);}catch(e){}

  if(autoMode){
    // v9.2.0: typeof guards removed — all modules guaranteed by index.html script load order.
    // try-catch retained for error resilience.
    try{SectionTracker.tick(dt,bpm);}catch(e){}
    try{DialogueEngine.tick(dt,bpm);}catch(e){}
    try{PhaseCoupling.tick(dt);}catch(e){}          // Kuramoto phase coupling
    try{BeliefState.updateBeliefs(dt);}catch(e){}    // POMDP belief update
    try{KeyBelief.tick(dt);}catch(e){}               // Per-voice key belief
    try{ChordBelief.tick(dt);}catch(e){}             // Multi-voice chord accumulation
    // Layer 0: Forward FFT data to sidecar at ~10Hz (every 100ms, not every tick)
    _spectralAccum+=dt;if(_spectralAccum>=100){_spectralAccum=0;try{SpectralForwarder.tick();}catch(e){}}
    try{MoodState.tick(dt);}catch(e){}               // Harmonic mood EMA
    try{NarrativeArc.tick(dt);}catch(e){}            // Per-voice arc state
    try{TimbralEvolution.tick(dt);}catch(e){}        // Sound color modulation
    try{SessionEnding.tick(dt);}catch(e){}           // Composed conclusion
    try{MelodicIntent.tick(dt);}catch(e){}           // L2 melodic intent
    try{PeerVelocity.tick(dt/1000);}catch(e){}       // Breathing/fatigue recovery
    try{ConvictionExpression.tick(dt);}catch(e){}    // Conviction surges
    try{PeerModel.tick(dt);}catch(e){}               // Peer predictive models
    try{GestureClassifier.tick(dt);}catch(e){}       // Gesture classification

    // Gen3 assistants with Phase 3 coordination
    if(typeof BassAssistant!=='undefined'){
      var bpc=null,rpc=null,spc=null;
      try{bpc=BassAssistant.onTick(dt);}catch(e){if(!window._bassErrCount)window._bassErrCount=0;window._bassErrCount++;if(window._bassErrCount<=5||window._bassErrCount%1000===0)console.error('BassAssistant tick error (#'+window._bassErrCount+'):',e);}
      var _rpcChord=null;var _rpcRolled=false;
      try{rpc=RhythmAssistant.onTick(dt);if(Array.isArray(rpc)){_rpcChord=rpc;_rpcRolled=rpc._rolled||false;rpc=rpc[0];}}catch(e){if(!window._rhythmErrCount)window._rhythmErrCount=0;window._rhythmErrCount++;if(window._rhythmErrCount<=5||window._rhythmErrCount%1000===0)console.error('RhythmAssistant tick error (#'+window._rhythmErrCount+'):',e);}
      try{spc=SoloAssistant.onTick(dt);}catch(e){if(!window._soloErrCount)window._soloErrCount=0;window._soloErrCount++;if(window._soloErrCount<=5||window._soloErrCount%1000===0)console.error('SoloAssistant tick error (#'+window._soloErrCount+'):',e);}
      try{if(PercussionAssistant.isEnabled())PercussionAssistant.onTick(dt);}catch(e){if(!window._percErrCount)window._percErrCount=0;window._percErrCount++;if(window._percErrCount<=5||window._percErrCount%1000===0)console.error('PercussionAssistant tick error (#'+window._percErrCount+'):',e);}
      var lpc=null;
      try{lpc=LeadAssistant.onTick(dt);if(lpc===undefined)lpc=null;}catch(e){if(!window._leadErrCount)window._leadErrCount=0;window._leadErrCount++;if(window._leadErrCount<=5||window._leadErrCount%1000===0)console.error('LeadAssistant tick error (#'+window._leadErrCount+'):',e);}

      // Phase 3: coordinate outputs (collision + density)
      if(typeof FinalCoordinator!=='undefined'){
        var coordinated=FinalCoordinator.coordinate(bpc,rpc,spc,lpc);
        if(coordinated.bass!==null){playVoiceNote(coordinated.bass,'bass');try{PhaseCoupling.onNoteProduced('bass');}catch(e){}try{BeliefState.onVoiceNote('bass');}catch(e){}
          // v9.2.0: Multi-voice chord inference via ChordBelief (bass notes = evidence, not commands)
          var _bassGroove = BassAssistant.getBassState ? BassAssistant.getBassState() === 'groove' : true;
          var _bpc = coordinated.bass;
          var _scale = getScale(SharedState.keyC, SharedState.mode);
          var _hasMinor3 = false;
          for (var _si = 0; _si < _scale.length; _si++) {
            if ((_scale[_si] - _bpc + 12) % 12 === 3) { _hasMinor3 = true; break; }
          }
          ChordBelief.observe(_bpc, _hasMinor3 ? 'minor' : 'major', _bassGroove ? 'bass_groove' : 'bass_searching');
        }
        if(coordinated.rhythm!==null){playVoiceNote(coordinated.rhythm,'rhythm');if(_rpcChord){for(var _ci=1;_ci<_rpcChord.length;_ci++){if(_rpcRolled){playVoiceNote(_rpcChord[_ci],'rhythm',_ci*0.025);}else{playVoiceNote(_rpcChord[_ci],'rhythm');}}}try{PhaseCoupling.onNoteProduced('rhythm');}catch(e){}try{BeliefState.onVoiceNote('rhythm');}catch(e){}}
        if(coordinated.soloist!==null){playVoiceNote(coordinated.soloist,'soloist');try{PhaseCoupling.onNoteProduced('soloist');}catch(e){}try{BeliefState.onVoiceNote('soloist');}catch(e){}}
        if(coordinated.lead!==null){playVoiceNote(coordinated.lead,'lead');try{PhaseCoupling.onNoteProduced('lead');}catch(e){}try{BeliefState.onVoiceNote('lead');}catch(e){}}
        // v2.1: Music-centric observation — feed AI notes into SectionTracker and surprise system.
        // Without this, SectionTracker sees "permanent silence" in freerun → stuck in TRANSITION,
        // and surpriseHistory stays empty → surpriseDelta frozen at 0.5.
        try{
          var _aiNow=Date.now();
          if(typeof SectionTracker!=='undefined'){
            if(coordinated.bass!==null)SectionTracker.onNote(coordinated.bass,'bass',_aiNow);
            if(coordinated.rhythm!==null)SectionTracker.onNote(coordinated.rhythm,'rhythm',_aiNow);
            if(coordinated.soloist!==null)SectionTracker.onNote(coordinated.soloist,'soloist',_aiNow);
            if(coordinated.lead!==null)SectionTracker.onNote(coordinated.lead,'lead',_aiNow);
          }
          // Feed AI notes into surprise history via predict+trackHumanIC path
          // (reusing trackHumanIC is fine — it just pushes IC values into surpriseHistory)
          if(coordinated.bass!==null){var _bp=SharedState.predict(coordinated.bass,null,SharedState.genre);SharedState.trackHumanIC(coordinated.bass,_bp);}
          if(coordinated.rhythm!==null){var _mp=SharedState.predict(coordinated.rhythm,null,SharedState.genre);SharedState.trackHumanIC(coordinated.rhythm,_mp);}
          if(coordinated.soloist!==null){var _tp=SharedState.predict(coordinated.soloist,null,SharedState.genre);SharedState.trackHumanIC(coordinated.soloist,_tp);}
          if(coordinated.lead!==null){var _lp=SharedState.predict(coordinated.lead,null,SharedState.genre);SharedState.trackHumanIC(coordinated.lead,_lp);}
          // Feed AI notes into DialogueEngine for stance computation
          if(DialogueEngine.onEnsembleNote){
            if(coordinated.bass!==null)DialogueEngine.onEnsembleNote(_aiNow);
            if(coordinated.rhythm!==null)DialogueEngine.onEnsembleNote(_aiNow);
            if(coordinated.soloist!==null)DialogueEngine.onEnsembleNote(_aiNow);
            if(coordinated.lead!==null)DialogueEngine.onEnsembleNote(_aiNow);
          }
        }catch(e){}
        // ContextIntegrator: feed resolved outputs for cross-voice awareness
        {
          var _bsVel={};
          try{
            var _secE=SectionTracker.getState().energy||0.5;
            var _bp=BassAssistant.getPhraseProgress();var _mp=RhythmAssistant.getPhraseProgress();var _tp=SoloAssistant.getPhraseProgress();
            // Velocity = section energy (global arc) + phrase progress modulation (local shape)
            // Bass: steady, rhythm: phrase-shaped, soloist: dynamic
            if(coordinated.bass!==null)_bsVel.bass=Math.round(Math.min(1,_secE*0.8+_bp*0.2)*127);
            if(coordinated.rhythm!==null)_bsVel.rhythm=Math.round(Math.min(1,_secE*0.6+_mp*0.4)*127);
            if(coordinated.soloist!==null)_bsVel.soloist=Math.round(Math.min(1,_secE*0.5+_tp*0.5)*127);
          }catch(e){}
          ContextIntegrator.update(coordinated.bass,coordinated.rhythm,coordinated.soloist,{
            bass:   BassAssistant.getCurrentSource(),
            rhythm: RhythmAssistant.getCurrentSource(),
            soloist: SoloAssistant.getCurrentSource()
          },{
            bass:   BassAssistant.getPhraseProgress(),
            rhythm: RhythmAssistant.getPhraseProgress(),
            soloist: SoloAssistant.getPhraseProgress()
          },_bsVel);
          // Lead voice: feed into ContextIntegrator via onNote (not in positional update())
          if(coordinated.lead!==null&&ContextIntegrator.onNote){
            var _leadVel=_bsVel.lead||Math.round(Math.min(1,(_secE||0.5)*0.7+0.3)*127);
            ContextIntegrator.onNote('lead',coordinated.lead,'ppm',0.5,_leadVel);
          }
        }
      } else {
        // No coordinator — direct output
        if(bpc!==null)playVoiceNote(bpc,'bass');
        if(rpc!==null){playVoiceNote(rpc,'rhythm');if(_rpcChord){for(var _ci=1;_ci<_rpcChord.length;_ci++){if(_rpcRolled){playVoiceNote(_rpcChord[_ci],'rhythm',_ci*0.025);}else{playVoiceNote(_rpcChord[_ci],'rhythm');}}}}
        if(spc!==null)playVoiceNote(spc,'soloist');
      }
    } else {
      // Gen2 fallback
      if(silenceBeats>4)voices.soloist.scope.frozen=true;else voices.soloist.scope.frozen=false;
      if(silenceBeats>8)voices.rhythm.scope.frozen=true;else voices.rhythm.scope.frozen=false;
      if(silenceBeats>16)voices.bass.scope.frozen=true;else voices.bass.scope.frozen=false;
      var bassPC=null,midPC=null;
      if(voices.bass.scope.tick(dt)){var pc=voices.bass.onTick();if(pc!==null){bassPC=pc;playVoiceNote(pc,'bass');}}
      if(bassPC!==null){voices.rhythm.crossNotes=[bassPC];voices.soloist.crossNotes=[bassPC];}
      if(voices.rhythm.scope.tick(dt)){var pc=voices.rhythm.onTick();if(pc!==null){midPC=pc;playVoiceNote(pc,'rhythm');}}
      if(midPC!==null){voices.soloist.crossNotes=[bassPC||SharedState.keyC,midPC];}
      if(voices.soloist.scope.tick(dt)){var pc=voices.soloist.onTick();if(pc!==null)playVoiceNote(pc,'soloist');}
    }
    try{Scheduler.tickPhrases();}catch(e){}
  }
  
  // Metronome removed — Kuramoto oscillator handles tempo
}

function playVoiceNote(pc,voiceName,scheduleAheadSec){
  // ── Harmonic-rhythm gate (zero-style-bias build) ──────────────────────
  // The lexicon used to supply each voice's rhythm; stripped, the voices'
  // own timing degenerates (bass fired every 5ms tick). Instead, tie emission
  // to the HARMONY: a voice plays when ITS chord changes, or at most once per
  // floor interval (in beats) within a held chord. Chorale-like, sparse,
  // harmony-driven. 'human' is never gated. Tunable live via HR_GATE_BEATS.
  if(voiceName!=='human'){
    if(!window.HR_GATE_BEATS)window.HR_GATE_BEATS={bass:2,rhythm:2,soloist:1,lead:2};
    if(!window.__hrGate)window.__hrGate={last:{},chord:{}};
    var _hrBpm=TempoEngine.getEffectiveBPM();if(!isFinite(_hrBpm)||_hrBpm<30)_hrBpm=120;
    var _hrBeat=60000/_hrBpm;
    var _hrCC=(typeof SharedState!=='undefined'&&SharedState.currentChord)?SharedState.currentChord:null;
    var _hrCid=_hrCC?(_hrCC.rootPC*2+(_hrCC.type==='minor'?1:0)):-1;
    var _hrFloor=(window.HR_GATE_BEATS[voiceName]||2)*_hrBeat;
    var _hrNow=Date.now();
    var _hrChanged=(window.__hrGate.chord[voiceName]!==_hrCid);
    var _hrDue=((_hrNow-(window.__hrGate.last[voiceName]||-1e9))>=_hrFloor);
    if(!_hrChanged&&!_hrDue)return;
    window.__hrGate.last[voiceName]=_hrNow;
    window.__hrGate.chord[voiceName]=_hrCid;
  }
  // ── Tension layer: inject belief-driven dissonance that resolves ──
  if(typeof Tension!=='undefined'){ try{ pc=Tension.apply(pc,voiceName); }catch(e){} }
  // Diagnostic counter
  if(!window._diagNoteCount)window._diagNoteCount={bass:0,rhythm:0,soloist:0,total:0};
  window._diagNoteCount[voiceName]=(window._diagNoteCount[voiceName]||0)+1;
  window._diagNoteCount.total++;
  if(window._diagNoteCount.total<=3)console.log('%c[AI NOTE] '+voiceName+' pc='+pc+' (#'+window._diagNoteCount.total+')','color:#0f0');

  // v8.12.1: Harmonic diagnostic — track chord-tone hits per voice
  // Enable: window._harmonicDiag = true; Retrieve: window._harmonicLog
  if(window._harmonicDiag){
    if(!window._harmonicLog)window._harmonicLog={bass:{hit:0,miss:0,notes:[]},rhythm:{hit:0,miss:0,notes:[]},soloist:{hit:0,miss:0,notes:[]},lead:{hit:0,miss:0,notes:[]}};
    var _hChord=(typeof SharedState!=='undefined')?SharedState.currentChord:null;
    if(!_hChord&&typeof HarmonicPlanner!=='undefined'){try{var _hpCtx=HarmonicPlanner.getCurrentContext(voiceName);if(_hpCtx)_hChord={rootPC:_hpCtx.rootPC,type:_hpCtx.chordType||'major'};}catch(e){}}
    if(_hChord&&window._harmonicLog[voiceName]){
      var _hRoot=_hChord.rootPC;
      var _hThird=(_hRoot+(_hChord.type==='minor'?3:4))%12;
      var _hFifth=(_hRoot+7)%12;
      var _hSeventh=(_hRoot+(_hChord.type==='minor'?10:11))%12;
      var _hPC=pc%12;
      var _isChordTone=(_hPC===_hRoot||_hPC===_hThird||_hPC===_hFifth||_hPC===_hSeventh);
      if(_isChordTone)window._harmonicLog[voiceName].hit++;
      else window._harmonicLog[voiceName].miss++;
      var _sec='?';try{_sec=SectionTracker.getState().state;}catch(e){}
      window._harmonicLog[voiceName].notes.push({pc:_hPC,chord:_hRoot,type:_hChord.type,hit:_isChordTone,section:_sec,t:Date.now()});
    }
  }
  var voice=voices[voiceName];
  voice.observeNote(pc);
  // Feed AI notes into weighted key histogram (all voices contribute, weighted by role)
  if(typeof SharedState.updateKeyWeighted==='function')SharedState.updateKeyWeighted(pc,voiceName);
  var nd=findNode(pc,voiceName);
  if(!nd)return;

  // Octave placement: gravity-based with voice-leading + section awareness
  var midi;
  try{
    var _otherMidi=[];
    var _vnames=['bass','rhythm','soloist','lead'];
    for(var _vi=0;_vi<_vnames.length;_vi++){
      if(_vnames[_vi]!==voiceName)_otherMidi.push(OctavePlacement.getLastMidi(_vnames[_vi]));
    }
    var _secState='STABLE';
    try{_secState=SectionTracker.getState().state;}catch(e){}
    midi=OctavePlacement.place(pc,voiceName,{sectionState:_secState,otherVoiceMidi:_otherMidi});
  }catch(e){
    var baseMidi=voiceName==='bass'?36:voiceName==='rhythm'?60:voiceName==='lead'?66:72;
    midi=baseMidi+pc;
  }
  midi=Math.max(21,Math.min(108,midi));
  var volMult=1.0;

  // Overlap Manager: MIDI-domain psychoacoustic safety
  try{
    var _secOM='STABLE';try{_secOM=SectionTracker.getState().state;}catch(e){}
    var _om=OverlapManager.check(midi,voiceName,{sectionState:_secOM});
    if(_om.suppress)return;
    midi=_om.midi;
    volMult*=_om.velocityMult;
  }catch(e){}

  // Sustain boost from same-PC fusion (Scheduler)
  if(typeof Scheduler!=='undefined')volMult*=Scheduler.consumeSustainBoost(voiceName);

  // v7 Phase 8D: Dynamic expression — phrase arch, harmonic function, arc energy
  if(typeof Scheduler!=='undefined'&&Scheduler.getExpression){
    var _expr=Scheduler.getExpression(voiceName);
    volMult*=_expr.velocityMult;
    // durationMult available for VoiceManager sustain shaping (future use)
  }

  // Peer velocity envelope (breathing/fatigue)
  try{volMult*=PeerVelocity.getVelocity(voiceName);}catch(e){}

  // Mood velocity — minor keys slightly softer (Turner & Huron 2008)
  try{
    var _moodVelOff=MoodState.getVelocityOffset(voiceName);
    if(_moodVelOff!==0) volMult*=Math.max(0.7,Math.min(1.3,1.0+_moodVelOff/80));
  }catch(e){}

  // Managed noteOn through VoiceManager
  try{VoiceManager.onNote(midi, volMult, voiceName, scheduleAheadSec);}catch(e){
    try{SoundEngine.noteOn(midi, volMult, voiceName, scheduleAheadSec || 0);}catch(e2){}
  }

  // Research state: emit note event for data collection
  try{EventBus.emit('noteProduced',{pc:pc,voiceName:voiceName,midi:midi,volMult:volMult,time:Date.now()});}catch(e){}

  // Visual
  addToTrail(nd.idx,pc,voiceName);
  _wvNoteOn(voiceName,midi);
  updateVoiceIndicator(voiceName,'active');
}

// ═══ AI VOICE PIPELINE DIAGNOSTIC ═══
// Call window._diagAI() from the console to dump full pipeline state.
// Call window._diagAI(true) for continuous monitoring (logs every 2s).
window._diagAI=function(continuous){
  var d={};
  d.autoMode=autoMode;
  d.masterTickRunning=!!masterIv;
  // Belief gate
  if(typeof BeliefState!=='undefined'){
    d.beliefBass=BeliefState.getBelief('bass');
    d.beliefRhythm=BeliefState.getBelief('rhythm');
    d.beliefSoloist=BeliefState.getBelief('soloist');
    var bp=BeliefState.getParams('bass');d.bassGateProb=bp?bp.gateProb:'?';
    bp=BeliefState.getParams('rhythm');d.rhythmGateProb=bp?bp.gateProb:'?';
    bp=BeliefState.getParams('soloist');d.soloistGateProb=bp?bp.gateProb:'?';
  }else d.beliefState='NOT LOADED';
  // Behavior modes
  if(typeof BehaviorModes!=='undefined'){
    d.behaviorBass=BehaviorModes.getMode('bass');
    d.behaviorRhythm=BehaviorModes.getMode('rhythm');
    d.behaviorSoloist=BehaviorModes.getMode('soloist');
  }
  // Phase coupling
  if(typeof PhaseCoupling!=='undefined')d.phaseCoupling=PhaseCoupling.getState();
  // Scheduler
  if(typeof Scheduler!=='undefined'){
    d.schedulerBass=Scheduler.hasActivePhrase('bass');
    d.schedulerRhythm=Scheduler.hasActivePhrase('rhythm');
    d.schedulerSoloist=Scheduler.hasActivePhrase('soloist');
  }
  // Scope muted state
  d.scopeMuted={
    bass:typeof BassAssistant!=='undefined'?BassAssistant.scope.muted:'?',
    rhythm:typeof RhythmAssistant!=='undefined'?RhythmAssistant.scope.muted:'?',
    soloist:typeof SoloAssistant!=='undefined'?SoloAssistant.scope.muted:'?'
  };
  // Error counts
  d.errors={bass:window._bassErrCount||0,rhythm:window._rhythmErrCount||0,soloist:window._soloErrCount||0};
  // Per-voice gate diagnostics
  if(typeof BassAssistant!=='undefined'&&typeof BassAssistant.getDiag==='function'){
    d.bassDiag=BassAssistant.getDiag();
    d.bassLexiconLoaded=BassAssistant.getLexiconLoaded();
  }
  if(typeof RhythmAssistant!=='undefined'&&typeof RhythmAssistant.getDiag==='function')d.rhythmDiag=RhythmAssistant.getDiag();
  if(typeof SoloAssistant!=='undefined'&&typeof SoloAssistant.getDiag==='function')d.soloistDiag=SoloAssistant.getDiag();
  // Tick counter for note production
  if(!window._diagNoteCount)window._diagNoteCount={bass:0,rhythm:0,soloist:0,total:0};
  d.notesProduced=Object.assign({},window._diagNoteCount);
  console.log('%c=== AI VOICE DIAGNOSTIC ===','color:#ff0;font-weight:bold;font-size:14px');
  for(var k in d){if(typeof d[k]==='object'&&d[k]!==null)console.log(k+':',JSON.stringify(d[k]));else console.log(k+':',d[k]);}
  if(continuous){
    if(window._diagInterval)clearInterval(window._diagInterval);
    window._diagInterval=setInterval(function(){window._diagAI();},2000);
    console.log('Continuous monitoring ON (every 2s). Call window._diagAI.stop() to stop.');
  }
  return d;
};
window._diagAI.stop=function(){if(window._diagInterval){clearInterval(window._diagInterval);window._diagInterval=null;console.log('Diagnostic monitoring stopped.');}};

// ═══ TONNETZ GRID (copied from v2) ═══
function buildGrid(){
  nodes=[];edges=[];adjMap={};triangles=[];
  var hG=NR*3.2*zoomLevel,vG=NR*2.8*zoomLevel,sX=hG*.55;
  var gW=(COLS-1)*hG+(ROWS-1)*sX,gH=(ROWS-1)*vG;
  var oX=(W/dpr-gW)/2+panX,oY=(H/dpr-gH)/2+panY;
  var base=48,grid=[];
  for(var r=0;r<ROWS;r++){grid[r]=[];for(var c=0;c<COLS;c++){
    var midi=base+c*7+(ROWS-1-r)*4,pc=((midi%12)+12)%12;
    var nd={x:oX+c*hG+(ROWS-1-r)*sX,y:oY+r*vG,note:pc,name:N[pc],row:r,col:c,idx:nodes.length,playCount:0,midi:midi,hitTime:0,hitSource:'human',energy:0};
    nodes.push(nd);grid[r][c]=nd;adjMap[nd.idx]=[];}}
  for(r=0;r<ROWS;r++)for(c=0;c<COLS;c++){var nd=grid[r][c];
    if(c<COLS-1){edges.push({a:nd.idx,b:grid[r][c+1].idx,ct:0,tp:'fifth',heat:0,fl:false,fT:0,fd:1});adjMap[nd.idx].push(grid[r][c+1].idx);adjMap[grid[r][c+1].idx].push(nd.idx);}
    if(r>0){edges.push({a:nd.idx,b:grid[r-1][c].idx,ct:0,tp:'maj',heat:0,fl:false,fT:0,fd:1});adjMap[nd.idx].push(grid[r-1][c].idx);adjMap[grid[r-1][c].idx].push(nd.idx);}
    if(r<ROWS-1&&c<COLS-1){edges.push({a:nd.idx,b:grid[r+1][c+1].idx,ct:0,tp:'min',heat:0,fl:false,fT:0,fd:1});adjMap[nd.idx].push(grid[r+1][c+1].idx);adjMap[grid[r+1][c+1].idx].push(nd.idx);}}
  // Triangles
  for(r=0;r<ROWS;r++)for(c=0;c<COLS;c++){
    if(c<COLS-1&&r<ROWS-1){var a=grid[r][c],b=grid[r][c+1],d=grid[r+1][c+1];
      triangles.push({nodes:[a.idx,b.idx,d.idx],cx:(a.x+b.x+d.x)/3,cy:(a.y+b.y+d.y)/3,type:'minor',
        midis:[a.midi,d.midi,b.midi],rootPC:a.note,name:a.name+'m',notes:[a.note,d.note,b.note]});}
    if(r<ROWS-1&&c<COLS-1){var a=grid[r+1][c],b=grid[r][c],d=grid[r+1][c+1];
      var cx3=(a.x+b.x+d.x)/3,cy3=(a.y+b.y+d.y)/3;
      var isDup=false;for(var ti=0;ti<triangles.length;ti++)if(Math.abs(triangles[ti].cx-cx3)<1&&Math.abs(triangles[ti].cy-cy3)<1){isDup=true;break;}
      if(!isDup)triangles.push({nodes:[a.idx,b.idx,d.idx],cx:cx3,cy:cy3,type:'major',
        midis:[a.midi,b.midi,d.midi],rootPC:a.note,name:a.name,notes:[a.note,b.note,d.note]});}}
}

// Heat functions
function adaptiveHeat(count){if(count===0)return 0;var mx=1;for(var i=0;i<nodes.length;i++)if(nodes[i].playCount>mx)mx=nodes[i].playCount;return Math.max(.12,Math.min(1,Math.log1p(count)/Math.log1p(mx)));}
function adaptiveEdgeHeat(count){if(count===0)return 0;var mx=1;for(var i=0;i<edges.length;i++)if(edges[i].ct>mx)mx=edges[i].ct;return Math.max(.08,Math.min(1,Math.log1p(count)/Math.log1p(mx)));}
function heatRGB(t) {
  // Amber heat ramp: dark green → forest → amber → molten gold
  // Quantized to 12 discrete levels for early-digital aesthetic
  t = Math.max(0, Math.min(1, t));
  t = Math.round(t * 11) / 11; // 12-step quantization
  var r, g, b;
  if (t < 0.12) {
    var u = t / 0.12;
    r = 13 + 4 * u;  g = 16 + 32 * u;  b = 15 - 6 * u;
  } else if (t < 0.30) {
    var u = (t - 0.12) / 0.18;
    r = 17 + 28 * u;  g = 48 + 22 * u;  b = 9 - 4 * u;
  } else if (t < 0.55) {
    var u = (t - 0.30) / 0.25;
    r = 45 + 90 * u;  g = 70 + 45 * u;  b = 5 + 4 * u;
  } else if (t < 0.78) {
    var u = (t - 0.55) / 0.23;
    r = 135 + 60 * u;  g = 115 - 10 * u;  b = 9;
  } else {
    var u = (t - 0.78) / 0.22;
    r = 195 + 12 * u;  g = 105 + 15 * u;  b = 9;
  }
  return {r: Math.min(255, r | 0), g: Math.max(0, g | 0), b: Math.max(0, b | 0)};
}
function heatCSS(t, a) {
  var c = heatRGB(t);
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
}
// Find node (path on Tonnetz)
var lastNodeIdx=null;
function findNode(pc,source){
  if(lastNodeIdx===null){var cx2=W/dpr/2,cy2=H/dpr/2,b=null,bd=1e9;
    for(var i=0;i<nodes.length;i++){if(nodes[i].note!==pc)continue;var d=Math.hypot(nodes[i].x-cx2,nodes[i].y-cy2);if(d<bd){bd=d;b=nodes[i];}}return b;}
  var cur=nodes[lastNodeIdx],nbrs=adjMap[lastNodeIdx]||[];
  for(var i=0;i<nbrs.length;i++)if(nodes[nbrs[i]].note===pc)return nodes[nbrs[i]];
  for(var i=0;i<nbrs.length;i++)for(var j=0;j<(adjMap[nbrs[i]]||[]).length;j++){var ni=adjMap[nbrs[i]][j];if(nodes[ni].note===pc&&ni!==lastNodeIdx)return nodes[ni];}
  var b=null,bd=1e9;for(var i=0;i<nodes.length;i++){if(nodes[i].note!==pc)continue;var d=Math.hypot(nodes[i].x-cur.x,nodes[i].y-cur.y);if(d<bd){bd=d;b=nodes[i];}}return b;
}

// ═══ TRAIL + VISUAL STATE ═══
function addToTrail(nodeIdx,pc,source){
  // Register hit flash
  nodes[nodeIdx].hitTime=Date.now();nodes[nodeIdx].hitSource=source;nodes[nodeIdx].energy=1.0;
  if(trail.length>0){var pi=trail[trail.length-1].idx;
    var sameSource=(typeof _trailSameSource==='undefined'||_trailSameSource);
    if(sameSource){for(var i=0;i<edges.length;i++){var e=edges[i];if((e.a===pi&&e.b===nodeIdx)||(e.b===pi&&e.a===nodeIdx)){e.ct++;e.heat=1.0;e.fl=true;e.fT=0;e.fd=(e.a===pi)?1:-1;break;}}}}
  nodes[nodeIdx].playCount++;pcCounts[pc]++;total++;
  trail.push({idx:nodeIdx,note:pc,time:Date.now(),src:source});if(trail.length>40)trail.shift();
  if(source==='human')lastNodeIdx=nodeIdx;
  if(source==='human')_humanLastTrailIdx=nodeIdx;
}

function updateVoiceIndicator(name,state){
  var el=document.getElementById('vi'+name.charAt(0).toUpperCase()+name.slice(1));
  if(el)el.className='vi vi-'+name+' '+state;
}

// ═══ ONSET / CHORD DETECTION ═══
var onsetBuffer=[],ARPEGGIO_WINDOW=250;
var TRIAD_TYPES=[{intervals:[0,3,7],type:'minor'},{intervals:[0,4,7],type:'major'},{intervals:[0,3,6],type:'dim'},{intervals:[0,4,8],type:'aug'}];
function detectTriad(pcs){
  for(var ri=0;ri<pcs.length;ri++){var root=pcs[ri];
    var ints=pcs.map(function(p){return((p-root)%12+12)%12;}).sort(function(a,b){return a-b;});
    var unique=[];for(var i=0;i<ints.length;i++)if(i===0||ints[i]!==ints[i-1])unique.push(ints[i]);
    if(unique.length<3)continue;
    for(var ti=0;ti<TRIAD_TYPES.length;ti++){var tt=TRIAD_TYPES[ti],match=true;
      for(var k=0;k<tt.intervals.length;k++)if(unique.indexOf(tt.intervals[k])<0){match=false;break;}
      if(match)return{rootPC:root,type:tt.type};}}
  return null;
}
function onsetCheck(pc){
  var now=Date.now();onsetBuffer.push({pc:pc,time:now});
  onsetBuffer=onsetBuffer.filter(function(e){return now-e.time<ARPEGGIO_WINDOW;});
  if(onsetBuffer.length<3)return;
  var pcs=[],seen={};for(var i=0;i<onsetBuffer.length;i++)if(!seen[onsetBuffer[i].pc]){pcs.push(onsetBuffer[i].pc);seen[onsetBuffer[i].pc]=true;}
  if(pcs.length<3)return;
  var chord=detectTriad(pcs);
  if(chord){SharedState.recordChord(chord.rootPC,chord.type);
    var label=document.getElementById('triLabel');
    label.textContent=N[chord.rootPC]+(chord.type==='minor'?'m':chord.type==='dim'?'°':chord.type==='aug'?'+':'');
    label.classList.add('show');setTimeout(function(){label.classList.remove('show');},1200);
    onsetBuffer=[];
    EventBus.emit('chordChanged',chord);
  }
}

// ═══ GLOBAL NOTE INPUT (Event-Action: EVENT phase) ═══
// holdMode: if true, note is sustained until manually released (click-and-hold)
window.onNoteInput=function(pc,midi,register,velocityMult,clickNodeIdx,holdMode){
  register=register||(midi<48?'bass':midi<72?'rhythm':'soloist');
  var now=Date.now();
  
  // Sound — managed noteOn (sustain on hold, release on keyUp/MIDI noteOff)
  // Phase 13: pass 1.0 as base vol — humanVol fader controls the human strip
  // gain, no need to also feed it into the ADSR envelope (was double attenuation).
  // MIDI velocity still scales the note via velocityMult.
  var humanVol=1.0;
  if(typeof velocityMult==='number')humanVol*=velocityMult;
  var noteResult=SoundEngine.noteOn(midi||(pc+60),humanVol,'human');
  var humanNoteId=(noteResult&&noteResult.noteId)||null;
  _wvNoteOn('human',midi||(pc+60));

  // Phase 14: holdMode — note sustains until explicit release (mouseup/touchend).
  // Non-hold clicks (keyboard, old codepaths) still auto-release.
  if(!holdMode&&typeof clickNodeIdx==='number'&&humanNoteId!==null){
    var clickSustainSec=0.15+(SoundEngine.getSustain?SoundEngine.getSustain():0.5)*1.2;
    setTimeout(function(){
      try{SoundEngine.noteOff('human',humanNoteId);}catch(e){}
      // Also release the oscilloscope waveform envelope
      if(typeof window._wvNoteOff==='function')window._wvNoteOff('human');
    },clickSustainSec*1000);
  }
  
  // EVENT PHASE: pure observation
  TempoEngine.onHumanNote(now,register);
  SharedState.trackHumanIC(pc,pcProbs);
  SharedState.updateKey(pc);
  if(typeof SharedState.updateKeyWeighted==='function')SharedState.updateKeyWeighted(pc,register);
  // v3 Phase 1: Feed human notes to per-voice key beliefs
  if(typeof EventBus!=='undefined')EventBus.emit('humanNote',{pc:pc,register:register});
  if(typeof GestureClassifier!=='undefined')GestureClassifier.onHumanNote(pc,midi,velocityMult);
  SharedState.updatePhraseBoundary(pc,total);
  onsetCheck(pc);
  lastHumanNoteTime=now;
  
  // Gen3: ownership + assistant observation + coordinator awareness
  // v3.8.2: Human notes always feed into all context systems (no ownership gating).
  // Human is a peer — all voices hear and adapt, none are muted.
  try{
    if(typeof FinalCoordinator!=='undefined')FinalCoordinator.recordHumanNote(pc,register,now);
    if(typeof BarTracker!=='undefined')BarTracker.onHumanNote(pc,register,now);
    if(typeof SharedLoopDetector!=='undefined')SharedLoopDetector.observeNote(pc,register,now);
    if(typeof SectionTracker!=='undefined')SectionTracker.onNote(pc,register,now,true);
    if(typeof DialogueEngine!=='undefined')DialogueEngine.onHumanNote(now);
    if(typeof ContextIntegrator!=='undefined')ContextIntegrator.onNote('human',pc,'human',0.5,velocityMult);
    if(typeof BassAssistant!=='undefined'){
      if(register==='bass')BassAssistant.observePlayerNote(pc,now);
      else if(register==='rhythm')RhythmAssistant.observePlayerNote(pc,now);
      else if(register==='soloist')SoloAssistant.observePlayerNote(pc,now);
    }
  }catch(e){}

  // Visual — use exact clicked node when available, findNode for keyboard/MIDI
  var nd=(typeof clickNodeIdx==='number'&&nodes[clickNodeIdx])?nodes[clickNodeIdx]:findNode(pc,'human');
  if(nd){addToTrail(nd.idx,pc,'human');lastNodeIdx=nd.idx;}

  // Update shared prediction (for Tonnetz glow)
  pcProbs=SharedState.predict(pc,voices.rhythm.stm,SharedState.genre);

  // v3.8.2: No muting — all voices stay active. Cross-notes feed context.
  for(var v in voices){
    voices[v].crossNotes=[pc];
  }
  
  // Feed human note to the relevant voice's STM (so it learns the player's patterns in that register)
  voices[register].observeNote(pc);
  
  // Replan check for other voices
  for(var v in voices){
    if(v!==register&&voices[v].shouldReplan({type:'humanNote'})){
      voices[v].playstring=null; // force replan on next tick
    }
  }
  
  // Unfreeze all voices on human activity (graceful decay recovery)
  silenceBeats=0;
  for(var v in voices){voices[v].scope.frozen=false;}
  
  // UI
  updateUI();
  return humanNoteId;
};

// Tonnetz click handler for processTriad
// holdMode: if true, returns noteIds array for manual release (no auto-release)
function processTriad(tri, holdMode){
  // Phase 13: pass 1.0 — humanVol fader controls strip gain, not ADSR peak
  var triNoteIds=[];
  tri.midis.forEach(function(m){
    var res=SoundEngine.noteOn(m,1.0,'human');
    if(res&&res.noteId)triNoteIds.push(res.noteId);
    _wvNoteOn('human',m);
  });
  // Phase 14: holdMode — chord sustains until explicit release (mouseup/touchend)
  if(!holdMode){
    var relSec=0.35+(SoundEngine.getSustain?SoundEngine.getSustain():0.5)*0.9;
    setTimeout(function(){
      triNoteIds.forEach(function(nid){try{SoundEngine.noteOff('human',nid);}catch(e){}});
      if(typeof window._wvNoteOff==='function')window._wvNoteOff('human');
    },relSec*1000);
  }
  SharedState.recordChord(tri.rootPC,tri.type);
  EventBus.emit('chordChanged',{rootPC:tri.rootPC,type:tri.type});
  var nd=findNode(tri.rootPC,'human');
  if(nd){addToTrail(nd.idx,tri.rootPC,'human');lastNodeIdx=nd.idx;}
  pcProbs=SharedState.predict(tri.rootPC,voices.rhythm.stm,SharedState.genre);
  var label=document.getElementById('triLabel');
  label.textContent=N[tri.rootPC]+(tri.type==='minor'?'m':'');
  label.classList.add('show');setTimeout(function(){label.classList.remove('show');},1500);
  updateUI();
  return triNoteIds;
}



function updateUI(){
  document.getElementById('sN').textContent=total;
  var lastT=trail.length>0?trail[trail.length-1]:null;
  document.getElementById('sC').textContent=lastT?nodes[lastT.idx].name+Math.floor(nodes[lastT.idx].midi/12-1):'\u2014';
  document.getElementById('sKey').textContent='Key: '+N[SharedState.keyC]+(SharedState.mode==='minor'?'m':'');
  document.getElementById('keySelect').value=String(SharedState.keyC);
  document.getElementById('modeSelect').value=SharedState.mode;
  // Path bar
  var pb=document.getElementById('pathBar');
  pb.innerHTML='<span class="path-label">PATH</span>';
  if(!trail.length){pb.innerHTML+='<span class="path-ph">Play with keyboard A-L or click nodes</span>';return;}
  trail.slice(-40).forEach(function(t,i,arr){var nd=nodes[t.idx],s=document.createElement('span');
    var cls='path-note';
    if(i===arr.length-1)cls+=' current';
    if(t.src!=='human')cls+=' '+t.src;
    s.className=cls;s.textContent=nd.name+Math.floor(nd.midi/12-1);pb.appendChild(s);});
  pb.scrollLeft=pb.scrollWidth;
}

function draw() {
  requestAnimationFrame(draw);
  // Skip 2D canvas drawing when 3D timbral space is active
  if (typeof TimbralSpace !== 'undefined' && TimbralSpace.isActive()) return;

  var now = Date.now();
  var dt = _lastFrameTime ? (now - _lastFrameTime) : 16;
  _lastFrameTime = now;
  if (dt > 50) dt = 50;

  // ── Beat phase (single-beat cycle, not 4-bar) ──
  var bpm = TempoEngine.getEffectiveBPM();
  var prevPhase = _beatPhase;
  _beatPhase = (_beatPhase + (dt / 1000) * (bpm / 60)) % 1;
  var beatFired = _beatPhase < prevPhase;
  // Envelope: sharp attack, exponential decay
  var env = _beatPhase < 0.1 ? (_beatPhase / 0.1) : Math.exp(-(_beatPhase - 0.1) * 5.5);
  var bs = 1 + env * 0.034; // beat-synced scale factor

  // Fire beat pulses on tonic nodes
  if (beatFired) {
    for (var bpi = 0; bpi < nodes.length; bpi++) {
      if (nodes[bpi].note === SharedState.keyC) {
        _beatPulses.push({x: nodes[bpi].x, y: nodes[bpi].y, t: now, phase: Math.random() * 0.12});
      }
    }
    // BPM display flash
    var bpmEl = document.getElementById('tempoDisp');
    if (bpmEl) {
      bpmEl.style.textShadow = '0 0 14px rgba(200,120,0,0.7)';
      setTimeout(function() { bpmEl.style.textShadow = '0 0 8px rgba(200,120,0,0.22)'; }, 90);
    }
  }

  cx.clearRect(0, 0, W, H);
  cx.save();
  cx.scale(dpr, dpr);

  var maxPC = 0;
  for (var i = 0; i < 12; i++) if (pcProbs[i] > maxPC) maxPC = pcProbs[i];
  if (maxPC < 0.001) maxPC = 0.001;
  var eNR = NR * zoomLevel;
  var lastTrailItem = trail.length > 0 ? trail[trail.length - 1] : null;
  var curIdx = (typeof _humanLastTrailIdx !== 'undefined' && _humanLastTrailIdx !== null)
    ? _humanLastTrailIdx : (lastTrailItem ? lastTrailItem.idx : null);

  // Build scale set (plain object for fast lookup, matching mockup)
  var scArr = (SCALES[SharedState.mode] || SCALES.major).map(function(n) { return (n + SharedState.keyC) % 12; });
  var ss = {};
  for (var si = 0; si < scArr.length; si++) ss[scArr[si]] = true;

  // ════════════════════════════════════════════════
  // PASS 0 — CRT scanlines (subtle horizontal lines)
  // ════════════════════════════════════════════════
  cx.fillStyle = 'rgba(255,255,255,0.008)';
  for (var ly = 0; ly < H / dpr; ly += 7) {
    cx.fillRect(0, ly, W / dpr, 0.5);
  }

  // ════════════════════════════════════════════════
  // PASS 1 — Beat pulse rings (tight, fast-decay — not cartoon explosions)
  // ════════════════════════════════════════════════
  _beatPulses = _beatPulses.filter(function(bp) { return now - bp.t < 550; });
  for (var bri = 0; bri < _beatPulses.length; bri++) {
    var bp = _beatPulses[bri];
    var bpAge = (now - bp.t) / 550;
    // Expand only 2.5× (was 5×) — tighter physical pulse
    var bpR = eNR * (1.05 + bpAge * 2.5);
    cx.beginPath();
    cx.arc(bp.x, bp.y, bpR, 0, Math.PI * 2);
    cx.strokeStyle = 'rgba(210,165,40,' + ((1 - bpAge) * 0.15 * (0.5 + env * 0.5)) + ')';
    cx.lineWidth = 0.7;
    cx.stroke();
  }

  // ════════════════════════════════════════════════
  // PASS 2 — Prediction glow halos (tight, muted — not cartoon blobs)
  // ════════════════════════════════════════════════
  if (curIdx !== null) {
    var n1 = new Set(adjMap[curIdx] || []), n2 = new Set();
    n1.forEach(function(ni) {
      (adjMap[ni] || []).forEach(function(ni2) {
        if (ni2 !== curIdx && !n1.has(ni2)) n2.add(ni2);
      });
    });
    var gl = Array.from(n1).concat(Array.from(n2));
    for (var gi = 0; gi < gl.length; gi++) {
      var gni = gl[gi], gnd = nodes[gni], gp = pcProbs[gnd.note];
      if (gp < 0.02) continue;
      var gInt = Math.pow(gp / maxPC, 0.5);
      var gHop = n1.has(gni) ? 1 : 0.45;
      // Tight halos: radius only 1.1× node, not 3×
      var glR = eNR * (0.95 + gInt * gHop * 0.8);
      var ggr = cx.createRadialGradient(gnd.x, gnd.y, 0, gnd.x, gnd.y, glR);
      ggr.addColorStop(0, 'rgba(220,170,55,' + (gInt * gHop * 0.10 * (1 + env * 0.18)) + ')');
      ggr.addColorStop(1, 'rgba(220,170,55,0)');
      cx.fillStyle = ggr;
      cx.beginPath();
      cx.arc(gnd.x, gnd.y, glR, 0, Math.PI * 2);
      cx.fill();
    }
  }

  // ════════════════════════════════════════════════
  // PASS 3 — In-scale ambient glow (tight forest-green wash — less cartoon blob)
  // ════════════════════════════════════════════════
  for (var sgi = 0; sgi < nodes.length; sgi++) {
    var sgnd = nodes[sgi];
    if (!ss[sgnd.note]) continue;
    var sggr = cx.createRadialGradient(sgnd.x, sgnd.y, eNR * 0.4, sgnd.x, sgnd.y, eNR * 1.25);
    sggr.addColorStop(0, 'rgba(14,58,32,' + (0.09 + env * 0.03) + ')');
    sggr.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = sggr;
    cx.beginPath();
    cx.arc(sgnd.x, sgnd.y, eNR * 1.25, 0, Math.PI * 2);
    cx.fill();
  }

  // ════════════════════════════════════════════════
  // PASS 4 — Edges (heat + flow particles)
  // ════════════════════════════════════════════════
  for (var ei = 0; ei < edges.length; ei++) {
    var e = edges[ei];
    // Decay heat
    if (e.heat > 0) e.heat = Math.max(0, e.heat - 0.0055);
    var ea = nodes[e.a], eb = nodes[e.b];
    // Base edge stroke (dark green lattice)
    var eba = 0.032 + (e.ct > 0 ? Math.min(e.ct / 8, 1) * 0.09 : 0);
    cx.strokeStyle = 'rgba(28,45,34,' + eba + ')';
    cx.lineWidth = 0.45 + (e.ct > 0 ? Math.min(e.ct / 6, 1) * 0.65 : 0);
    cx.beginPath(); cx.moveTo(ea.x, ea.y); cx.lineTo(eb.x, eb.y); cx.stroke();

    // Heat-activated gradient overlay
    if (e.heat > 0.05) {
      var ecol = e.tp === 'fifth' ? '0,185,105' : e.tp === 'maj' ? '185,125,12' : '130,150,205';
      var egr = cx.createLinearGradient(ea.x, ea.y, eb.x, eb.y);
      egr.addColorStop(0, 'rgba(' + ecol + ',0)');
      egr.addColorStop(0.5, 'rgba(' + ecol + ',' + (e.heat * 0.48) + ')');
      egr.addColorStop(1, 'rgba(' + ecol + ',0)');
      cx.strokeStyle = egr;
      cx.lineWidth = 1.3;
      cx.beginPath(); cx.moveTo(ea.x, ea.y); cx.lineTo(eb.x, eb.y); cx.stroke();
    }

    // Traveling flow particle
    if (e.fl) {
      e.fT += 0.032;
      if (e.fT >= 1) { e.fl = false; e.fT = 0; }
      else {
        var ft = e.fd > 0 ? e.fT : 1 - e.fT;
        var fpx = ea.x + (eb.x - ea.x) * ft;
        var fpy = ea.y + (eb.y - ea.y) * ft;
        var fpc = e.tp === 'fifth' ? '22,185,95' : '185,125,12';
        var fpgr = cx.createRadialGradient(fpx, fpy, 0, fpx, fpy, 6.5);
        fpgr.addColorStop(0, 'rgba(' + fpc + ',0.88)');
        fpgr.addColorStop(1, 'rgba(' + fpc + ',0)');
        cx.fillStyle = fpgr;
        cx.beginPath(); cx.arc(fpx, fpy, 6.5, 0, Math.PI * 2); cx.fill();
      }
    }
  }

  // ════════════════════════════════════════════════
  // PASS 4.5 — Triangle hover (app-specific, preserved)
  // ════════════════════════════════════════════════
  if (hovTri !== null && hovTri < triangles.length) {
    var htri = triangles[hovTri];
    var hns = htri.nodes.map(function(ni) { return nodes[ni]; });
    cx.beginPath();
    cx.moveTo(hns[0].x, hns[0].y);
    cx.lineTo(hns[1].x, hns[1].y);
    cx.lineTo(hns[2].x, hns[2].y);
    cx.closePath();
    cx.fillStyle = htri.type === 'major' ? 'rgba(200,160,60,.06)' : 'rgba(100,140,200,.06)';
    cx.fill();
    cx.strokeStyle = htri.type === 'major' ? 'rgba(200,160,60,.15)' : 'rgba(100,140,200,.15)';
    cx.lineWidth = 0.5;
    cx.stroke();
  }

  // ════════════════════════════════════════════════
  // PASS 5 — Human trail (golden gradient lines)
  // ════════════════════════════════════════════════
  var hTrail = [];
  for (var hti = 0; hti < trail.length; hti++) {
    if (trail[hti].src === 'human' && (now - trail[hti].time) < 3200) hTrail.push(trail[hti]);
  }
  if (hTrail.length > 1) {
    for (var hti2 = 1; hti2 < hTrail.length; hti2++) {
      var hta = nodes[hTrail[hti2 - 1].idx], htb = nodes[hTrail[hti2].idx];
      if (!hta || !htb) continue;
      var htAge = (now - hTrail[hti2].time) / 3200;
      var htAl = (1 - htAge) * 0.28;
      var htgr = cx.createLinearGradient(hta.x, hta.y, htb.x, htb.y);
      htgr.addColorStop(0, 'rgba(255,190,35,0)');
      htgr.addColorStop(0.5, 'rgba(255,190,35,' + htAl + ')');
      htgr.addColorStop(1, 'rgba(255,190,35,0)');
      cx.strokeStyle = htgr;
      cx.lineWidth = 1.0;
      cx.beginPath(); cx.moveTo(hta.x, hta.y); cx.lineTo(htb.x, htb.y); cx.stroke();
    }
  }

  // ════════════════════════════════════════════════
  // PASS 6 — Hit flashes (tight phosphor flash — not cartoon rings)
  // ════════════════════════════════════════════════
  var HIT_DUR = 620;
  var VOICE_COLORS = {
    human:  {r: 240, g: 200, b: 60},
    bass:   {r: 26,  g: 184, b: 100},
    rhythm: {r: 215, g: 132, b: 12},
    soloist: {r: 195, g: 178, b: 22}
  };
  for (var fi = 0; fi < nodes.length; fi++) {
    var fnd = nodes[fi];
    if (!fnd.hitTime) continue;
    var fel = now - fnd.hitTime;
    if (fel > HIT_DUR) continue;
    var fht = fel / HIT_DUR;
    var fease = 1 - Math.pow(1 - fht, 3);
    var isHuman = fnd.hitSource === 'human';
    var fc = VOICE_COLORS[fnd.hitSource] || VOICE_COLORS.human;
    var ffm = isHuman ? 1.0 : 0.22;

    // Single expanding ring (was double) — tighter radius growth
    cx.beginPath();
    cx.arc(fnd.x, fnd.y, eNR * (1.2 + fease * 2.0), 0, Math.PI * 2);
    cx.strokeStyle = 'rgba(' + fc.r + ',' + fc.g + ',' + fc.b + ',' + ((1 - fht) * 0.55 * ffm) + ')';
    cx.lineWidth = isHuman ? 1.1 : 0.55;
    cx.stroke();

    // Small inner bloom — tight, not a full corona
    var fbR = eNR * (0.72 + fease * 0.22);
    var fbA = (1 - fht) * (1 - fht) * 0.32 * ffm;
    var fbgr = cx.createRadialGradient(fnd.x, fnd.y, 0, fnd.x, fnd.y, fbR);
    fbgr.addColorStop(0, 'rgba(' + fc.r + ',' + fc.g + ',' + fc.b + ',' + fbA + ')');
    fbgr.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = fbgr;
    cx.beginPath();
    cx.arc(fnd.x, fnd.y, fbR, 0, Math.PI * 2);
    cx.fill();
  }

  // ════════════════════════════════════════════════
  // PASS 7 — Node bodies (amber heat ramp, mockup rendering)
  // ════════════════════════════════════════════════
  for (var ni = 0; ni < nodes.length; ni++) {
    var nd = nodes[ni];
    // Energy decay (phosphor persistence)
    if (nd.energy > 0) nd.energy = Math.max(0, nd.energy - 0.020);

    var inSc = !!ss[nd.note];
    var isTon = nd.note === SharedState.keyC;
    var heat = Math.min(nd.playCount / 8, 1);
    var p = pcProbs[nd.note];
    var isCur = ni === curIdx;
    var isH = ni === hovIdx;

    // Beat-synced radius modulation
    var bsR = isTon ? bs * (1 + env * 0.010)
      : (inSc ? 1 + (bs - 1) * 0.85 : 1 + (bs - 1) * 0.30);

    // App-specific: animated nodeRadii for scale transitions
    var targetR = inSc ? 1.0 : 0.65;
    if (!nodeTargetRadii[ni]) nodeTargetRadii[ni] = targetR;
    if (!nodeRadii[ni]) nodeRadii[ni] = targetR;
    nodeTargetRadii[ni] = targetR;
    nodeRadii[ni] += (nodeTargetRadii[ni] - nodeRadii[ni]) * 0.08;

    var r = (eNR * nodeRadii[ni] + nd.energy * eNR * 0.17) * bsR;

    // ── Node fill color: amber heat ramp (12-step quantized like early SGI palette) ──
    var ri, gi, bi;
    if (heat > 0.01) {
      // Quantize heat to 12 steps — stepped color ramp, not smooth interpolation
      var hq = Math.round(heat * 11) / 11;
      ri = Math.round(18 + hq * 185);
      gi = Math.round(30 + hq * 100 * (inSc ? 1.2 : 0.45));
      bi = 8;
    } else if (inSc) {
      ri = 15; gi = 46; bi = 26;
    } else {
      ri = 12; gi = 15; bi = 14;
    }
    if (isTon) {
      ri = Math.min(255, ri + 44);
      gi = Math.min(255, gi + 28);
    }

    // Chromatic aberration on hot nodes
    var aberr = (nd.energy > 0.3 || heat > 0.6) ? 1.2 : 0;

    var nba = inSc ? (0.50 + heat * 0.42) : (0.18 + heat * 0.22);

    // Hard drop shadow (small, sharp — not a soft bloom)
    cx.beginPath();
    cx.arc(nd.x + 1, nd.y + 1, r, 0, Math.PI * 2);
    cx.fillStyle = 'rgba(0,0,0,0.72)';
    cx.fill();

    // Chromatic aberration pass (red channel offset — CRT electron beam misalignment)
    if (aberr > 0) {
      cx.beginPath();
      cx.arc(nd.x - aberr, nd.y, r, 0, Math.PI * 2);
      cx.fillStyle = 'rgba(' + Math.min(255, ri + 32) + ',0,0,' + (nba * 0.14) + ')';
      cx.fill();
    }

    // Main node fill
    cx.beginPath();
    cx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
    cx.fillStyle = 'rgba(' + ri + ',' + gi + ',' + bi + ',' + nba + ')';
    cx.fill();

    // ── Per-node CRT scanlines (clipped to node circle) ──
    // Makes nodes look rendered on a phosphor screen, not a clean LCD
    cx.save();
    cx.beginPath();
    cx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
    cx.clip();
    cx.fillStyle = 'rgba(0,0,0,0.11)';
    var scanStep = 3;
    var scanStart = Math.ceil((nd.y - r) / scanStep) * scanStep;
    for (var sl = scanStart; sl < nd.y + r; sl += scanStep) {
      cx.fillRect(nd.x - r - 1, sl, r * 2 + 2, 1);
    }
    cx.restore();

    // ── Rim stroke — thin etched line, not a glow ring ──
    if (inSc || heat > 0.04) {
      var rma = inSc ? 0.28 + heat * 0.38 : heat * 0.24;
      var rmc = isTon ? '220,175,40' : (heat > 0.3 ? '185,118,18' : '18,96,50');
      cx.beginPath();
      cx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(' + rmc + ',' + rma + ')';
      cx.lineWidth = isTon ? 1.2 : 0.7;
      cx.stroke();
    }

    // ── Tonic beat ring — thin single ring, not a bloom ──
    if (isTon && env > 0.12) {
      cx.beginPath();
      cx.arc(nd.x, nd.y, r + 2 + env * 2.5, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(215,175,38,' + (env * 0.15) + ')';
      cx.lineWidth = 0.6;
      cx.stroke();
    }

    // ── Prediction dashed ring ──
    if (p > 0.11 && !nd.energy) {
      cx.setLineDash([3.5 + p * 4.5, 3.5]);
      cx.beginPath();
      cx.arc(nd.x, nd.y, r + 4.5 + p * 3.5, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(50,120,190,' + (p * 0.52) + ')';
      cx.lineWidth = 0.75;
      cx.stroke();
      cx.setLineDash([]);
    }

    // ── Inner circle on hot nodes ──
    if (nd.playCount > 2) {
      cx.beginPath();
      cx.arc(nd.x, nd.y, r * 0.50, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(' + (ri + 38) + ',' + (gi + 28) + ',' + bi + ',' + Math.min(0.60, nd.playCount / 10) + ')';
      cx.lineWidth = 0.85;
      cx.stroke();
    }

    // ── Note label (Silkscreen pixel font — dot-matrix / CRT terminal character cell) ──
    var nla = inSc ? 0.72 + heat * 0.28 : 0.18 + heat * 0.28;
    cx.fillStyle = 'rgba(238,212,148,' + nla + ')';
    // Silkscreen at 11/14px gives the pixel-art grid feel from the reference
    var nfSz = Math.max(9, Math.round((isTon ? 14 : 11) * zoomLevel));
    cx.font = '400 ' + nfSz + "px 'Silkscreen','Share Tech Mono','Courier New',monospace";
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    // Slight phosphor text shadow for depth
    cx.shadowColor = 'rgba(200,140,20,0.28)';
    cx.shadowBlur = 3;
    cx.fillText(nd.name, nd.x, nd.y);
    cx.shadowBlur = 0;

    // ── Play-count dot ──
    if (nd.playCount > 0) {
      cx.fillStyle = 'rgba(185,125,18,' + Math.min(0.72, nd.playCount / 5) + ')';
      cx.beginPath();
      cx.arc(nd.x + r * 0.60, nd.y - r * 0.60, 2.1, 0, Math.PI * 2);
      cx.fill();
    }
  }

  // ════════════════════════════════════════════════
  // PASS 8 — Cursor ring (rotating dashes + cardinal dots)
  // ════════════════════════════════════════════════
  if (curIdx !== null) {
    var cnd = nodes[curIdx];
    if (cnd) {
      var ct2 = now * 0.0017;
      var cpr = eNR + 3 + Math.sin(ct2 * 1.7) * 2.2 * (1 + env * 0.4);

      // Outer rotating dashed ring
      cx.save();
      cx.translate(cnd.x, cnd.y);
      cx.rotate(ct2 * 0.32);
      cx.setLineDash([5, 7]);
      cx.beginPath();
      cx.arc(0, 0, cpr + 9, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(255,210,55,0.20)';
      cx.lineWidth = 0.85;
      cx.stroke();
      cx.setLineDash([]);
      cx.restore();

      // Solid inner ring
      cx.beginPath();
      cx.arc(cnd.x, cnd.y, cpr, 0, Math.PI * 2);
      cx.strokeStyle = 'rgba(255,210,55,0.68)';
      cx.lineWidth = 1.4;
      cx.stroke();

      // Four cardinal dots
      for (var cq = 0; cq < 4; cq++) {
        var cang = cq * Math.PI / 2;
        cx.fillStyle = 'rgba(255,210,55,0.60)';
        cx.beginPath();
        cx.arc(cnd.x + Math.cos(cang) * (cpr + 7), cnd.y + Math.sin(cang) * (cpr + 7), 1.7, 0, Math.PI * 2);
        cx.fill();
      }
    }
  }

  // ════════════════════════════════════════════════
  // PASS 9 — Drone ring (Phase 13: redesigned with waveform)
  // ════════════════════════════════════════════════
  if (dialVisible) {
    if (!dialGrabbed && !dialManualOverride && total > 8)
      dialAngle = lerpAngle(dialAngle, dialTargetAngle, 0.04);
    if (ringX === 0 && ringY === 0) { ringX = W / dpr - ringR - 60; ringY = H / dpr / 2; }
    var drCx = ringX, drCy = ringY, rr = ringR;

    // Background fill — dark circle
    cx.beginPath(); cx.arc(drCx, drCy, rr, 0, Math.PI * 2);
    cx.fillStyle = 'rgba(6,6,8,0.65)'; cx.fill();

    // Drone waveform inside ring (drawn before ring stroke so ring overlays)
    if (droneStarted && droneActive && typeof window._drawDroneWaveform === 'function') {
      window._drawDroneWaveform(cx, drCx, drCy, rr, true);
    }

    // Active glow pulse
    if (droneStarted && droneActive) {
      var glowPulse = 0.5 + 0.5 * Math.sin(now / 1000);
      var dGlow = cx.createRadialGradient(drCx, drCy, rr - 6, drCx, drCy, rr + 12);
      dGlow.addColorStop(0, 'rgba(200,160,60,' + (0.03 + glowPulse * 0.03) + ')');
      dGlow.addColorStop(1, 'rgba(200,160,60,0)');
      cx.fillStyle = dGlow;
      cx.beginPath(); cx.arc(drCx, drCy, rr + 12, 0, Math.PI * 2); cx.fill();
    }

    // Outer ring — main stroke
    cx.beginPath(); cx.arc(drCx, drCy, rr, 0, Math.PI * 2);
    cx.strokeStyle = droneStarted ? 'rgba(212,176,64,0.45)' : 'rgba(60,55,40,0.20)';
    cx.lineWidth = 1.5; cx.stroke();

    // Inner ring — subtle accent
    cx.beginPath(); cx.arc(drCx, drCy, rr - 3, 0, Math.PI * 2);
    cx.strokeStyle = droneStarted ? 'rgba(212,176,64,0.14)' : 'rgba(60,55,40,0.06)';
    cx.lineWidth = 0.5; cx.stroke();

    // Dial dot / handle
    var dotX = drCx + Math.cos(dialAngle) * rr, dotY = drCy + Math.sin(dialAngle) * rr;
    var dotR = dialGrabbed ? 6 : 4;
    var dotGlow = cx.createRadialGradient(dotX, dotY, 0, dotX, dotY, dotR + 5);
    dotGlow.addColorStop(0, 'rgba(212,176,64,' + (droneStarted ? 0.55 : 0.25) + ')');
    dotGlow.addColorStop(1, 'rgba(212,176,64,0)');
    cx.fillStyle = dotGlow;
    cx.beginPath(); cx.arc(dotX, dotY, dotR + 5, 0, Math.PI * 2); cx.fill();
    cx.beginPath(); cx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
    cx.fillStyle = dialGrabbed ? 'rgba(255,220,80,0.85)' : 'rgba(212,176,64,0.65)';
    cx.fill();
  }

  // ════════════════════════════════════════════════
  // PASS 10 — Film grain + millennial textures
  // ════════════════════════════════════════════════

  // Film grain (amber-tinted, every 3rd frame like the mockup)
  _noiseOff = (_noiseOff + 1) % 3;
  if (_noiseOff === 0) {
    cx.fillStyle = 'rgba(200,175,110,0.012)';
    for (var gri = 0; gri < 42; gri++) {
      cx.fillRect(Math.random() * (W / dpr), Math.random() * (H / dpr), 1, 1);
    }
  }

  // ── Millennial texture: data-stream traces ──
  // Faint vertical lines that drift slowly, evoking early algorithmic
  // music visualization (Xenakis UPIC, Raster-Noton, Max/MSP patch cables)
  var streamPhase = (now * 0.00003) % 1;
  for (var sti = 0; sti < 5; sti++) {
    var stx = ((streamPhase + sti * 0.2) % 1) * (W / dpr);
    var stAlpha = 0.012 + Math.sin(now * 0.0005 + sti * 1.7) * 0.006;
    cx.strokeStyle = 'rgba(120,95,40,' + stAlpha + ')';
    cx.lineWidth = 0.5;
    cx.beginPath();
    cx.moveTo(stx, 0);
    cx.lineTo(stx + Math.sin(now * 0.001 + sti) * 3, H / dpr);
    cx.stroke();
  }

  // ── Millennial texture: phase marker ticks ──
  // Tiny tick marks along the bottom edge that advance with beat phase,
  // like a sequencer position indicator or tape counter
  var tickY = H / dpr - 3;
  for (var tki = 0; tki < 16; tki++) {
    var tkx = (W / dpr) * (tki / 16 + _beatPhase / 16);
    var tkActive = (tki === Math.floor(_beatPhase * 16));
    cx.fillStyle = tkActive ? 'rgba(200,140,30,0.25)' : 'rgba(60,50,30,0.10)';
    cx.fillRect(tkx, tickY, tkActive ? 2 : 1, tkActive ? 3 : 2);
  }

  cx.restore();
}

// ═══ HIT TESTS ═══
function ringDotAt(mx,my){if(!dialVisible)return false;return Math.hypot(mx-(ringX+Math.cos(dialAngle)*ringR),my-(ringY+Math.sin(dialAngle)*ringR))<14;}
function ringBodyAt(mx,my){if(!dialVisible)return false;var d=Math.hypot(mx-ringX,my-ringY);return d<ringR+10&&d>ringR-20;}
function ringAngleAt(mx,my){return Math.atan2(my-ringY,mx-ringX);}
function applyDialKey(angle){
  var pc=dialAngleToPC(angle);SharedState.keyC=pc;dialAngle=angle;
  if(droneActive)SoundEngine.setDroneKey(pc);
  document.getElementById('sKey').textContent='Key: '+N[pc];
  document.getElementById('keySelect').value=String(pc);
  nodeRadii=[];
  pcProbs=SharedState.predict(pc,voices.rhythm.stm,SharedState.genre);
}
function nodeAt(mx,my){var b=null,bd=1e9,hitR=NR*zoomLevel+6;
  for(var i=0;i<nodes.length;i++){var d=Math.hypot(mx-nodes[i].x,my-nodes[i].y);if(d<hitR&&d<bd){bd=d;b=nodes[i];}}return b;}
function triangleAt(mx,my){
  for(var i=0;i<triangles.length;i++){var tri=triangles[i],ns=tri.nodes.map(function(ni){return nodes[ni];});
    var x1=ns[0].x,y1=ns[0].y,x2=ns[1].x,y2=ns[1].y,x3=ns[2].x,y3=ns[2].y;
    var d1=(mx-x2)*(y1-y2)-(x1-x2)*(my-y2),d2=(mx-x3)*(y2-y3)-(x2-x3)*(my-y3),d3=(mx-x1)*(y3-y1)-(x3-x1)*(my-y1);
    if(!((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0)))return{tri:triangles[i],idx:i};}
  return null;
}

// ═══ MOUSE INPUT (Phase 14: click-and-hold sustain) ═══
// Holding a node/triangle sustains the note. Releasing triggers noteOff.
var _heldNoteIds=[];  // noteIds currently held by mouse/touch
var _heldNoteType=null; // 'node' or 'triad'
var _mouseIsNote=false; // true if mousedown hit a node/triangle (not a drag)

wrap.addEventListener('mousedown',function(e){
  // When 3D timbral space is the primary view, don't fire notes from 2D grid clicks
  if(typeof TimbralSpace!=='undefined'&&TimbralSpace.isActive()){return;}
  var rect=cv.getBoundingClientRect(),mx=(e.clientX-rect.left)*(W/dpr)/rect.width,my=(e.clientY-rect.top)*(H/dpr)/rect.height;
  if(ringDotAt(mx,my)){dialGrabbed=true;dialManualOverride=true;if(dialOverrideTimeout)clearTimeout(dialOverrideTimeout);e.preventDefault();return;}
  if(ringBodyAt(mx,my)){ringDragging=true;ringDragOX=mx-ringX;ringDragOY=my-ringY;e.preventDefault();return;}

  // Check if click landed on a node or triangle — fire note immediately for hold-sustain
  var nd=nodeAt(mx,my);
  if(nd){
    _mouseIsNote=true;
    var nid=window.onNoteInput(nd.note,nd.midi,nd.midi<48?'bass':nd.midi<72?'rhythm':'soloist',undefined,nd.idx,true);
    _heldNoteIds=nid!==null?[nid]:[];
    _heldNoteType='node';
    e.preventDefault();return;
  }
  var th=triangleAt(mx,my);
  if(th){
    _mouseIsNote=true;
    var ids=processTriad(th.tri,true);
    _heldNoteIds=ids||[];
    _heldNoteType='triad';
    e.preventDefault();return;
  }

  // No note hit — start pan drag
  _mouseIsNote=false;
  isDrag=true;dragSX=e.clientX;dragSY=e.clientY;panSX=panX;panSY=panY;dragDist=0;wrap.classList.add('dragging');});
window.addEventListener('mousemove',function(e){
  var rect=cv.getBoundingClientRect(),mx=(e.clientX-rect.left)*(W/dpr)/rect.width,my=(e.clientY-rect.top)*(H/dpr)/rect.height;
  if(dialGrabbed){dialAngle=ringAngleAt(mx,my);applyDialKey(dialAngle);
    if(!droneStarted){
      droneStarted=true;droneActive=true;
      // Set instrument BEFORE starting drone so startDrone reads correct _droneInstrument
      // Use lead mixer strip instrument for drone audio path (instDrone/instDroneTransport removed)
      var drnInstSel=document.getElementById('instLead');
      if(drnInstSel&&drnInstSel.value&&SoundEngine.setDroneInstrument){
        SoundEngine.setDroneInstrument(drnInstSel.value);
      }
      SoundEngine.startDrone(SharedState.keyC);
    }return;}
  if(ringDragging){ringX=mx-ringDragOX;ringY=my-ringDragOY;return;}
  if(isDrag){var dx=e.clientX-dragSX,dy=e.clientY-dragSY;dragDist=Math.hypot(dx,dy);
    if(dragDist>=6){panX=panSX+dx/dpr;panY=panSY+dy/dpr;buildGrid();}return;}
  var nd=nodeAt(mx,my);hovIdx=nd?nd.idx:null;
  if(!nd){var th=triangleAt(mx,my);hovTri=th?th.idx:null;}else hovTri=null;
  cv.style.cursor=ringDotAt(mx,my)?'pointer':ringBodyAt(mx,my)?'grab':(hovIdx!=null||hovTri!=null)?'pointer':'grab';
});
window.addEventListener('mouseup',function(e){
  if(dialGrabbed){dialGrabbed=false;if(dialOverrideTimeout)clearTimeout(dialOverrideTimeout);
    dialOverrideTimeout=setTimeout(function(){dialManualOverride=false;},8000);return;}
  if(ringDragging){ringDragging=false;return;}
  // Release held note(s) on mouseup
  if(_mouseIsNote){
    _mouseIsNote=false;
    for(var hi=0;hi<_heldNoteIds.length;hi++){
      try{SoundEngine.noteOff('human',_heldNoteIds[hi]);}catch(e2){}
    }
    if(_heldNoteIds.length>0&&typeof window._wvNoteOff==='function')window._wvNoteOff('human');
    _heldNoteIds=[];_heldNoteType=null;
    return;
  }
  if(isDrag){isDrag=false;wrap.classList.remove('dragging');}});
wrap.addEventListener('wheel',function(e){e.preventDefault();zoomLevel=Math.max(.4,Math.min(3,zoomLevel+(e.deltaY>0?-.08:.08)));buildGrid();},{passive:false});

// ═══ TOUCH INPUT (Phase 14: touch-and-hold sustain) ═══
var _touchHeldIds=[];
cv.addEventListener('touchstart',function(e){e.preventDefault();
  if(typeof TimbralSpace!=='undefined'&&TimbralSpace.isActive()){return;}
  var t=e.touches[0],rect=cv.getBoundingClientRect();
  var mx=(t.clientX-rect.left)*(W/dpr)/rect.width,my=(t.clientY-rect.top)*(H/dpr)/rect.height;
  // Release any previous touch-held notes
  for(var ti2=0;ti2<_touchHeldIds.length;ti2++){try{SoundEngine.noteOff('human',_touchHeldIds[ti2]);}catch(e2){}}
  _touchHeldIds=[];
  var nd=nodeAt(mx,my);
  if(nd){
    var nid=window.onNoteInput(nd.note,nd.midi,nd.midi<48?'bass':nd.midi<72?'rhythm':'soloist',undefined,nd.idx,true);
    if(nid!==null)_touchHeldIds=[nid];
  } else {
    var th=triangleAt(mx,my);
    if(th){var ids=processTriad(th.tri,true);_touchHeldIds=ids||[];}
  }
},{passive:false});
cv.addEventListener('touchend',function(e){e.preventDefault();
  for(var ti3=0;ti3<_touchHeldIds.length;ti3++){try{SoundEngine.noteOff('human',_touchHeldIds[ti3]);}catch(e2){}}
  if(_touchHeldIds.length>0&&typeof window._wvNoteOff==='function')window._wvNoteOff('human');
  _touchHeldIds=[];
},{passive:false});
cv.addEventListener('touchcancel',function(e){
  for(var ti4=0;ti4<_touchHeldIds.length;ti4++){try{SoundEngine.noteOff('human',_touchHeldIds[ti4]);}catch(e2){}}
  _touchHeldIds=[];
},{passive:false});

// ═══ RESIZE ═══
function resize(){dpr=window.devicePixelRatio||1;W=wrap.clientWidth*dpr;H=wrap.clientHeight*dpr;
  cv.width=W;cv.height=H;cv.style.width=wrap.clientWidth+'px';cv.style.height=wrap.clientHeight+'px';buildGrid();}
window.addEventListener('resize',resize);

// ═══ CONTROLS ═══
// buildMetroDots + toggleMetro removed — metronome UI removed
// toggleDrone removed — LEAD transport button removed (dial always visible)

window.toggleAuto=function(){
  if(autoMode){autoMode=false;document.getElementById('bAuto').className='btn';
    // v5 Phase 6: Save session data before reset
    try{if(typeof LTM!=='undefined')LTM.saveSession(SharedState.genre);}catch(e){}
    for(var v in voices){voices[v].scope.muted=false;updateVoiceIndicator(v,'muted');}
    // Phase 7: HARD KILL all sustained notes and scheduled phrases on stop
    try{if(typeof VoiceManager!=='undefined')VoiceManager.reset();}catch(e){}
    try{if(typeof Scheduler!=='undefined')Scheduler.reset();}catch(e){}
    try{SoundEngine.killVoice('bass');SoundEngine.killVoice('rhythm');SoundEngine.killVoice('soloist');SoundEngine.killVoice('human');SoundEngine.killVoice('percussion');}catch(e){}
    try{if(typeof PercussionAssistant!=='undefined')PercussionAssistant.reset();}catch(e){}
    stopMasterTick();return;}
  autoMode=true;document.getElementById('bAuto').className='btn on';
  try{if(typeof BeliefState!=='undefined')BeliefState.initColdStart();}catch(e){}
  // v5 Phase 6: Warm-start from LTM if available (overrides cold-start with session priors)
  try{if(typeof LTM!=='undefined')LTM.loadWarmStart(SharedState.genre);}catch(e){}
  // Refresh tempo initiation — restarts 15s mass boost window from NOW, not page load
  // v9.2.0: Read from bpmSlider (primary UI) instead of hidden bpmInput
  try{var bpm=+(document.getElementById('bpmSlider').value)||120;TempoEngine.setManualBPM(bpm);}catch(e){}
  try{if(typeof PercussionAssistant!=='undefined')PercussionAssistant.setEnabled(true);}catch(e){}
  for(var v in voices){voices[v].scope.muted=false;voices[v].scope.frozen=false;updateVoiceIndicator(v,'active');}
  // Gen3: load lexicons
  try{if(typeof BassAssistant!=='undefined'){
    BassAssistant.loadLexicon(SharedState.genre);RhythmAssistant.loadLexicon(SharedState.genre);SoloAssistant.loadLexicon(SharedState.genre);
    if(typeof LeadAssistant!=='undefined')LeadAssistant.loadLexicon(SharedState.genre);
  }}catch(e){}
  // Seed MelodicExpectancy STM from lexicon (lowers IC from first note)
  // Delayed 2s to ensure async lexicon fetch completes.
  setTimeout(function() {
    if (typeof MelodicExpectancy === 'undefined' || !MelodicExpectancy.seedSTM) return;
    var _seedMap = {
      bass: (typeof BassAssistant !== 'undefined') ? BassAssistant : null,
      rhythm: (typeof RhythmAssistant !== 'undefined') ? RhythmAssistant : null,
      soloist: (typeof SoloAssistant !== 'undefined') ? SoloAssistant : null,
      lead: (typeof LeadAssistant !== 'undefined') ? LeadAssistant : null
    };
    var _seedCount = 0;
    for (var _sv in _seedMap) {
      var _sa = _seedMap[_sv];
      if (_sa && _sa._getLexicon) {
        var _lex = _sa._getLexicon();
        if (_lex && _lex.length > 0) {
          MelodicExpectancy.seedSTM(_sv, _lex, SharedState.keyC);
          _seedCount += _lex.length;
        }
      }
    }
    if (_seedCount > 0) console.log('MelodicExpectancy STM seeded from ' + _seedCount + ' lexicon phrases');
  }, 2000);
  // If no note played yet, start from key center
  if(trail.length===0){
    var nd=findNode(SharedState.keyC,'human');
    if(nd){addToTrail(nd.idx,SharedState.keyC,'human');lastNodeIdx=nd.idx;
      for(var v in voices)voices[v].observeNote(SharedState.keyC);
      pcProbs=SharedState.predict(SharedState.keyC,voices.rhythm.stm,SharedState.genre);}
  }
  startMasterTick();lastHumanNoteTime=Date.now();
  // Diagnostic: auto-dump pipeline state 3s after auto mode starts
  setTimeout(function(){
    if(!autoMode)return;
    console.log('%c[AUTO-MODE 3s CHECK] Notes produced so far:','color:#ff0',
      window._diagNoteCount||{bass:0,rhythm:0,soloist:0,total:0},
      'Errors:',{bass:window._bassErrCount||0,rhythm:window._rhythmErrCount||0,soloist:window._soloErrCount||0});
    if(typeof BassAssistant!=='undefined'&&typeof BassAssistant.getDiag==='function')
      console.log('%c[AUTO-MODE 3s CHECK] Bass gates:','color:#ff0',BassAssistant.getDiag());
    if((!window._diagNoteCount||window._diagNoteCount.total===0)&&(window._bassErrCount||window._rhythmErrCount||window._soloErrCount))
      console.error('[AUTO-MODE 3s CHECK] ZERO notes produced but errors detected! Check error messages above. Run _diagAI() for full state.');
    else if(!window._diagNoteCount||window._diagNoteCount.total===0)
      console.warn('[AUTO-MODE 3s CHECK] ZERO notes produced and no errors. Run _diagAI() for full state.');
  },3000);
};

// Seeds removed (Phase 13) — lexicon tier cascade makes them unnecessary

// ═══ AUTO-EVALUATOR WIRING ═══
(function(){
  if(typeof AutoEvaluator==='undefined')return;
  AutoEvaluator.init({
    onStatusChange:function(text,running){
      var btn=document.getElementById('bAutoEval');
      var statusEl=document.getElementById('evalStatus');
      var grp=document.getElementById('evalGroup');
      if(btn)btn.className=running?'btn on':'btn';
      if(statusEl)statusEl.textContent=text;
      if(grp)grp.style.display=running?'':'none';
      // Update boot button too
      var bootBtn=document.getElementById('bootAutoEval');
      if(bootBtn){
        bootBtn.textContent=running?'STOP EVAL':'AUTO-EVAL';
        if(running)bootBtn.classList.add('boot-util-ok');
        else bootBtn.classList.remove('boot-util-ok');
      }
    }
  });
  AutoEvaluator.setStatusElement(document.getElementById('evalStatus'));
  // Populate pattern select
  var sel=document.getElementById('evalPatternSelect');
  if(sel){
    sel.innerHTML='<option value="__suite__">Full Suite</option>'+
      AutoEvaluator.getPatterns().map(function(p){return'<option value="'+p+'">'+p+'</option>';}).join('');
  }
})();
window.toggleAutoEval=function(){
  if(typeof AutoEvaluator==='undefined')return;
  if(AutoEvaluator.isRunning()){
    AutoEvaluator.stop();
    return;
  }
  // Ensure Auto mode is on so assistants respond
  if(!autoMode){window.toggleAuto();}
  var sel=document.getElementById('evalPatternSelect');
  var val=sel?sel.value:'__suite__';
  if(val==='__suite__'){
    AutoEvaluator.startSuite();
  }else{
    AutoEvaluator.startPattern(val);
  }
  var grp=document.getElementById('evalGroup');
  if(grp)grp.style.display='';
};

// v9.2.0: bpmInput change listener removed — bpmSlider handles tempo changes via ui-wiring.js
// tsSelect buildMetroDots call removed — metronome UI removed
document.getElementById('keySelect').addEventListener('change',function(){
  if(this.value!=='auto'){SharedState.keyC=+this.value;
    document.getElementById('sKey').textContent='Key: '+N[SharedState.keyC];
    if(droneActive)SoundEngine.setDroneKey(SharedState.keyC);nodeRadii=[];}});
document.getElementById('modeSelect').addEventListener('change',function(){SharedState.mode=this.value;nodeRadii=[];});
document.getElementById('genreSelect').addEventListener('change',function(){
  SharedState.genre=this.value;
  document.getElementById('modeSelect').value=GENRE_DEFAULTS[this.value]||'major';
  SharedState.mode=GENRE_DEFAULTS[this.value]||'major';
  SharedState.loadLTM(this.value);nodeRadii=[];
  // v9 Feature D: Notify MelodicExpectancy to hot-swap genre-specific LTM
  if(typeof EventBus!=='undefined')EventBus.emit('genreChanged',this.value);
  // Phase 14: always preload lexicons on genre change (not just when auto is on).
  // This way they're ready instantly when the user hits Play Auto.
  try{if(typeof BassAssistant!=='undefined'){
    BassAssistant.loadLexicon(this.value);RhythmAssistant.loadLexicon(this.value);SoloAssistant.loadLexicon(this.value);
  }}catch(e){}
});

// ═══ LEXICON FILE LOADER (Phase 14) ═══
// Allows uploading custom lexicon .json files from disk without editing index.html.
// Uploaded lexicons are registered as a new genre option in the genre selector.
window._loadLexiconFile=function(file){
  if(!file)return;
  var reader=new FileReader();
  reader.onload=function(ev){
    try{
      var data=JSON.parse(ev.target.result);
      if(!data.bass_lexicon&&!data.rhythm_lexicon&&!data.solo_lexicon&&!(data.patterns&&Array.isArray(data.patterns))){
        console.error('Lexicon file missing bass_lexicon/rhythm_lexicon/solo_lexicon or patterns array');return;
      }
      var genreName=file.name.replace(/\.json$/i,'').replace(/[^a-zA-Z0-9_]/g,'_');
      // Store in SharedState for retrieval by assistants
      if(!window._customLexicons)window._customLexicons={};
      window._customLexicons[genreName]=data;
      // Monkey-patch the assistants' loadLexicon to check custom store first
      // by storing on a global that the fetch path can use
      // Actually: override the fetch by injecting a blob URL
      var blob=new Blob([ev.target.result],{type:'application/json'});
      var blobUrl=URL.createObjectURL(blob);
      // Register custom lexicon path
      if(!window._lexiconPaths)window._lexiconPaths={};
      window._lexiconPaths[genreName]=blobUrl;
      // Add to genre selector if not already there
      var gSel=document.getElementById('genreSelect');
      if(gSel){
        var exists=false;
        for(var oi=0;oi<gSel.options.length;oi++){if(gSel.options[oi].value===genreName)exists=true;}
        if(!exists){
          var opt=document.createElement('option');
          opt.value=genreName;opt.textContent=genreName.replace(/_/g,' ');
          gSel.appendChild(opt);
        }
        gSel.value=genreName;
        gSel.dispatchEvent(new Event('change'));
      }
      // Also register genre default mode
      if(typeof GENRE_DEFAULTS!=='undefined')GENRE_DEFAULTS[genreName]=data.default_mode||'minor';
      console.log('Custom lexicon loaded: '+genreName);
    }catch(err){console.error('Lexicon parse error: '+err.message);}
  };
  reader.readAsText(file);
};
// ═══ LTM FILE LOADER ═══
var _ltmInput=document.getElementById('ltmFileInput');
if(_ltmInput) _ltmInput.addEventListener('change',function(e){
  var files=Array.from(e.target.files);if(!files.length)return;
  var loaded=0,total=files.length,btn=document.getElementById('bLoadLTM');
  btn.textContent='LTM 0/'+total;
  files.forEach(function(file){
    var reader=new FileReader();
    reader.onload=function(ev){
      try{var data=JSON.parse(ev.target.result);SharedState.loadLTMFromJSON(file.name.replace(/\.json$/i,''),data);}
      catch(err){console.error('Parse error: '+file.name);}
      loaded++;btn.textContent=loaded<total?'LTM '+loaded+'/'+total:'LTM \u2713'+loaded;
      if(loaded===total){SharedState.loadLTM(SharedState.genre);pcProbs=SharedState.predict(0,voices.rhythm.stm,SharedState.genre);}
    };reader.readAsText(file);
  });e.target.value='';
});
document.getElementById('instSelect').addEventListener('change',function(){
  // Legacy instSelect routes to human voice to maintain backward compat
  SoundEngine.setVoiceInstrument('human', this.value || null);
});
// Drone vol and instrument: now controlled by lead mixer strip (#leadVol, #instLead).
// SoundEngine.setDroneInstrument is implemented natively in sound-engine.js.

// EventBus listeners
EventBus.on('keyChanged',function(data){
  SharedState.keyC=data.key;SharedState.mode=data.mode;
  document.getElementById('sKey').textContent='Key: '+N[data.key]+(data.mode==='minor'?'m':'');
  document.getElementById('keySelect').value=String(data.key);
  document.getElementById('modeSelect').value=data.mode;
  if(droneActive)SoundEngine.setDroneKey(data.key);
  if(!dialManualOverride)dialTargetAngle=pcToDialAngle(data.key);
  nodeRadii=[];
  for(var v in voices)voices[v].playstring=null;
  try{if(typeof BassAssistant!=='undefined'){BassAssistant.replan();RhythmAssistant.replan();SoloAssistant.replan();}}catch(e){}
});
EventBus.on('chordChanged',function(data){
  // Replan voices on chord change
  for(var v in voices)if(voices[v].shouldReplan({type:'chordChanged'}))voices[v].playstring=null;
});
EventBus.on('phraseBoundary',function(data){
  for(var v in voices)voices[v].playstring=null;
  // Phase 5B: staggered replan — only replan voices that are between phrases
  // or nearly done (progress >= 0.8). Voices mid-phrase hold their current
  // phrase and replan naturally when it completes. This prevents all three
  // voices from starting new phrases simultaneously.
  try{if(typeof BassAssistant!=='undefined'&&data.strength>0.5){
    if(typeof ContextIntegrator!=='undefined'){
      if(ContextIntegrator.getPhraseProgress('bass')>=0.8)BassAssistant.replan();
      if(ContextIntegrator.getPhraseProgress('rhythm')>=0.8)RhythmAssistant.replan();
      if(ContextIntegrator.getPhraseProgress('soloist')>=0.8)SoloAssistant.replan();
    } else {
      BassAssistant.replan();RhythmAssistant.replan();SoloAssistant.replan();
    }
  }}catch(e){}
});

// ═══ RESET ═══
window.resetAll=function(){
  if(typeof AutoEvaluator!=='undefined'&&AutoEvaluator.isRunning())AutoEvaluator.stop();
  autoMode=false;
  stopMasterTick();
  document.getElementById('bAuto').className='btn';
  if(droneActive){SoundEngine.stopDrone();droneActive=false;}
  droneStarted=false;dialManualOverride=false;
  dialAngle=pcToDialAngle(0);dialTargetAngle=dialAngle;
  SharedState.reset();TempoEngine.reset();
  try{
    if(typeof BassAssistant!=='undefined'){BassAssistant.reset();RhythmAssistant.reset();SoloAssistant.reset();}
    if(typeof FinalCoordinator!=='undefined')FinalCoordinator.reset();
    if(typeof ContextIntegrator!=='undefined')ContextIntegrator.reset();
    if(typeof Scheduler!=='undefined')Scheduler.reset();
    if(typeof VoiceManager!=='undefined')VoiceManager.reset();
    if(typeof HarmonicPlanner!=='undefined')HarmonicPlanner.reset();
    if(typeof SectionTracker!=='undefined')SectionTracker.reset();
    if(typeof MotifDeveloper!=='undefined')MotifDeveloper.reset();
    if(typeof SharedPhraseMemory!=='undefined')SharedPhraseMemory.reset();
    if(typeof DialogueEngine!=='undefined')DialogueEngine.reset();
    if(typeof PercussionAssistant!=='undefined')PercussionAssistant.reset();
    if(typeof LeadAssistant!=='undefined')LeadAssistant.reset();
    if(typeof KeyBelief!=='undefined')KeyBelief.reset();
    if(typeof MelodicIntent!=='undefined')MelodicIntent.reset();
    if(typeof NarrativeArc!=='undefined')NarrativeArc.reset();
    if(typeof SessionEnding!=='undefined')SessionEnding.reset();
    if(typeof ThematicMemory!=='undefined')ThematicMemory.reset();
    if(typeof TimbralEvolution!=='undefined')TimbralEvolution.reset();
    if(typeof MoodState!=='undefined')MoodState.reset();
    // v9.2.0: New modules added this session
    if(typeof ChordBelief!=='undefined')ChordBelief.reset();
    if(typeof ConvictionExpression!=='undefined')ConvictionExpression.reset();
    if(typeof GestureClassifier!=='undefined')GestureClassifier.reset();
  }catch(e){}
  try{SoundEngine.killAll();}catch(e){}
  for(var v in voices){voices[v].reset();updateVoiceIndicator(v,'muted');}
  trail=[];total=0;pcCounts=Array(12).fill(0);pcProbs=new Float64Array(12);
  _beatPulses=[];_beatPhase=0;_lastFrameTime=0;_noiseOff=0;_humanLastTrailIdx=null;
  lastNodeIdx=null;nodeRadii=[];nodeTargetRadii=[];silenceBeats=0;lastHumanNoteTime=0;
  window._bassErr=false;window._rhythmErr=false;window._soloErr=false;
  for(var i=0;i<nodes.length;i++)nodes[i].playCount=0;
  for(var i=0;i<edges.length;i++)edges[i].ct=0;
  updateUI();
};


// ═══ INIT ═══
dialAngle=pcToDialAngle(0);dialTargetAngle=dialAngle;
resize();updateUI();draw();

// ═══ Fetch interceptor for lexicon loading ═══
// Must be installed BEFORE auto-load so Electron IPC bridge is active.
// When a custom lexicon is uploaded via _loadLexiconFile, it gets stored as a
// blob URL in window._lexiconPaths. The existing assistant loadLexicon()
// functions call fetch('data/Lexicon/{genre}.json'). This interceptor detects
// those requests and redirects to the blob URL or Electron IPC if available.
(function(){
  var _origFetch=window.fetch;
  window.fetch=function(url){
    if(typeof url==='string'&&url.indexOf('data/Lexicon/')===0){
      var genre=url.replace('data/Lexicon/','').replace('.json','');
      // Electron IPC bridge: use native file I/O for lexicon loading
      if(window.gen3&&window.gen3.lexicon){
        return window.gen3.lexicon.load(genre).then(function(data){
          if(data===null||data===undefined){
            return new Response('Lexicon not found: '+genre,{status:404,statusText:'Not Found'});
          }
          return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
        });
      }
      // Browser blob URL redirect (custom uploaded lexicons)
      if(window._lexiconPaths&&window._lexiconPaths[genre]){
        return _origFetch(window._lexiconPaths[genre]);
      }
    }
    return _origFetch.apply(this,arguments);
  };
})();

// Auto-load lexicon for the initial genre on startup
try{if(typeof BassAssistant!=='undefined'){
  console.log('Auto-loading lexicon for genre: '+SharedState.genre);
  BassAssistant.loadLexicon(SharedState.genre);RhythmAssistant.loadLexicon(SharedState.genre);SoloAssistant.loadLexicon(SharedState.genre);
  if(typeof LeadAssistant!=='undefined')LeadAssistant.loadLexicon(SharedState.genre);
}}catch(e){console.error('Lexicon auto-load error:',e);}

console.log('Veles — Predictive Assistant Instrument loaded');

// ═══ Electron menu event wiring ═══
// Receives menu:load-lexicon and menu:load-sound from native File menu
if(window.gen3&&window.gen3.on){
  window.gen3.on('menu:load-lexicon',function(filePath){
    console.log('Menu: loading lexicon from '+filePath);
    window.gen3.fs.readExternal(filePath).then(function(text){
      if(!text){console.error('Could not read lexicon file: '+filePath);return;}
      try{
        var data=JSON.parse(text);
        if(!data.bass_lexicon&&!data.rhythm_lexicon&&!data.solo_lexicon&&!(data.patterns&&Array.isArray(data.patterns))){
          console.error('Lexicon file missing bass/rhythm/solo_lexicon or patterns array');return;
        }
        var genreName=filePath.split('/').pop().split('\\').pop().replace(/\.json$/i,'').replace(/[^a-zA-Z0-9_]/g,'_');
        if(!window._lexiconPaths)window._lexiconPaths={};
        var blob=new Blob([text],{type:'application/json'});
        window._lexiconPaths[genreName]=URL.createObjectURL(blob);
        var gSel=document.getElementById('genreSelect');
        if(gSel){
          var exists=false;
          for(var oi=0;oi<gSel.options.length;oi++){if(gSel.options[oi].value===genreName)exists=true;}
          if(!exists){
            var opt=document.createElement('option');
            opt.value=genreName;opt.textContent=genreName.replace(/_/g,' ');
            gSel.appendChild(opt);
          }
          gSel.value=genreName;
          gSel.dispatchEvent(new Event('change'));
        }
        if(typeof GENRE_DEFAULTS!=='undefined')GENRE_DEFAULTS[genreName]=data.default_mode||'minor';
        console.log('Menu: custom lexicon loaded — '+genreName);
      }catch(err){console.error('Menu: lexicon parse error — '+err.message);}
    });
  });
  window.gen3.on('menu:load-sound',function(filePaths){
    // Accept array of paths (multi-file) or single path (legacy)
    var paths=Array.isArray(filePaths)?filePaths:[filePaths];
    console.log('Menu: loading '+paths.length+' sound file(s)');
    if(!window.gen3.sound||!window.gen3.sound.loadFile)return;

    function _menuLoadOne(fp,cb){
      window.gen3.sound.loadFile(fp).then(function(result){
        if(!result||!result.buffer){cb(false);return;}
        var binary;try{binary=atob(result.buffer);}catch(e){cb(false);return;}
        var bytes=new Uint8Array(binary.length);
        for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
        var blob=new Blob([bytes]);
        var file=new File([blob],result.name);
        var instName='user_'+(result.name.replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9_]/g,'_')||'custom_sound');
        if(typeof SampleLoader!=='undefined'){
          SampleLoader.loadFromFile(instName,file,function(ok){
            console.log('Menu: sound '+(ok?'loaded':'failed')+' — '+result.name);
            cb(ok);
          });
        }else{cb(false);}
      }).catch(function(){cb(false);});
    }

    var done=0,ok=0;
    for(var mi=0;mi<paths.length;mi++){
      (function(fp){
        _menuLoadOne(fp,function(success){
          done++;if(success)ok++;
          if(done>=paths.length){
            if(ok>0&&typeof populateInstSelects==='function')populateInstSelects();
            // Persist all files
            if(ok>0&&window.gen3.userSamples&&window.gen3.userSamples.copyFiles){
              window.gen3.userSamples.copyFiles(paths);
            }
            console.log('Menu: '+ok+'/'+paths.length+' sounds loaded');
          }
        });
      })(paths[mi]);
    }
  });
}
})();

// ═══ Phase 14: Settings button — return to boot screen ═══
window.showSettings=function(){
  var ov=document.getElementById('startOverlay');
  if(!ov)return;
  ov.style.display='';
  ov.classList.remove('hidden');
  // Re-mark as ready so user can click to return
  var hint=document.getElementById('bootHint');
  if(hint){hint.innerHTML='PRESS ENTER OR CLICK TO RETURN';hint.style.color='#ffb000';}
  var ready=document.getElementById('bootReady');
  if(ready){
    ready.innerHTML='<span style="color:#33ff33;">SYSTEM READY</span> <span style="animation:bios-blink 1s step-end infinite;color:#33ff33;">_</span>';
    ready.style.cursor='pointer';
    ready.onclick=function(e){e.stopPropagation();unlockAudio();};
  }
  // Add INSTRUMENTS button to open instrument subpage
  var utilsRow=document.querySelector('.boot-utils-row');
  if(utilsRow&&!document.getElementById('btnInstruments')){
    var instBtn=document.createElement('button');
    instBtn.id='btnInstruments';
    instBtn.className='bios-btn';
    instBtn.textContent='INSTRUMENTS';
    instBtn.onclick=function(e){
      e.stopPropagation();
      if(typeof window.openInstSubpage==='function')window.openInstSubpage();
    };
    utilsRow.appendChild(instBtn);
  }
  // Add MIXER button — opens full-page mixer subpage (same pattern as INSTRUMENTS)
  if(utilsRow&&!document.getElementById('btnMixer')){
    var mixBtn=document.createElement('button');
    mixBtn.id='btnMixer';
    mixBtn.className='bios-btn';
    mixBtn.textContent='MIXER';
    mixBtn.onclick=function(e){
      e.stopPropagation();
      if(typeof window.openMixerSubpage==='function')window.openMixerSubpage();
    };
    utilsRow.appendChild(mixBtn);
  }
  // Add EXIT button (desktop app = close, web = exit fullscreen)
  if(utilsRow&&!document.getElementById('btnExitApp')){
    var exitBtn=document.createElement('button');
    exitBtn.id='btnExitApp';
    exitBtn.className='bios-btn';
    exitBtn.textContent='EXIT';
    exitBtn.onclick=function(e){
      e.stopPropagation();
      if(typeof window.showExitConfirm==='function')window.showExitConfirm();
    };
    utilsRow.appendChild(exitBtn);
  }
};
