'use strict';
// ═══ UI WIRING (Phase 7 — wiring only, no DOM surgery) ═══
// All HTML is baked into index.html. This file only adds event listeners
// and initialises Web Audio waveforms.

(function() {

// ─────────────────────────────────────
// 1. FADER + MUTE HELPERS (called inline from index.html)
// ─────────────────────────────────────
window.onFaderMove = function(el, valId) {
  document.getElementById(valId).textContent = el.value;
  el.style.setProperty('--p', el.value + '%');
};

window.toggleChMute = function(stripId, ledId, volId) {
  var strip = document.getElementById(stripId);
  var led   = document.getElementById(ledId);
  if (!strip || !led) return;
  var muted = strip.classList.toggle('ch-muted');
  var col   = led.dataset.origCol || led.style.color;
  if (!led.dataset.origCol) led.dataset.origCol = led.style.color;
  led.style.background = muted ? '#1a1a1a' : col;
  led.style.color      = muted ? '#1a1a1a' : col;
  led.classList.toggle('on', !muted);
  var fader = document.getElementById(volId);
  if (fader && typeof SoundEngine !== 'undefined') {
    var voiceMap = { humanVol:'human', bassVol:'bass', rhythmVol:'rhythm', soloistVol:'soloist', leadVol:'lead', percVol:'percussion' };
    var vn = voiceMap[volId];
    if (vn) SoundEngine.setVoiceGain(vn, muted ? 0 : +fader.value / 100);
  }
};

// ─────────────────────────────────────
// 2. BPM SLIDER
// ─────────────────────────────────────
(function() {
  var slider = document.getElementById('bpmSlider');
  var valEl  = document.getElementById('bpmSliderVal');
  if (!slider) return;

  function update(v) {
    v = Math.max(30, Math.min(300, v));
    slider.value = v;
    if (valEl) valEl.textContent = v;
    var pct = ((v - 30) / (300 - 30) * 100).toFixed(1) + '%';
    slider.style.setProperty('--bpmp', pct);
    var td = document.getElementById('tempoDisp');
    if (td) td.textContent = v;
    if (typeof TempoEngine !== 'undefined') TempoEngine.setManualBPM(v);
  }

  slider.addEventListener('input', function() { update(+this.value); });

  // Init
  update(+slider.value);
})();

// ─────────────────────────────────────
// 2b. BPM SLIDER ↔ TEMPO ENGINE SYNC (Phase 15b)
// ─────────────────────────────────────
// When the dynamic tempo system is active (confidence > 0), the BPM slider
// physically moves to reflect the inferred BPM. This gives visual feedback
// that the system is tracking the player's tempo.
(function() {
  var _lastSyncBPM = 0;
  var _userDragging = false;
  var slider = document.getElementById('bpmSlider');
  var valEl  = document.getElementById('bpmSliderVal');
  if (!slider) return;

  // Detect when user is actively dragging — don't fight their input
  slider.addEventListener('mousedown', function() { _userDragging = true; });
  slider.addEventListener('touchstart', function() { _userDragging = true; });
  window.addEventListener('mouseup', function() { _userDragging = false; });
  window.addEventListener('touchend', function() { _userDragging = false; });

  setInterval(function() {
    if (_userDragging) return;
    if (typeof TempoEngine === 'undefined') return;
    var conf = TempoEngine.getConfidence ? TempoEngine.getConfidence() : 0;
    if (conf < 0.15) return; // only sync when tempo tracking is active
    var eff = Math.round(TempoEngine.getEffectiveBPM());
    if (eff === _lastSyncBPM) return;
    _lastSyncBPM = eff;
    eff = Math.max(30, Math.min(300, eff));
    slider.value = eff;
    var pct = ((eff - 30) / (300 - 30) * 100).toFixed(1) + '%';
    slider.style.setProperty('--bpmp', pct);
    if (valEl) valEl.textContent = eff;
    // v9.2.0: bpmInput sync removed (hidden element deleted)
  }, 200);
})();

// ─────────────────────────────────────
// 3. AUDIO ENGINE WIRING
// ─────────────────────────────────────
(function() {
  // Master volume
  var masterEl = document.getElementById('masterVol');
  if (masterEl) {
    masterEl.addEventListener('input', function() {
      var v = +this.value;
      document.getElementById('masterVolVal').textContent = v;
      if (typeof SoundEngine !== 'undefined') SoundEngine.setMasterVolume(v / 100);
    });
    if (typeof SoundEngine !== 'undefined') SoundEngine.setMasterVolume(+masterEl.value / 100);
  }

  // Reverb
  var rvEl = document.getElementById('reverbSlider');
  if (rvEl) rvEl.addEventListener('input', function() {
    if (typeof SoundEngine !== 'undefined') SoundEngine.setReverb(+this.value / 100);
  });

  // Sustain
  var susEl = document.getElementById('sustainSlider');
  if (susEl) susEl.addEventListener('input', function() {
    if (typeof SoundEngine !== 'undefined') SoundEngine.setSustain(+this.value / 100);
  });

  // Per-voice faders → SoundEngine.setVoiceGain
  var volMap = { humanVol:'human', bassVol:'bass', rhythmVol:'rhythm', soloistVol:'soloist', leadVol:'lead', percVol:'percussion' };
  for (var vid in volMap) {
    (function(id, vn) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', function() {
        if (typeof SoundEngine !== 'undefined') SoundEngine.setVoiceGain(vn, +this.value / 100);
      });
      if (typeof SoundEngine !== 'undefined') SoundEngine.setVoiceGain(vn, +el.value / 100);
    })(vid, volMap[vid]);
  }
})();

// ─────────────────────────────────────
// 4. INSTRUMENT SELECTS
// ─────────────────────────────────────
// Expose globally so app.js and sample-loader.js can trigger dropdown refresh
window.populateInstSelects = populateInstSelects;
function populateInstSelects() {
  var names = (typeof SoundEngine !== 'undefined') ? SoundEngine.getInstrumentNames() : [];

  // Separate user instruments from built-in ones
  var builtIn = [], userInst = [];
  for (var ni = 0; ni < names.length; ni++) {
    if (names[ni].indexOf('user_') === 0 || names[ni].indexOf('custom_') === 0) {
      userInst.push(names[ni]);
    } else {
      builtIn.push(names[ni]);
    }
  }

  // Helper: populate a <select> with optgroups for built-in and user instruments
  function _populateSel(sel) {
    var cur = sel.value;
    // Remove all but the first option (default/osc)
    while (sel.options.length > 1) sel.remove(1);
    // Remove any existing optgroups
    var existingGroups = sel.querySelectorAll('optgroup');
    for (var gi = 0; gi < existingGroups.length; gi++) existingGroups[gi].remove();

    // Built-in instruments
    for (var i = 0; i < builtIn.length; i++) {
      var opt = document.createElement('option');
      opt.value = builtIn[i];
      opt.textContent = builtIn[i].replace(/_/g, ' ');
      sel.appendChild(opt);
    }

    // User instruments in a labeled optgroup
    if (userInst.length > 0) {
      var grp = document.createElement('optgroup');
      grp.label = '\u2500\u2500 User Samples \u2500\u2500';
      for (var ui = 0; ui < userInst.length; ui++) {
        var uopt = document.createElement('option');
        uopt.value = userInst[ui];
        // Strip "user_" prefix for display, replace underscores
        uopt.textContent = '\u266b ' + userInst[ui].replace(/^(user_|custom_)/, '').replace(/_/g, ' ');
        grp.appendChild(uopt);
      }
      sel.appendChild(grp);
    }

    if (cur) sel.value = cur;
    // Blue glow when an instrument is actively selected
    if (sel.value && sel.value !== '') {
      sel.classList.add('inst-active');
    } else {
      sel.classList.remove('inst-active');
    }
  }

  // Standard voice selects: human / bass / rhythm / soloist / lead
  var map = { instHuman:'human', instBass:'bass', instRhythm:'rhythm', instSoloist:'soloist', instLead:'lead' };
  for (var sid in map) {
    (function(id, vn) {
      var sel = document.getElementById(id);
      if (!sel) return;
      _populateSel(sel);
      if (!sel._wired) {
        sel._wired = true;
        sel.addEventListener('change', function() {
          if (typeof SoundEngine !== 'undefined') {
            SoundEngine.setVoiceInstrument(vn, this.value || null);
          }
          // Toggle blue glow
          if (this.value && this.value !== '') {
            this.classList.add('inst-active');
          } else {
            this.classList.remove('inst-active');
          }
        });
      }
    })(sid, map[sid]);
  }

  // instLead is already populated in the standard voice selects map above.
  // (Legacy instDrone and instDroneTransport removed — lead mixer strip is the single control.)
}
populateInstSelects();

// ─────────────────────────────────────
// 4a. PERCUSSION TIMBRE SELECT
// The percussion channel uses synthesized drums (not sampled instruments),
// so it gets its own fixed-option select instead of the dynamic instrument list.
// ─────────────────────────────────────
(function() {
  var sel = document.getElementById('instPerc');
  if (!sel) return;
  // Set initial value from PercussionAssistant if available
  if (typeof PercussionAssistant !== 'undefined' && PercussionAssistant.getTimbre) {
    sel.value = PercussionAssistant.getTimbre();
  }
  sel.addEventListener('change', function() {
    if (typeof PercussionAssistant !== 'undefined' && PercussionAssistant.setTimbre) {
      PercussionAssistant.setTimbre(this.value);
    }
    // Blue glow when non-default
    if (this.value && this.value !== '808') {
      this.classList.add('inst-active');
    } else {
      this.classList.remove('inst-active');
    }
  });
})();

// (Section 4b removed — legacy instDrone inject no longer needed.
//  Lead instrument is controlled by #instLead in the mixer strip.)

// ─────────────────────────────────────
// 5. SAMPLE LOADING
// ─────────────────────────────────────
window.loadDefaultSamples = function() {
  var btn = document.getElementById('bLoadSamples');
  var bootBtn = document.getElementById('bootSamples');
  if (btn) { btn.classList.add('loading'); btn.textContent = 'Loading\u2026'; }
  if (typeof SampleLoader === 'undefined') {
    if (btn) { btn.classList.remove('loading'); btn.textContent = 'N/A'; }
    return;
  }
  SampleLoader.loadDefaults(function(ok) {
    var label = ok ? 'Samples \u2713' : 'Retry';
    if (btn) {
      btn.classList.remove('loading');
      btn.textContent = label;
      if (ok) btn.classList.add('ok');
    }
    if (bootBtn) {
      bootBtn.textContent = ok ? 'SAMPLES \u2713' : 'RETRY';
      if (ok) bootBtn.classList.add('boot-util-ok');
      bootBtn.disabled = false;
    }
    populateInstSelects();
    console.log('Samples:', SampleLoader.getLoadedNames());

    // After defaults, scan for user samples in data/samples/user/
    if (typeof SampleLoader.loadUserSamples === 'function') {
      SampleLoader.loadUserSamples(function(userNames) {
        if (userNames && userNames.length > 0) {
          populateInstSelects();
          console.log('User samples:', userNames);
        }
      });
    }
  }, function(loaded, total, name) {
    if (btn) btn.textContent = 'SOUNDS ' + loaded + '/' + total;
    if (bootBtn) bootBtn.textContent = 'SOUNDS ' + loaded + '/' + total;
  });
};

window.pickSoundFile = function() {
  if (typeof SampleLoader === 'undefined') return;
  var btn = document.getElementById('bPickSound') || document.getElementById('bootSoundFile');

  // Electron: use native dialog for reliable file picking (multi-file + folder)
  if (window.gen3 && window.gen3.fs && window.gen3.fs.showOpenDialog) {
    window.gen3.fs.showOpenDialog({
      title: 'Load Sound Files',
      filters: [{ name: 'Audio', extensions: ['js','wav','mp3','ogg','flac','webm','m4a','aac'] }],
      properties: ['openFile', 'multiSelections', 'openDirectory']
    }).then(function(result) {
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
      if (btn) { btn.textContent = 'Loading\u2026'; btn.disabled = true; }

      var paths = result.filePaths;

      // Helper: load a single file path as an instrument
      function _loadSinglePath(filePath, cb) {
        var fileName = filePath.split('/').pop().split('\\').pop();
        var instName = 'user_' + (fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_') || 'custom_sound');
        window.gen3.sound.loadFile(filePath).then(function(data) {
          if (!data || !data.buffer) { cb(false, instName); return; }
          var binary;
          try { binary = atob(data.buffer); } catch (e) { cb(false, instName); return; }
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          var blob = new Blob([bytes]);
          var fName = (data.name && data.name.length > 0) ? data.name : 'unknown_' + Date.now();
          var file = new File([blob], fName);
          SampleLoader.loadFromFile(instName, file, function(ok) { cb(ok, instName); });
        }).catch(function() { cb(false, instName); });
      }

      // Helper: load multiple file paths as one multi-sample instrument
      function _loadMultiSample(audioPaths, instName, cb) {
        var entries = [];
        var done = 0, total = audioPaths.length;
        for (var mi = 0; mi < audioPaths.length; mi++) {
          (function(fp) {
            var noteName = fp.split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '');
            var midi = SampleLoader.noteNameToMidi ? SampleLoader.noteNameToMidi(noteName) : -1;
            window.gen3.sound.loadFile(fp).then(function(data) {
              if (data && data.buffer && midi >= 0) {
                var binary;
                try { binary = atob(data.buffer); } catch (e) { done++; _checkDone(); return; }
                var bytes = new Uint8Array(binary.length);
                for (var j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                var blob = new Blob([bytes]);
                var file = new File([blob], data.name || noteName);
                entries.push({ file: file, midi: midi });
              }
              done++;
              _checkDone();
            }).catch(function() { done++; _checkDone(); });
          })(audioPaths[mi]);
        }
        function _checkDone() {
          if (done < total) return;
          if (entries.length > 0) {
            SampleLoader.loadFromFiles(instName, entries, function(ok) { cb(ok, instName); });
          } else {
            cb(false, instName);
          }
        }
      }

      // Helper: persist files to userData
      function _persist(srcPaths, folderName) {
        if (!window.gen3.userSamples) return;
        var fn = folderName ? window.gen3.userSamples.copyFiles : window.gen3.userSamples.copyFiles;
        if (window.gen3.userSamples.copyFiles) {
          window.gen3.userSamples.copyFiles(srcPaths, folderName || null).then(function(d) {
            if (d) console.log('User samples persisted:', d.length || 1, 'files');
          }).catch(function(err) { console.warn('pickSoundFile: persist error:', err); });
        }
      }

      // Check if first path is a directory (folder selection)
      if (paths.length === 1 && window.gen3.fs.listDir) {
        window.gen3.fs.listDir(paths[0]).then(function(audioFiles) {
          if (audioFiles && audioFiles.length > 0) {
            // It's a folder — load as multi-sample instrument
            var folderName = paths[0].split('/').pop().split('\\').pop().replace(/[^a-zA-Z0-9_]/g, '_');
            var instName = 'user_' + folderName;
            _loadMultiSample(audioFiles, instName, function(ok, name) {
              if (ok) { populateInstSelects(); if (window.refreshAllGlows) window.refreshAllGlows(); _persist(audioFiles, folderName); }
              if (btn) { btn.textContent = ok ? name + ' \u2713' : 'Retry'; btn.disabled = false; }
            });
          } else if (audioFiles === null) {
            // Not a directory — single file
            _loadSinglePath(paths[0], function(ok, name) {
              if (ok) { populateInstSelects(); if (window.refreshAllGlows) window.refreshAllGlows(); _persist([paths[0]]); }
              if (btn) { btn.textContent = ok ? name + ' \u2713' : 'Retry'; btn.disabled = false; }
            });
          } else {
            // Empty directory
            if (btn) { btn.textContent = 'No audio'; btn.disabled = false; }
          }
        });
      } else if (paths.length === 1) {
        // Single file, no listDir available
        _loadSinglePath(paths[0], function(ok, name) {
          if (ok) { populateInstSelects(); if (window.refreshAllGlows) window.refreshAllGlows(); _persist([paths[0]]); }
          if (btn) { btn.textContent = ok ? name + ' \u2713' : 'Retry'; btn.disabled = false; }
        });
      } else {
        // Multiple files selected — check if note-named
        var hasNotes = true;
        for (var pi = 0; pi < paths.length; pi++) {
          var pName = paths[pi].split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '');
          if (!SampleLoader.noteNameToMidi || SampleLoader.noteNameToMidi(pName) < 0) {
            hasNotes = false;
            break;
          }
        }

        if (hasNotes) {
          // All note-named → multi-sample instrument
          var firstName = paths[0].split('/').pop().split('\\').pop().replace(/\.[^.]+$/, '');
          var parentDir = paths[0].substring(0, paths[0].lastIndexOf('/'));
          var folderLabel = parentDir.split('/').pop().replace(/[^a-zA-Z0-9_]/g, '_');
          var instName = 'user_' + (folderLabel || 'multi_sample');
          _loadMultiSample(paths, instName, function(ok, name) {
            if (ok) { populateInstSelects(); if (window.refreshAllGlows) window.refreshAllGlows(); _persist(paths, folderLabel); }
            if (btn) { btn.textContent = ok ? name + ' \u2713' : 'Retry'; btn.disabled = false; }
          });
        } else {
          // Not note-named → load each as individual instrument
          var loaded = 0, succeeded = 0, total = paths.length;
          for (var li = 0; li < paths.length; li++) {
            (function(fp) {
              _loadSinglePath(fp, function(ok) {
                loaded++;
                if (ok) succeeded++;
                if (loaded >= total) {
                  if (succeeded > 0) { populateInstSelects(); if (window.refreshAllGlows) window.refreshAllGlows(); _persist(paths); }
                  if (btn) {
                    btn.textContent = succeeded + '/' + total + ' loaded';
                    btn.disabled = false;
                  }
                }
              });
            })(paths[li]);
          }
        }
      }
    });
    return;
  }

  // Browser: use HTML file input
  var input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.js,.wav,.mp3,.ogg,.flac,.webm,.m4a,.aac';
  input.onchange = function() {
    var files = input.files;
    if (!files || files.length === 0) return;
    var firstName = files[0].name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
    var instName = 'user_' + (firstName || 'custom_sound');
    if (btn) { btn.textContent = 'Loading\u2026'; btn.disabled = true; }
    if (files.length === 1) {
      SampleLoader.loadFromFile(instName, files[0], function(ok) {
        if (ok) populateInstSelects();
        if (btn) { btn.textContent = ok ? instName + ' \u2713' : 'Retry'; btn.disabled = false; }
      });
    } else {
      // Multi-file: try note-name inference
      var entries = [];
      for (var i = 0; i < files.length; i++) {
        var name = files[i].name.replace(/\.[^.]+$/, '');
        var midi = SampleLoader.noteNameToMidi ? SampleLoader.noteNameToMidi(name) : -1;
        if (midi >= 0) entries.push({ file: files[i], midi: midi });
      }
      if (entries.length > 0) {
        SampleLoader.loadFromFiles(instName, entries, function(ok) {
          if (ok) populateInstSelects();
          if (btn) { btn.textContent = ok ? instName + ' \u2713' : 'Retry'; btn.disabled = false; }
        });
      } else {
        SampleLoader.loadFromFile(instName, files[0], function(ok) {
          if (ok) populateInstSelects();
          if (btn) { btn.textContent = ok ? instName + ' \u2713' : 'Retry'; btn.disabled = false; }
        });
      }
    }
  };
  input.click();
};

if (typeof SampleLoader !== 'undefined' && document.getElementById('cWrap')) {
  SampleLoader.enableDragDrop('cWrap', function(instName, ok) {
    if (ok) populateInstSelects();
  });
}

// (Section 6 removed — Accompany toggle was a no-op since v3.8.2 when
//  OwnershipDetector was removed. Human is always a peer. Buttons removed.)

// ─────────────────────────────────────
// 7. VISUAL HOOKS (edge counting + cursor tracking)
// ─────────────────────────────────────
window._assistantFlashDim = 0.15;
window._humanLastTrailIdx = null;
window._trailSameSource   = true;

if (typeof addToTrail === 'function') {
  var _origAddToTrail = addToTrail;
  window.addToTrail = function(nodeIdx, pc, source) {
    if (typeof trail !== 'undefined' && trail.length > 0) {
      window._trailSameSource = (trail[trail.length - 1].src === source);
    } else {
      window._trailSameSource = true;
    }
    _origAddToTrail(nodeIdx, pc, source);
    if (source === 'human') window._humanLastTrailIdx = nodeIdx;
  };
}

// ─────────────────────────────────────
// 7b. LAYOUT CONSOLIDATION — DOM SURGERY
// Physically moves .controls and .ctrl-row2 before .canvas-wrap in the DOM.
// CSS order alone doesn't work because the body flex layout isn't guaranteed
// to honour it across all browsers/versions.
// Also collapses the empty header and merges .header-right into .controls.
// ─────────────────────────────────────
(function() {
  setTimeout(function() {
    var canvasWrap  = document.getElementById('cWrap') || document.querySelector('.canvas-wrap');
    var controls    = document.querySelector('.controls');
    var ctrlRow2    = document.querySelector('.ctrl-row2');
    var headerRight = document.querySelector('.header-right');
    var header      = document.querySelector('.header');
    var h1          = header && header.querySelector('h1');
    var sub         = header && header.querySelector('.sub');

    // Hide title text — shown on boot screen, not needed in the main UI
    if (h1)  h1.style.display  = 'none';
    if (sub) sub.style.display = 'none';

    // Physically move selector row + transport bar above the canvas
    if (canvasWrap && canvasWrap.parentNode) {
      var parent = canvasWrap.parentNode;
      // Detach both rows and reinsert before canvas in order:
      //   controls (selectors + BPM) → ctrl-row2 (transport) → canvas
      if (ctrlRow2  && ctrlRow2.parentNode)  ctrlRow2.parentNode.removeChild(ctrlRow2);
      if (controls  && controls.parentNode)  controls.parentNode.removeChild(controls);
      parent.insertBefore(ctrlRow2,  canvasWrap);
      parent.insertBefore(controls,  ctrlRow2);
    }

    // Merge .header-right (voice indicators + BPM) into controls as rightmost element
    if (headerRight && controls) {
      var spacer = document.createElement('div');
      spacer.style.cssText = 'flex:1;min-width:8px;pointer-events:none';
      controls.appendChild(spacer);

      // Phase 15b: Move voice indicators (B/M/T) next to BPM slider area
      var voiceInd = headerRight.querySelector('.voice-ind');
      var bpmGroup = controls.querySelector('.ctrl-bpm');
      if (voiceInd && bpmGroup) {
        voiceInd.classList.add('vi-relocated');
        bpmGroup.appendChild(voiceInd);
      }

      // Phase 15b: Hide the redundant large BPM number (tempoDisp) —
      // the BPM slider value is now the single dynamic BPM display.
      // Keep the confidence dot visible — move it next to the BPM slider area.
      var tempoDisp = headerRight.querySelector('.tempo-disp');
      if (tempoDisp && bpmGroup) {
        var tdSpan = document.getElementById('tempoDisp');
        if (tdSpan) tdSpan.style.display = 'none';
        // Move the whole tempo-disp container (with conf-dot) into BPM group
        bpmGroup.appendChild(tempoDisp);
        tempoDisp.style.marginLeft = '4px';
      }

      // Keep conf dot visible
      controls.appendChild(headerRight);
    }

    // Collapse the now-empty header to just its amber top accent line
    if (header) {
      header.style.cssText =
        'height:2px;min-height:0;padding:0;overflow:hidden;border-bottom:none;flex-shrink:0;position:relative';
    }

    // Give controls the amber top border so it reads as the screen's top edge
    if (controls) {
      controls.style.borderTop     = '1px solid rgba(200,120,0,.22)';
      controls.style.paddingTop    = '5px';
      controls.style.paddingBottom = '5px';
      controls.style.zIndex        = '20';
    }
  }, 80);
})();


// ─────────────────────────────────────
// 8. REAL-SIGNAL WAVEFORM OSCILLOSCOPE (Phase 15)
// ─────────────────────────────────────
//
// Architecture:
//   AnalyserNodes connected to SoundEngine's per-voice channel strips.
//   Each analyser sees the REAL composite signal of all notes in that voice —
//   polyphonic overlap, instrument timbre, ADSR envelopes, everything.
//
//   Phase 15 replaces the fake-oscillator approach (Phase 7–14) with real
//   signal taps via SoundEngine.connectAnalyser(). The drawing code is
//   unchanged — Catmull-Rom trace with amber phosphor CRT aesthetic.

(function() {

  var _analysers   = {};   // voiceName → AnalyserNode
  var _cvs         = {};
  var _ctxs        = {};
  var _drawStarted = false;
  var _connected   = false;

  var VC = {
    human:  { qs:'.ch-you .mx-wv canvas',  fb:'wv_humanVol',
              r:175, g:200, b:185 },
    bass:   { qs:'.ch-bass .mx-wv canvas', fb:'wv_bassVol',
              r:20,  g:230, b:180 },
    rhythm: { qs:'.ch-rhythm .mx-wv canvas',  fb:'wv_rhythmVol',
              r:240, g:140, b:10 },
    soloist: { qs:'.ch-soloist .mx-wv canvas', fb:'wv_soloistVol',
              r:200, g:235, b:25 },
    lead:   { qs:'.ch-lead .mx-wv canvas', fb:'wv_leadVol',
              r:212, g:176, b:64 },
    percussion: { qs:'.ch-perc .mx-wv canvas', fb:'wv_percVol',
              r:224, g:64, b:64 }
  };

  function connectRealAnalysers() {
    if (_connected) return;
    if (typeof SoundEngine === 'undefined' || !SoundEngine.getCtx || !SoundEngine.getAnalyser) return;
    var c;
    try { c = SoundEngine.getCtx(); } catch(e) { return; }
    if (!c) return;

    // Analysers are now built into each strip — just fetch references
    for (var vn in VC) {
      var an = SoundEngine.getAnalyser(vn);
      if (an) _analysers[vn] = an;
    }
    _connected = true;
  }

  function findCanvas(vn) {
    if (_cvs[vn]) return _cvs[vn];
    var cfg = VC[vn];
    var cv = document.querySelector(cfg.qs) || document.getElementById(cfg.fb);
    if (cv) { _cvs[vn] = cv; _ctxs[vn] = cv.getContext('2d'); }
    return cv || null;
  }

  // ── Backward-compat stubs ──
  // app.js and input-handler still call these. With real signal they're no-ops
  // except _wvTrigger ensures analysers connect on first interaction.
  window._wvTrigger = function(voice, midi) {
    if (!_connected) connectRealAnalysers();
  };
  window._wvNoteOff = function(voice) {};

  // Sustain pedal wrapper — kept so callers don't break.
  if (typeof SoundEngine !== 'undefined' && SoundEngine.setSustainPedal) {
    var _origSetSustainPedal = SoundEngine.setSustainPedal;
    SoundEngine.setSustainPedal = function(on) {
      _origSetSustainPedal(on);
    };
  }

  function resizeCanvas(cv) {
    var par = cv.parentElement; if (!par) return;
    var dpr = window.devicePixelRatio || 1;
    var pw = Math.max(par.clientWidth, 20), ph = Math.max(par.clientHeight, 20);
    var tw = Math.round(pw * dpr), th = Math.round(ph * dpr);
    if (cv.width !== tw || cv.height !== th) {
      cv.width = tw; cv.height = th;
      cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
    }
  }

  function drawLoop() {
    for (var vn in VC) {
      var cv  = findCanvas(vn); var c = _ctxs[vn];
      var cfg = VC[vn];        var an = _analysers[vn];
      if (!cv || !c) continue;
      resizeCanvas(cv);
      var W = cv.width, H = cv.height;
      if (W < 4 || H < 4) continue;

      // Phosphor persistence — warm amber-olive tint (not pure black)
      c.fillStyle = 'rgba(6,5,1,0.24)';
      c.fillRect(0, 0, W, H);

      _drawGrid(c, W, H);

      if (!_connected || !an) { _drawIdle(c, W, H, cfg); _drawScanlines(c, W, H); continue; }

      var bufLen = an.frequencyBinCount;
      var data   = new Uint8Array(bufLen);
      an.getByteTimeDomainData(data);

      var rms = 0;
      for (var di = 0; di < bufLen; di++) rms += Math.pow((data[di] - 128) / 128, 2);
      rms = Math.sqrt(rms / bufLen);

      if (rms < 0.006) { _drawIdle(c, W, H, cfg); }
      else             { _drawTrace(c, W, H, data, bufLen, Math.min(1.0, rms * 4.2), cfg); }

      _drawScanlines(c, W, H);
    }
    requestAnimationFrame(drawLoop);
  }

  // ── Amber graticule ──
  function _drawGrid(c, W, H) {
    c.fillStyle = 'rgba(28,22,4,0.22)';
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(55,40,6,0.07)';
    c.fillRect(0, 0, W, H);

    c.lineWidth = 0.5; c.setLineDash([]);
    for (var hd = 1; hd < 8; hd++) {
      c.strokeStyle = (hd === 4) ? 'rgba(200,140,10,0.28)' : 'rgba(180,120,8,0.14)';
      c.beginPath(); c.moveTo(W * hd / 8, 0); c.lineTo(W * hd / 8, H); c.stroke();
    }
    for (var vd = 1; vd < 6; vd++) {
      c.strokeStyle = (vd === 3) ? 'rgba(200,140,10,0.28)' : 'rgba(180,120,8,0.14)';
      c.beginPath(); c.moveTo(0, H * vd / 6); c.lineTo(W, H * vd / 6); c.stroke();
    }
    c.strokeStyle = 'rgba(155,105,6,0.18)'; c.lineWidth = 0.4;
    var th = H * 0.07, tw = W * 0.012;
    for (var xt = 0; xt <= 40; xt++) {
      var tx = W * xt / 40;
      c.beginPath(); c.moveTo(tx, H/2 - th); c.lineTo(tx, H/2 + th); c.stroke();
    }
    for (var yt = 0; yt <= 30; yt++) {
      var ty = H * yt / 30;
      c.beginPath(); c.moveTo(W/2 - tw, ty); c.lineTo(W/2 + tw, ty); c.stroke();
    }
    var gl = c.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H) * 0.65);
    gl.addColorStop(0,   'rgba(80,58,8,0.12)');
    gl.addColorStop(0.5, 'rgba(40,28,4,0.05)');
    gl.addColorStop(1,   'rgba(0,0,0,0)');
    c.fillStyle = gl; c.fillRect(0, 0, W, H);
  }

  function _drawIdle(c, W, H, cfg) {
    var r = cfg.r, g = cfg.g, b = cfg.b;
    c.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.055)';
    c.lineWidth = 0.8; c.setLineDash([3, 14]);
    c.beginPath(); c.moveTo(0, H/2); c.lineTo(W, H/2); c.stroke();
    c.setLineDash([]);
    if (Math.random() < 0.16) {
      c.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.12)';
      c.fillRect((Math.random() * W) | 0, ((H/2) + (Math.random()-0.5)*6) | 0, 1, 1);
    }
  }

  // 6-pass trace: amber corona + wide glow + mid + halo + main + filament
  function _drawTrace(c, W, H, data, bufLen, amp, cfg) {
    var r = cfg.r, g = cfg.g, b = cfg.b;

    var pts = new Float32Array(W);
    var step = bufLen / W;
    // Phase 15b: boosted vertical scale — fills 96% of half-height
    // with auto-gain that amplifies quiet signals up to 3× for visibility
    var rawRms = amp / 4.2; // back-derive from clamped amp
    var autoGain = Math.max(1.5, Math.min(5.0, 0.45 / (rawRms + 0.005)));
    var vscale = (H / 2) * 0.98 * autoGain;
    for (var xi = 0; xi < W; xi++) {
      var fi = xi * step, lo = fi | 0, hi = Math.min(bufLen-1, lo+1), t = fi - lo;
      var raw = ((data[lo]*(1-t) + data[hi]*t - 128) / 128);
      // Soft-clip to prevent overflow past canvas edge
      if (raw > 1) raw = 1; else if (raw < -1) raw = -1;
      pts[xi] = H/2 - raw * vscale;
    }

    c.lineJoin = 'round';
    c.lineCap  = 'round';

    // CRT phosphor glow — applied to all passes via shadowBlur
    c.shadowColor = 'rgba(' + r + ',' + g + ',' + b + ',' + (amp * 0.35) + ')';
    c.shadowBlur = 10;

    // Pass 0 — amber corona
    c.lineWidth = 12;
    c.strokeStyle = 'rgba(200,110,4,' + (amp * 0.055) + ')';
    _tracePath(c, pts, W); c.stroke();

    // Pass 1 — wide diffuse glow
    c.lineWidth = 15;
    c.shadowBlur = 14;
    c.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + (amp * 0.038) + ')';
    _tracePath(c, pts, W); c.stroke();

    // Pass 2 — mid glow
    c.lineWidth = 6.5;
    c.shadowBlur = 8;
    c.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + (amp * 0.10) + ')';
    _tracePath(c, pts, W); c.stroke();

    // Pass 3 — inner halo
    c.lineWidth = 2.8;
    c.shadowBlur = 5;
    c.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + (amp * 0.26) + ')';
    _tracePath(c, pts, W); c.stroke();

    // Pass 4 — main beam with edge-fade gradient
    c.shadowBlur = 3;
    var ma = Math.min(0.98, amp * 1.12 + 0.16);
    var grd = c.createLinearGradient(0, 0, W, 0);
    grd.addColorStop(0,    'rgba(' + r + ',' + g + ',' + b + ',0)');
    grd.addColorStop(0.03, 'rgba(' + r + ',' + g + ',' + b + ',' + ma + ')');
    grd.addColorStop(0.97, 'rgba(' + r + ',' + g + ',' + b + ',' + ma + ')');
    grd.addColorStop(1,    'rgba(' + r + ',' + g + ',' + b + ',0)');
    c.lineWidth = 1.4; c.strokeStyle = grd;
    _tracePath(c, pts, W); c.stroke();

    // Pass 5 — core filament
    var cr = Math.min(255, r+85), cg = Math.min(255, g+85), cb = Math.min(255, b+75);
    c.lineWidth = 0.6;
    c.shadowBlur = 0;
    c.shadowColor = 'transparent';
    c.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (amp * 0.85) + ')';
    _tracePath(c, pts, W); c.stroke();

    if (Math.random() < 0.009) {
      c.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.038)';
      c.fillRect(0, (Math.random() * H) | 0, W, 1);
    }
  }

  // Catmull-Rom smooth curve
  function _tracePath(c, pts, W) {
    if (W < 4) { c.beginPath(); c.moveTo(0, pts[0]); return; }
    c.beginPath();
    c.moveTo(0, pts[0]);
    for (var xi = 0; xi < W - 1; xi++) {
      var p0y = pts[Math.max(0, xi - 1)];
      var p1y = pts[xi];
      var p2y = pts[xi + 1];
      var p3y = pts[Math.min(W - 1, xi + 2)];
      var cp1x = xi + 1 / 3;
      var cp1y = p1y + (p2y - p0y) / 6;
      var cp2x = xi + 2 / 3;
      var cp2y = p2y - (p3y - p1y) / 6;
      c.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, xi + 1, p2y);
    }
  }

  function _drawScanlines(c, W, H) {
    c.fillStyle = 'rgba(0,0,0,0.13)';
    for (var sy = 1; sy < H; sy += 3) c.fillRect(0, sy, W, 1);
    var vg = c.createLinearGradient(0, 0, W, 0);
    vg.addColorStop(0, 'rgba(0,0,0,0.30)'); vg.addColorStop(0.04, 'rgba(0,0,0,0)');
    vg.addColorStop(0.96, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.30)');
    c.fillStyle = vg; c.fillRect(0, 0, W, H);
    var vgV = c.createLinearGradient(0, 0, 0, H);
    vgV.addColorStop(0, 'rgba(0,0,0,0.18)'); vgV.addColorStop(0.08, 'rgba(0,0,0,0)');
    vgV.addColorStop(0.92, 'rgba(0,0,0,0)'); vgV.addColorStop(1, 'rgba(0,0,0,0.18)');
    c.fillStyle = vgV; c.fillRect(0, 0, W, H);
  }

  // ── Clip LED — real peak detection ──
  var _clipTimer = 0;
  setInterval(function() {
    var cl = document.getElementById('clipLed');
    if (!cl || !_connected) return;
    var clipping = false;
    for (var vn in _analysers) {
      var an = _analysers[vn];
      if (!an) continue;
      var buf = new Uint8Array(an.fftSize);
      an.getByteTimeDomainData(buf);
      for (var i = 0; i < buf.length; i++) {
        if (buf[i] >= 254 || buf[i] <= 1) { clipping = true; break; }
      }
      if (clipping) break;
    }
    if (clipping) {
      cl.classList.add('clipping');
      _clipTimer = 6; // hold for ~3 sec
    } else if (_clipTimer > 0) {
      _clipTimer--;
      if (_clipTimer <= 0) cl.classList.remove('clipping');
    }
  }, 500);

  function tryInit() {
    connectRealAnalysers();
    document.removeEventListener('click',   tryInit);
    document.removeEventListener('keydown', tryInit);
  }
  document.addEventListener('click',   tryInit);
  document.addEventListener('keydown', tryInit);

  if (!_drawStarted) {
    _drawStarted = true;
    setTimeout(drawLoop, 350);
  }
  setTimeout(function() { if (!_connected) connectRealAnalysers(); }, 1400);

})();

// ─────────────────────────────────────
// 9. PHASE 13 — DOM SURGERY
// Hides seed button, sets fader defaults to 50%,
// creates drone ring waveform analyser.
// ─────────────────────────────────────
(function() {
  setTimeout(function() {

    // ── 9a. Hide Seed button ──
    var bSeed = document.getElementById('bSeed');
    if (bSeed) bSeed.style.display = 'none';

    // ── 9b. Set all channel faders to 50% default ──
    var faderIds = ['humanVol','bassVol','rhythmVol','soloistVol','leadVol','percVol'];
    for (var fi = 0; fi < faderIds.length; fi++) {
      var fEl = document.getElementById(faderIds[fi]);
      if (fEl) {
        fEl.value = 50;
        fEl.style.setProperty('--p', '50%');
        // Sync SoundEngine strip gains
        var fMap = { humanVol:'human', bassVol:'bass', rhythmVol:'rhythm', soloistVol:'soloist', leadVol:'lead', percVol:'percussion' };
        if (typeof SoundEngine !== 'undefined' && fMap[faderIds[fi]]) {
          SoundEngine.setVoiceGain(fMap[faderIds[fi]], 0.5);
        }
      }
      // Update value display
      var valMap = { humanVol:'fv-you', bassVol:'fv-bass', rhythmVol:'fv-rhythm', soloistVol:'fv-solo', leadVol:'fv-lead', percVol:'fv-perc' };
      var valEl = document.getElementById(valMap[faderIds[fi]]);
      if (valEl) valEl.textContent = '50';
    }

    // Master to 80 (gives headroom above and below)
    var masterEl = document.getElementById('masterVol');
    if (masterEl) {
      masterEl.value = 80;
      var mvEl = document.getElementById('masterVolVal');
      if (mvEl) mvEl.textContent = '80';
      if (typeof SoundEngine !== 'undefined') SoundEngine.setMasterVolume(0.80);
    }

    // (Section 9c removed — redundant transport-bar lead controls.
    //  Lead volume and instrument are controlled by the mixer strip #strip-lead.)
    var ctrlRow2 = document.querySelector('.ctrl-row2');

    // (Section 9d removed — Accompany/Jam button deleted. Human is always a peer.)

    // ── 9e. (removed — populateInstSelects now natively handles instDroneTransport) ──

    // ── 9f. Settings button — returns to boot screen ──
    if (ctrlRow2) {
      var spacer = document.querySelector('.ctrl-row2-spacer');
      var bSettings = document.createElement('button');
      bSettings.id = 'bSettings';
      bSettings.className = 'btn';
      bSettings.title = 'Settings / Load Resources';
      bSettings.innerHTML = '\u2699';  // gear Unicode
      bSettings.onclick = function(e) {
        e.stopPropagation();
        if (typeof window.showSettings === 'function') window.showSettings();
      };
      // Insert at the end of transport row (after spacer)
      if (spacer && spacer.nextSibling) {
        ctrlRow2.insertBefore(bSettings, spacer.nextSibling);
      } else {
        ctrlRow2.appendChild(bSettings);
      }
    }

    // ── 9g. Hide mixer utility panel — functions moved to boot screen ──
    var utilPanel = document.querySelector('.mx-panel.utility');
    if (utilPanel) utilPanel.style.display = 'none';
    // Also hide the old bLoadSamples, bLoadLTM since they're on boot screen now
    var hideIds = ['bLoadSamples', 'bLoadLTM'];
    for (var hi = 0; hi < hideIds.length; hi++) {
      var hEl = document.getElementById(hideIds[hi]);
      if (hEl) hEl.style.display = 'none';
    }

    // ── 9h. Rebuild FX-SEND panel with horizontal sliders (Phase 15b) ──
    var fxPanel = document.querySelector('.mx-panel.fx-send');
    if (fxPanel) {
      // Hide all existing horizontal rows
      var oldRows = fxPanel.querySelectorAll('.mx-panel-row');
      for (var ori = 0; ori < oldRows.length; ori++) oldRows[ori].style.display = 'none';

      // Build horizontal slider rows
      var hContainer = document.createElement('div');
      hContainer.className = 'mx-fx-hsliders';

      var fxDefs = [
        { id: 'reverbSlider', lbl: 'REV', def: 30, fn: function(v) { if (typeof SoundEngine !== 'undefined') SoundEngine.setReverb(v / 100); } },
        { id: 'sustainSlider', lbl: 'SUS', def: 50, fn: function(v) { if (typeof SoundEngine !== 'undefined') SoundEngine.setSustain(v / 100); } }
      ];

      for (var fxi = 0; fxi < fxDefs.length; fxi++) {
        (function(def) {
          var row = document.createElement('div');
          row.className = 'mx-fx-hrow';

          var lbl = document.createElement('span');
          lbl.className = 'mx-fx-hlbl';
          lbl.textContent = def.lbl;

          var slider = document.createElement('input');
          slider.type = 'range';
          slider.min = '0';
          slider.max = '100';
          slider.className = 'mx-fx-hslider';
          slider.id = def.id + '_h';

          var valDisp = document.createElement('span');
          valDisp.className = 'mx-fx-hval';

          // Sync from existing slider value if it exists
          var origSlider = document.getElementById(def.id);
          var initVal = origSlider ? +origSlider.value : def.def;
          initVal = Math.max(0, Math.min(100, initVal));
          slider.value = initVal;
          valDisp.textContent = initVal;

          slider.addEventListener('input', function() {
            var v = +this.value;
            valDisp.textContent = v;
            def.fn(v);
            if (origSlider) origSlider.value = v;
          });

          slider.addEventListener('dblclick', function() {
            this.value = def.def;
            valDisp.textContent = def.def;
            def.fn(def.def);
            if (origSlider) origSlider.value = def.def;
          });

          def.fn(initVal);

          row.appendChild(lbl);
          row.appendChild(slider);
          row.appendChild(valDisp);
          hContainer.appendChild(row);
        })(fxDefs[fxi]);
      }

      fxPanel.appendChild(hContainer);
      // NOTE: Drone sound selection removed from FX-SEND —
      // it already exists in the transport bar (section 9c).
    }

    // ── 9i. Add REC button to master panel ──
    var masterPanel = document.querySelector('.mx-panel.master');
    if (masterPanel) {
      var masterBody = masterPanel.querySelector('.mx-master-body');
      if (masterBody) {
        var recBtn = document.createElement('button');
        recBtn.id = 'bRec';
        recBtn.className = 'mx-rec-btn';
        recBtn.innerHTML = '<span class="mx-rec-dot"></span>REC';
        recBtn.title = 'Record session audio';
        recBtn.onclick = function() {
          if (typeof window._toggleRecording === 'function') {
            window._toggleRecording();
          }
        };
        masterBody.appendChild(recBtn);
      }
    }

    // ── 9j. Fix stuck sliders — add double-click reset to all panel sliders ──
    // Existing horizontal sliders in FX-SEND (if they somehow show)
    // and the master slider all get double-click-to-reset
    var masterFader = document.getElementById('masterVol');
    if (masterFader) {
      masterFader.addEventListener('dblclick', function() {
        this.value = 80;
        if (typeof SoundEngine !== 'undefined') SoundEngine.setMasterVolume(0.80);
        var mvEl = document.getElementById('masterVolVal');
        if (mvEl) mvEl.textContent = '80';
      });
    }

    // ── 9k. Fullscreen button removed — desktop app auto-fullscreens ──

    // ── 9l. (removed — drone dropdown moved to transport bar only) ──

    // ── 9m. Instrument Library — Subpage + Quick-Select ──
    // Two-part instrument UI:
    //   1. Full-page subpage — opened from settings via INSTRUMENTS button
    //      - Channel selector (P/B/M/T/D) with gold glow on selected
    //      - Single click = gold check (add to quick-select palette)
    //      - Double click = blue active (set as current instrument)
    //      - Both = dual gold+blue glow
    //   2. Quick-select popup — only shows gold-checked instruments
    //      - Single click = set as active (blue)
    // State persisted in localStorage key 'veles_inst_selections'
    (function buildInstrumentLibrary() {

      // ── Shared constants ──
      var CATEGORIES = [
        { name: 'SYNTH (FM)', items: [
          {id:'piano',label:'Piano'},{id:'eguitar',label:'E.Guitar'},{id:'aguitar',label:'A.Guitar'},
          {id:'synth',label:'Synth'},{id:'sine',label:'Sine'},{id:'pad',label:'Pad'},
          {id:'choir',label:'Choir'},{id:'strings',label:'Strings'},{id:'organ',label:'Organ'}
        ]},
        { name: 'KEYS', items: [
          {id:'gm_piano',label:'Grand Piano'},{id:'gm_epiano',label:'Electric Piano'},
          {id:'gm_grand_epiano',label:'E.Grand Piano'},{id:'gm_organ',label:'Drawbar Organ'}
        ]},
        { name: 'STRINGS', items: [
          {id:'gm_strings',label:'String Ensemble'},{id:'gm_cello',label:'Cello'},
          {id:'violin',label:'Violin',tj:true},{id:'contrabass',label:'Contrabass',tj:true},
          {id:'harp',label:'Harp',tj:true}
        ]},
        { name: 'BRASS & WIND', items: [
          {id:'gm_trumpet',label:'Trumpet'},{id:'gm_flute',label:'Flute'},{id:'gm_oboe',label:'Oboe'},
          {id:'french-horn',label:'French Horn',tj:true},{id:'trombone',label:'Trombone',tj:true},
          {id:'saxophone',label:'Saxophone',tj:true}
        ]},
        { name: 'PADS & LEADS', items: [
          {id:'gm_warm_pad',label:'Warm Pad'},{id:'gm_synth_brass',label:'Synth Brass'},
          {id:'gm_square_lead',label:'Square Lead'},{id:'gm_saw_lead',label:'Saw Lead'},
          {id:'gm_choir',label:'Choir Aahs'}
        ]},
        { name: 'GUITAR & BASS', items: [
          {id:'guitar-acoustic',label:'Acoustic Guitar',tj:true},{id:'guitar-electric',label:'Electric Guitar',tj:true},
          {id:'bass-electric',label:'Electric Bass',tj:true},{id:'harmonium',label:'Harmonium',tj:true}
        ]}
      ];

      var VOICE_MAP = {human:'human',bass:'bass',rhythm:'rhythm',soloist:'soloist',lead:'lead',percussion:'percussion'};
      var ALL_CHANNELS = ['human','bass','rhythm','soloist','lead','percussion'];
      var CH_LABELS = {human:'P',bass:'B',rhythm:'R',soloist:'S',lead:'L',percussion:'D'};
      var CH_FULLNAMES = {human:'PLAYER',bass:'BASS',rhythm:'RHYTHM',soloist:'SOLOIST',lead:'LEAD',percussion:'DRUMS'};

      // Percussion uses synthesized drum timbres, not sampled instruments.
      // Each timbre defines a distinct playing character (kick/snare/hat synthesis params).
      var PERC_TIMBRES = [
        { id: '808',          label: '808 Electronic',   desc: 'Classic TR-808 drum machine' },
        { id: 'acoustic',     label: 'Acoustic Kit',     desc: 'Natural drum kit' },
        { id: 'jazz',         label: 'Jazz Kit',         desc: 'Soft, warm jazz drums' },
        { id: 'jazz_brushes', label: 'Jazz Brushes',     desc: 'Brush sweeps + ride cymbal' },
        { id: 'latin_perc',   label: 'Latin Percussion', desc: 'Cowbell, rimshot, conga feel' },
        { id: 'soul_pocket',  label: 'Soul Pocket',      desc: 'Deep kick, crisp snare, groove' },
        { id: 'timpani',      label: 'Timpani',          desc: 'Orchestral kettle drums' },
        { id: 'maracas',      label: 'Maracas',          desc: 'Shaker texture only' }
      ];

      var GLOW_GOLD = '#d4b040';
      var GLOW_BLUE = '#40a0d4';

      var _currentChannel = 'bass';

      // ── Checked instruments per channel (gold) — persisted ──
      var _checkedInsts = {};  // { human: ['gm_piano','synth'], bass: [...], ... }
      try {
        var stored = localStorage.getItem('veles_inst_selections');
        if (stored) _checkedInsts = JSON.parse(stored);
      } catch(e) {}
      for (var ci0 = 0; ci0 < ALL_CHANNELS.length; ci0++) {
        if (!_checkedInsts[ALL_CHANNELS[ci0]]) _checkedInsts[ALL_CHANNELS[ci0]] = [];
      }

      function saveChecked() {
        try { localStorage.setItem('veles_inst_selections', JSON.stringify(_checkedInsts)); } catch(e) {}
      }

      function isChecked(channel, instId) {
        return _checkedInsts[channel] && _checkedInsts[channel].indexOf(instId) > -1;
      }

      function toggleChecked(channel, instId) {
        if (!_checkedInsts[channel]) _checkedInsts[channel] = [];
        var idx = _checkedInsts[channel].indexOf(instId);
        if (idx > -1) {
          _checkedInsts[channel].splice(idx, 1);
        } else {
          _checkedInsts[channel].push(instId);
        }
        saveChecked();
      }

      // ── Alias reverse-map: SoundEngine name → subpage button ID ──
      // When CDN loads "acoustic_grand_piano", it registers alias "gm_piano".
      // The subpage button has id "gm_piano". So we need to resolve both ways.
      var _aliasToButtonId = {};  // e.g. acoustic_grand_piano → gm_piano, tj_violin → violin
      var _buttonIdToAliases = {}; // e.g. gm_piano → [acoustic_grand_piano, gm_piano]
      (function buildAliasMap() {
        // Build from CATEGORIES — collect all button IDs
        var allButtonIds = {};
        for (var ci2 = 0; ci2 < CATEGORIES.length; ci2++) {
          for (var ii2 = 0; ii2 < CATEGORIES[ci2].items.length; ii2++) {
            allButtonIds[CATEGORIES[ci2].items[ii2].id] = true;
          }
        }
        // Known alias pairs from sample-loader (CDN + ToneJS defaults)
        var KNOWN_ALIASES = [
          // CDN
          ['acoustic_grand_piano','gm_piano'],['electric_piano_1','gm_epiano'],
          ['electric_grand_piano','gm_grand_epiano'],['drawbar_organ','gm_organ'],
          ['string_ensemble_1','gm_strings'],['cello','gm_cello'],
          ['flute','gm_flute'],['trumpet','gm_trumpet'],['oboe','gm_oboe'],
          ['choir_aahs','gm_choir'],['pad_2_warm','gm_warm_pad'],
          ['synth_brass_1','gm_synth_brass'],['lead_1_square','gm_square_lead'],
          ['lead_2_sawtooth','gm_saw_lead'],
          // ToneJS: raw name IS the button id
          ['violin','violin'],['contrabass','contrabass'],['harp','harp'],
          ['french-horn','french-horn'],['trombone','trombone'],['saxophone','saxophone'],
          ['guitar-acoustic','guitar-acoustic'],['guitar-electric','guitar-electric'],
          ['bass-electric','bass-electric'],['harmonium','harmonium']
        ];
        for (var ai = 0; ai < KNOWN_ALIASES.length; ai++) {
          var rawName = KNOWN_ALIASES[ai][0];
          var btnId = KNOWN_ALIASES[ai][1];
          _aliasToButtonId[rawName] = btnId;
          _aliasToButtonId[btnId] = btnId;  // alias itself maps to button
          // Also map any "tj_" or "gm_" alias to button id
          if (!_buttonIdToAliases[btnId]) _buttonIdToAliases[btnId] = [];
          _buttonIdToAliases[btnId].push(rawName);
          _buttonIdToAliases[btnId].push(btnId);
        }
      })();

      // ── Shared helpers ──
      // Resolve a SoundEngine instrument name to the subpage button ID
      function resolveToButtonId(instName) {
        if (!instName) return '';
        if (_aliasToButtonId[instName]) return _aliasToButtonId[instName];
        return instName; // fallback: assume it's already a button id
      }

      function getCurInstId(channel) {
        if (channel === 'percussion') {
          // Percussion uses drum timbres, not sampled instruments
          if (typeof PercussionAssistant !== 'undefined' && PercussionAssistant.getTimbre) {
            return PercussionAssistant.getTimbre();
          }
          var pSel = document.getElementById('instPerc');
          return pSel ? pSel.value : '808';
        }
        var selId = channel === 'lead' ? 'instLead' : 'inst' + channel.charAt(0).toUpperCase() + channel.slice(1);
        var sel = document.getElementById(selId);
        return sel ? sel.value : '';
      }

      function formatInstName(id) {
        return id ? id.replace(/_/g,' ').replace(/-/g,' ').toUpperCase() : 'DEFAULT (FM)';
      }

      // ── Core assign (set active instrument) ──
      function doAssign(channel, instId) {
        if (channel === 'percussion') {
          // Percussion uses drum timbres via PercussionAssistant
          if (typeof PercussionAssistant !== 'undefined' && PercussionAssistant.setTimbre) {
            PercussionAssistant.setTimbre(instId || '808');
          }
          var pSel = document.getElementById('instPerc');
          if (pSel) { pSel.value = instId || '808'; }
          return;
        }
        if (channel === 'lead') {
          if (typeof SoundEngine !== 'undefined') {
            SoundEngine.setVoiceInstrument('lead', instId || null);
          }
          var lSel = document.getElementById('instLead');
          if (lSel) { lSel.value = instId || ''; lSel.classList.toggle('inst-active', !!instId); }
        } else {
          var voiceName = VOICE_MAP[channel] || channel;
          if (typeof SoundEngine !== 'undefined') {
            SoundEngine.setVoiceInstrument(voiceName, instId || null);
          }
          var selId = 'inst' + channel.charAt(0).toUpperCase() + channel.slice(1);
          var sel = document.getElementById(selId);
          if (sel) { sel.value = instId || ''; sel.classList.toggle('inst-active', !!instId); }
        }
      }

      function assignInstrument(channel, instId, isToneJS) {
        if (instId && typeof SampleLoader !== 'undefined') {
          if (!SampleLoader.isLoaded(instId)) {
            var loadFn = isToneJS ? SampleLoader.loadFromToneJS : function(name, cb) { SampleLoader.loadFromCDN(name, {}, cb); };
            loadFn(instId, function(ok) {
              if (ok) {
                doAssign(channel, instId);
                populateInstSelects();
                refreshAllGlows();
              }
            });
            return;
          }
        }
        doAssign(channel, instId);
        refreshAllGlows();
      }

      // ── Glow refresh ──
      var _glowCallbacks = [];
      window.refreshAllGlows = refreshAllGlows;
      function refreshAllGlows() {
        for (var gi = 0; gi < _glowCallbacks.length; gi++) {
          try { _glowCallbacks[gi](); } catch(e) {}
        }
        for (var ci = 0; ci < ALL_CHANNELS.length; ci++) {
          var ch = ALL_CHANNELS[ci];
          var lbl = document.querySelector('button.mx-inst-qs[data-ch="' + ch + '"]');
          if (lbl) {
            var cur = getCurInstId(ch);
            lbl.textContent = cur ? formatInstName(cur) : '\u2014 DEFAULT \u2014';
          }
        }
      }

      // ══════════════════════════════════════════
      // PART 1: Instrument Subpage (full-page overlay)
      // ══════════════════════════════════════════
      var subpage = document.createElement('div');
      subpage.id = 'instSubpage';
      subpage.className = 'inst-subpage';
      subpage.style.display = 'none';

      // Build subpage HTML
      var spHtml = '<div class="inst-sp-header">' +
        '<button class="inst-sp-back" id="instSpBack">\u25c0 BACK</button>' +
        '<span class="inst-sp-title">INSTRUMENTS</span>' +
        '<button class="inst-sp-upload" id="instSpUpload">+ UPLOAD</button>' +
        '</div>' +
        '<div class="inst-sp-channels" id="instSpChRow"></div>' +
        '<div class="inst-sp-grid" id="instSpGrid"></div>' +
        '<div class="inst-sp-footer">' +
        '<button class="inst-sp-default" id="instSpDefault">\u25c0 DEFAULT (FM)</button>' +
        '</div>';
      subpage.innerHTML = spHtml;
      document.body.appendChild(subpage);

      // Channel row
      var spChRow = document.getElementById('instSpChRow');
      var spChBtns = {};
      for (var ci = 0; ci < ALL_CHANNELS.length; ci++) {
        (function(ch) {
          var wrap = document.createElement('div');
          wrap.className = 'inst-sp-ch-wrap';
          var btn = document.createElement('button');
          btn.className = 'inst-sp-ch' + (ch === _currentChannel ? ' inst-sp-ch-sel' : '');
          btn.dataset.ch = ch;
          btn.textContent = CH_LABELS[ch];
          btn.title = CH_FULLNAMES[ch];
          btn.onclick = function(e) {
            e.stopPropagation();
            _currentChannel = ch;
            refreshSubpageGlows();
          };
          var sub = document.createElement('div');
          sub.className = 'inst-sp-ch-sub';
          sub.dataset.ch = ch;
          sub.textContent = 'DEFAULT';
          wrap.appendChild(btn);
          wrap.appendChild(sub);
          spChBtns[ch] = { btn: btn, sub: sub };
          spChRow.appendChild(wrap);
        })(ALL_CHANNELS[ci]);
      }

      // Grid
      var spGrid = document.getElementById('instSpGrid');
      var spBtns = [];  // all instrument buttons in subpage

      for (var ci2 = 0; ci2 < CATEGORIES.length; ci2++) {
        var cat = CATEGORIES[ci2];
        var catHdr = document.createElement('div');
        catHdr.className = 'inst-sp-cat-hdr';
        catHdr.textContent = cat.name;
        spGrid.appendChild(catHdr);

        var catRow = document.createElement('div');
        catRow.className = 'inst-sp-cat-row';

        for (var ii = 0; ii < cat.items.length; ii++) {
          (function(inst) {
            var btn = document.createElement('button');
            btn.className = 'inst-sp-btn';
            btn.dataset.instId = inst.id;
            btn.dataset.isTj = inst.tj ? '1' : '';
            btn.textContent = inst.label + (inst.tj ? ' \u2605' : '');

            var _clickTimer = null;

            // Single click = toggle gold check
            btn.onclick = function(e) {
              e.stopPropagation();
              if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; return; }
              _clickTimer = setTimeout(function() {
                _clickTimer = null;
                toggleChecked(_currentChannel, inst.id);
                // If checking, ensure instrument is loaded
                if (isChecked(_currentChannel, inst.id) && inst.id && typeof SampleLoader !== 'undefined' && !SampleLoader.isLoaded(inst.id)) {
                  var loadFn = inst.tj ? SampleLoader.loadFromToneJS : function(name, cb) { SampleLoader.loadFromCDN(name, {}, cb); };
                  loadFn(inst.id, function() { refreshAllGlows(); });
                }
                refreshAllGlows();
              }, 250);
            };

            // Double click = set as active (blue)
            btn.ondblclick = function(e) {
              e.stopPropagation();
              if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
              // Also gold-check it if not already
              if (!isChecked(_currentChannel, inst.id)) {
                toggleChecked(_currentChannel, inst.id);
              }
              assignInstrument(_currentChannel, inst.id, !!inst.tj);
            };

            spBtns.push(btn);
            catRow.appendChild(btn);
          })(cat.items[ii]);
        }

        spGrid.appendChild(catRow);
      }

      // ── USER SAMPLES dynamic category ──
      var userCatHdr = document.createElement('div');
      userCatHdr.className = 'inst-sp-cat-hdr';
      userCatHdr.textContent = 'USER SAMPLES';
      userCatHdr.id = 'instSpUserHdr';
      userCatHdr.style.display = 'none';
      spGrid.appendChild(userCatHdr);

      var userCatRow = document.createElement('div');
      userCatRow.className = 'inst-sp-cat-row';
      userCatRow.id = 'instSpUserRow';
      spGrid.appendChild(userCatRow);

      var _userSpBtns = []; // track user instrument buttons separately

      function refreshUserCategory() {
        var names = (typeof SoundEngine !== 'undefined') ? SoundEngine.getInstrumentNames() : [];
        var userNames = [];
        for (var un = 0; un < names.length; un++) {
          if (names[un].indexOf('user_') === 0 || names[un].indexOf('custom_') === 0) {
            userNames.push(names[un]);
          }
        }
        // Check if we need to rebuild (compare with existing buttons)
        var existingIds = [];
        for (var ei = 0; ei < _userSpBtns.length; ei++) existingIds.push(_userSpBtns[ei].dataset.instId);
        var needsRebuild = (userNames.length !== existingIds.length);
        if (!needsRebuild) {
          for (var ci4 = 0; ci4 < userNames.length; ci4++) {
            if (userNames[ci4] !== existingIds[ci4]) { needsRebuild = true; break; }
          }
        }
        if (!needsRebuild) return;

        // Clear and rebuild
        userCatRow.innerHTML = '';
        _userSpBtns = [];

        if (userNames.length === 0) {
          userCatHdr.style.display = 'none';
          return;
        }
        userCatHdr.style.display = '';

        for (var ub = 0; ub < userNames.length; ub++) {
          (function(instId) {
            var displayName = instId.replace(/^(user_|custom_)/, '').replace(/_/g, ' ');
            var btn = document.createElement('button');
            btn.className = 'inst-sp-btn';
            btn.dataset.instId = instId;
            btn.dataset.isTj = '';
            btn.textContent = '\u266b ' + displayName;

            var _clickTimer = null;

            // Single click = toggle gold check
            btn.onclick = function(e) {
              e.stopPropagation();
              if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; return; }
              _clickTimer = setTimeout(function() {
                _clickTimer = null;
                toggleChecked(_currentChannel, instId);
                refreshAllGlows();
              }, 250);
            };

            // Double click = set as active (blue)
            btn.ondblclick = function(e) {
              e.stopPropagation();
              if (_clickTimer) { clearTimeout(_clickTimer); _clickTimer = null; }
              if (!isChecked(_currentChannel, instId)) {
                toggleChecked(_currentChannel, instId);
              }
              assignInstrument(_currentChannel, instId, false);
            };

            _userSpBtns.push(btn);
            spBtns.push(btn); // also add to main array for glow refresh
            userCatRow.appendChild(btn);
          })(userNames[ub]);
        }
      }

      // ── PERCUSSION TIMBRES grid (shown only when percussion channel selected) ──
      var percGrid = document.createElement('div');
      percGrid.id = 'instSpPercGrid';
      percGrid.className = 'inst-sp-grid';
      percGrid.style.display = 'none';
      var percHdr = document.createElement('div');
      percHdr.className = 'inst-sp-cat-hdr';
      percHdr.textContent = 'DRUM TIMBRES';
      percGrid.appendChild(percHdr);
      var percRow = document.createElement('div');
      percRow.className = 'inst-sp-cat-row inst-sp-perc-row';
      var _percBtns = [];
      for (var pi = 0; pi < PERC_TIMBRES.length; pi++) {
        (function(pt) {
          var btn = document.createElement('button');
          btn.className = 'inst-sp-btn inst-sp-perc-btn';
          btn.dataset.timbreId = pt.id;
          var nameSpan = document.createElement('span');
          nameSpan.className = 'inst-sp-perc-name';
          nameSpan.textContent = pt.label;
          btn.appendChild(nameSpan);
          var descSpan = document.createElement('span');
          descSpan.className = 'inst-sp-perc-desc';
          descSpan.textContent = pt.desc;
          btn.appendChild(descSpan);
          btn.onclick = function(e) {
            e.stopPropagation();
            doAssign('percussion', pt.id);
            refreshAllGlows();
          };
          _percBtns.push(btn);
          percRow.appendChild(btn);
        })(PERC_TIMBRES[pi]);
      }
      percGrid.appendChild(percRow);
      // Insert percussion grid into subpage (after the main grid)
      subpage.insertBefore(percGrid, subpage.querySelector('.inst-sp-footer'));

      // Default button
      document.getElementById('instSpDefault').onclick = function(e) {
        e.stopPropagation();
        if (_currentChannel === 'percussion') {
          doAssign('percussion', '808');
        } else {
          assignInstrument(_currentChannel, null, false);
        }
      };

      // Back button
      document.getElementById('instSpBack').onclick = function(e) {
        e.stopPropagation();
        subpage.style.display = 'none';
      };

      // Upload button
      document.getElementById('instSpUpload').onclick = function(e) {
        e.stopPropagation();
        if (typeof pickSoundFile === 'function') pickSoundFile();
      };

      // Subpage glow refresh
      function refreshSubpageGlows() {
        var isPerc = (_currentChannel === 'percussion');
        // Toggle grids: show instrument grid or percussion grid
        spGrid.style.display = isPerc ? 'none' : '';
        percGrid.style.display = isPerc ? '' : 'none';
        // Update footer default button label
        var defBtn = document.getElementById('instSpDefault');
        if (defBtn) defBtn.textContent = isPerc ? '\u25c0 DEFAULT (808)' : '\u25c0 DEFAULT (FM)';

        refreshUserCategory(); // rebuild user section if instruments changed
        var curInstId = getCurInstId(_currentChannel);
        var curButtonId = resolveToButtonId(curInstId);
        // Channel buttons
        for (var ch in spChBtns) {
          var isSel = (ch === _currentChannel);
          spChBtns[ch].btn.className = 'inst-sp-ch' + (isSel ? ' inst-sp-ch-sel' : '');
          var cid = getCurInstId(ch);
          spChBtns[ch].sub.textContent = cid ? formatInstName(cid).substring(0, 14) : 'DEFAULT';
        }
        // Instrument buttons (non-percussion)
        if (!isPerc) {
          for (var b = 0; b < spBtns.length; b++) {
            var bid = spBtns[b].dataset.instId;
            var checked = isChecked(_currentChannel, bid);
            var active = (bid === curButtonId);
            spBtns[b].className = 'inst-sp-btn' +
              (checked && active ? ' inst-sp-both' :
               active ? ' inst-sp-active' :
               checked ? ' inst-sp-checked' : '');
          }
        }
        // Percussion timbre buttons
        if (isPerc) {
          var curTimbre = getCurInstId('percussion');
          for (var pb = 0; pb < _percBtns.length; pb++) {
            var tid = _percBtns[pb].dataset.timbreId;
            _percBtns[pb].className = 'inst-sp-btn inst-sp-perc-btn' +
              (tid === curTimbre ? ' inst-sp-active' : '');
          }
        }
      }

      _glowCallbacks.push(refreshSubpageGlows);

      window.openInstSubpage = function(channel) {
        if (channel) _currentChannel = channel;
        subpage.style.display = 'flex';
        refreshSubpageGlows();
      };

      // ══════════════════════════════════════════
      // PART 2: Quick-Select Popup (live play)
      // Shows ONLY gold-checked instruments for that channel.
      // Single click = set as active (blue).
      // ══════════════════════════════════════════
      var qPop = document.createElement('div');
      qPop.id = 'instQuickPop';
      qPop.className = 'inst-qpop';
      document.body.appendChild(qPop);

      var _qPopChannel = 'bass';

      function openQuickPop(channel, anchorEl) {
        _qPopChannel = channel;
        qPop.innerHTML = '';

        var rect = anchorEl.getBoundingClientRect();
        var popW = 220;
        var leftPos = Math.max(4, Math.min(rect.left, window.innerWidth - popW - 4));
        qPop.style.left = leftPos + 'px';
        qPop.style.top = '0px';
        qPop.style.display = 'block';

        var curId = getCurInstId(channel);
        var curBtnId = resolveToButtonId(curId);
        var checked = _checkedInsts[channel] || [];

        // Header
        var qHdr = document.createElement('div');
        qHdr.className = 'inst-qpop-hdr';
        qHdr.innerHTML = '<span>' + CH_FULLNAMES[channel] + '</span>';
        var closeX = document.createElement('span');
        closeX.textContent = '\u2715';
        closeX.className = 'inst-qpop-close';
        closeX.onclick = function() { qPop.style.display = 'none'; };
        qHdr.appendChild(closeX);
        qPop.appendChild(qHdr);

        // Default (FM) option
        qPop.appendChild(makeQItem('DEFAULT (FM)', null, curBtnId));

        // Only show gold-checked instruments
        if (checked.length > 0) {
          for (var ci3 = 0; ci3 < checked.length; ci3++) {
            qPop.appendChild(makeQItem(formatInstName(checked[ci3]), checked[ci3], curBtnId));
          }
        } else {
          var emptyMsg = document.createElement('div');
          emptyMsg.className = 'inst-qpop-empty';
          emptyMsg.textContent = 'No instruments selected. Use INSTRUMENTS in settings to add.';
          qPop.appendChild(emptyMsg);
        }

        // Position above anchor
        var popH = qPop.offsetHeight;
        var topPos = rect.top - popH - 4;
        if (topPos < 4) topPos = rect.bottom + 4;
        qPop.style.top = topPos + 'px';
      }

      // Build ToneJS lookup from CATEGORIES
      var _tjLookup = {};
      for (var _tci = 0; _tci < CATEGORIES.length; _tci++) {
        for (var _tii = 0; _tii < CATEGORIES[_tci].items.length; _tii++) {
          if (CATEGORIES[_tci].items[_tii].tj) _tjLookup[CATEGORIES[_tci].items[_tii].id] = true;
        }
      }

      function makeQItem(label, instId, curId) {
        var row = document.createElement('div');
        var isActive = (instId === curId) || (!instId && !curId);
        row.className = 'inst-qpop-item' + (isActive ? ' inst-qpop-active' : '');
        row.textContent = label;

        row.onclick = function() {
          assignInstrument(_qPopChannel, instId, !!_tjLookup[instId]);
          qPop.style.display = 'none';
        };
        return row;
      }

      // Dismiss popup on outside click
      document.addEventListener('click', function(e) {
        if (qPop.style.display !== 'none' && !qPop.contains(e.target)) {
          var isInstBtn = e.target.classList && e.target.classList.contains('mx-inst-qs');
          if (!isInstBtn) qPop.style.display = 'none';
        }
      });

      // Wire mixer strip selects → quick-select popup
      setTimeout(function() {
        var selIds = ['instHuman','instBass','instRhythm','instSoloist','instLead'];
        var chMap = {instHuman:'human',instBass:'bass',instRhythm:'rhythm',instSoloist:'soloist',instLead:'lead'};
        for (var si = 0; si < selIds.length; si++) {
          (function(sid, ch) {
            var sel = document.getElementById(sid);
            if (sel) {
              var wrapper = sel.parentNode;
              var libBtn = document.createElement('button');
              libBtn.className = 'mx-inst mx-inst-qs';
              libBtn.dataset.ch = ch;
              libBtn.style.cssText = (sel.style.cssText || '') + ';text-align:left;cursor:pointer';
              libBtn.textContent = sel.value ? sel.value.replace(/_/g,' ').toUpperCase() : '\u2014 DEFAULT \u2014';
              libBtn.onclick = function(e) {
                e.stopPropagation();
                openQuickPop(ch, libBtn);
              };
              sel.style.display = 'none';
              wrapper.insertBefore(libBtn, sel.nextSibling);
            }
          })(selIds[si], chMap[selIds[si]]);
        }
      }, 200);

      // ══════════════════════════════════════════
      // EXIT CONFIRMATION DIALOG
      // ══════════════════════════════════════════
      var exitDialog = document.createElement('div');
      exitDialog.id = 'exitConfirmDialog';
      exitDialog.className = 'inst-exit-dialog';
      exitDialog.style.display = 'none';
      exitDialog.innerHTML =
        '<div class="inst-exit-box">' +
          '<div class="inst-exit-msg">EXIT VELES?</div>' +
          '<div class="inst-exit-btns">' +
            '<button class="inst-exit-yes" id="exitYes">YES</button>' +
            '<button class="inst-exit-no" id="exitNo">NO</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(exitDialog);

      document.getElementById('exitYes').onclick = function(e) {
        e.stopPropagation();
        exitDialog.style.display = 'none';
        if (window.gen3 && window.gen3.app && window.gen3.app.quit) {
          window.gen3.app.quit();
        } else if (window.close) {
          window.close();
        } else if (document.fullscreenElement) {
          document.exitFullscreen();
        }
      };
      document.getElementById('exitNo').onclick = function(e) {
        e.stopPropagation();
        exitDialog.style.display = 'none';
      };

      window.showExitConfirm = function() {
        exitDialog.style.display = 'flex';
      };

      // Initial glow
      setTimeout(function() { refreshAllGlows(); }, 400);

    })();

  }, 120);
})();

// ─────────────────────────────────────
// 10. LEAD RING WAVEFORM — exported for app.js draw loop
// ─────────────────────────────────────
// Creates a silent AnalyserNode connected to the lead/drone gain path.
// Exports window._drawDroneWaveform(cx, drCx, drCy, rr) for the
// app.js PASS 9 lead ring renderer to call.
(function() {
  var _droneAnalyser = null;
  var _droneDataBuf = null;

  function ensureDroneAnalyser() {
    if (_droneAnalyser) return _droneAnalyser;
    if (typeof SoundEngine === 'undefined' || !SoundEngine.getAnalyser) return null;
    // Drone now has a built-in analyser in its strip
    var an = SoundEngine.getAnalyser('drone');
    if (!an) return null;
    _droneAnalyser = an;
    _droneDataBuf = new Uint8Array(an.frequencyBinCount);
    return _droneAnalyser;
  }

  // Draw a circular waveform inside the drone ring
  window._drawDroneWaveform = function(cx, drCx, drCy, rr, droneActive) {
    if (!droneActive) return;
    var an = ensureDroneAnalyser();
    if (!an) return;
    an.getByteTimeDomainData(_droneDataBuf);

    var len = _droneDataBuf.length;
    var innerR = rr * 0.65;  // waveform lives in inner 65% of ring

    // Compute RMS to scale visual amplitude dynamically
    var rms = 0;
    for (var ri = 0; ri < len; ri++) rms += Math.pow((_droneDataBuf[ri] - 128) / 128, 2);
    rms = Math.sqrt(rms / len);
    // Boost factor: quiet signals (sine) get extra amplification
    var ampBoost = Math.max(1.5, Math.min(8.0, 1.0 / (rms + 0.005)));

    cx.save();
    cx.beginPath();
    for (var i = 0; i < len; i++) {
      var angle = (i / len) * Math.PI * 2 - Math.PI / 2;
      var amp = (_droneDataBuf[i] - 128) / 128;  // -1..1
      var r = innerR + amp * rr * 0.50 * ampBoost; // ±50% of ring radius, boosted
      var x = drCx + Math.cos(angle) * r;
      var y = drCy + Math.sin(angle) * r;
      if (i === 0) cx.moveTo(x, y);
      else cx.lineTo(x, y);
    }
    cx.closePath();

    // Glowing amber fill — brighter center
    var wvGrad = cx.createRadialGradient(drCx, drCy, 0, drCx, drCy, rr * 0.8);
    wvGrad.addColorStop(0, 'rgba(212,176,64,0.10)');
    wvGrad.addColorStop(1, 'rgba(200,160,60,0.02)');
    cx.fillStyle = wvGrad;
    cx.fill();

    // Amber glow shadow — matches oscilloscope waveform style
    cx.shadowColor = 'rgba(212,176,64,0.55)';
    cx.shadowBlur = 8;

    // Main stroke — significantly brighter
    cx.strokeStyle = 'rgba(212,176,64,0.48)';
    cx.lineWidth = 1.6;
    cx.stroke();

    // Inner bright filament stroke — amber glow
    cx.shadowBlur = 4;
    cx.strokeStyle = 'rgba(240,210,80,0.22)';
    cx.lineWidth = 0.7;
    cx.stroke();

    // Reset shadow
    cx.shadowColor = 'transparent';
    cx.shadowBlur = 0;

    cx.restore();
  };
})();

// ─────────────────────────────────────
// 11. RECORDING (Phase 15)
// ─────────────────────────────────────
//
// Architecture:
//   MediaRecorder API with MediaStream from SoundEngine.getRecordingStream().
//   Taps the limiter output (same final signal as speakers).
//   REC button (already in master panel from 9i) toggles recording.
//   On stop: creates a downloadable .webm file with timestamped name.
//
//   The recording captures everything: all voices, drone, reverb, the
//   full mixed and compressed master bus. Human notes included.

(function() {

  var _recorder = null;
  var _chunks = [];
  var _startTime = 0;
  var _timerInterval = null;
  var _isRecording = false;

  window._toggleRecording = function() {
    if (_isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  function startRecording() {
    if (_isRecording) return;
    if (typeof SoundEngine === 'undefined' || !SoundEngine.getRecordingStream) {
      console.warn('Recording: SoundEngine.getRecordingStream not available');
      return;
    }

    var dest = SoundEngine.getRecordingStream();
    if (!dest || !dest.stream) {
      console.warn('Recording: could not get MediaStreamDestination');
      return;
    }

    // Determine best supported format
    var mimeType = 'audio/webm;codecs=opus';
    if (typeof MediaRecorder !== 'undefined') {
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/ogg;codecs=opus';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = ''; // let browser pick
          }
        }
      }
    }

    try {
      var opts = mimeType ? { mimeType: mimeType } : {};
      _recorder = new MediaRecorder(dest.stream, opts);
    } catch(e) {
      console.error('Recording: MediaRecorder init failed:', e.message);
      return;
    }

    _chunks = [];
    _recorder.ondataavailable = function(e) {
      if (e.data && e.data.size > 0) _chunks.push(e.data);
    };

    _recorder.onstop = function() {
      var ext = 'webm';
      if (_recorder.mimeType && _recorder.mimeType.indexOf('ogg') !== -1) ext = 'ogg';
      var blob = new Blob(_chunks, { type: _recorder.mimeType || 'audio/webm' });
      _chunks = [];

      // Generate timestamped filename
      var now = new Date();
      var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
      var ts = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate()) +
               '_' + pad(now.getHours()) + '-' + pad(now.getMinutes());
      var filename = 'PAI_session_' + ts + '.' + ext;

      // Create download link
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);

      console.log('Recording saved: ' + filename + ' (' + (blob.size / 1024).toFixed(1) + ' KB)');
    };

    _recorder.start(1000); // collect chunks every second
    _isRecording = true;
    _startTime = Date.now();

    // Update REC button
    var recBtn = document.getElementById('bRec');
    if (recBtn) {
      recBtn.classList.add('recording');
      recBtn.innerHTML = '<span class="mx-rec-dot"></span><span class="mx-rec-time" id="recTime">0:00</span>';
    }

    // Timer display
    _timerInterval = setInterval(function() {
      var elapsed = Math.floor((Date.now() - _startTime) / 1000);
      var min = Math.floor(elapsed / 60);
      var sec = elapsed % 60;
      var timeStr = min + ':' + (sec < 10 ? '0' : '') + sec;
      var el = document.getElementById('recTime');
      if (el) el.textContent = timeStr;
    }, 500);

    console.log('Recording started');
  }

  function stopRecording() {
    if (!_isRecording || !_recorder) return;

    try { _recorder.stop(); } catch(e) {}
    _isRecording = false;

    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }

    // Reset REC button
    var recBtn = document.getElementById('bRec');
    if (recBtn) {
      recBtn.classList.remove('recording');
      recBtn.innerHTML = '<span class="mx-rec-dot"></span>REC';
    }

    console.log('Recording stopped');
  }

  // Expose for external use (resetAll, etc.)
  window._isRecording = function() { return _isRecording; };
  window._stopRecording = function() { stopRecording(); };

})();

// ══════════════════════════════════════════════════════════
// MIXER SUBPAGE — full-page overlay (same pattern as instruments)
// ══════════════════════════════════════════════════════════
(function() {
  // Voice colors match timbral-space.js COLORS (3D spectral visualization)
  var VOICES = [
    { id: 'human',      label: 'YOU',    volId: 'humanVol',    color: '#c8c8ff' },
    { id: 'bass',       label: 'BASS',   volId: 'bassVol',     color: '#6565ee' },
    { id: 'rhythm',     label: 'RHYTHM', volId: 'rhythmVol',   color: '#cc8845' },
    { id: 'soloist',    label: 'SOLO',   volId: 'soloistVol',  color: '#45ccab' },
    { id: 'lead',       label: 'LEAD',   volId: 'leadVol',     color: '#cc6688' },
    { id: 'percussion', label: 'PERC',   volId: 'percVol',     color: '#ddaa66' }
  ];

  var page = document.createElement('div');
  page.id = 'mixerSubpage';
  page.className = 'mixer-subpage';
  page.style.display = 'none';

  // Header
  var html = '<div class="mixer-sp-header">' +
    '<button class="mixer-sp-back" id="mixerSpBack">\u25c0 BACK</button>' +
    '<span class="mixer-sp-title">MIXER</span>' +
    '<span class="mixer-sp-spacer"></span>' +
    '</div>';

  // Content area
  html += '<div class="mixer-sp-content">';

  // Master section
  html += '<div class="mixer-sp-section">';
  html += '<div class="mixer-sp-section-hdr">MASTER OUTPUT</div>';
  html += '<div class="mixer-sp-row mixer-sp-master">' +
    '<span class="mixer-sp-lbl" style="color:#33ff33;">MASTER</span>' +
    '<input type="range" class="mixer-sp-slider" id="mspMasterVol" min="0" max="100" value="80">' +
    '<span class="mixer-sp-val" id="mspMasterVal">80</span>' +
    '</div>';
  html += '</div>';

  // FX section
  html += '<div class="mixer-sp-section">';
  html += '<div class="mixer-sp-section-hdr">FX SEND</div>';
  html += '<div class="mixer-sp-row">' +
    '<span class="mixer-sp-lbl">REVERB</span>' +
    '<input type="range" class="mixer-sp-slider" id="mspReverb" min="0" max="100" value="30">' +
    '<span class="mixer-sp-val" id="mspReverbVal">30</span>' +
    '</div>';
  html += '<div class="mixer-sp-row">' +
    '<span class="mixer-sp-lbl">SUSTAIN</span>' +
    '<input type="range" class="mixer-sp-slider" id="mspSustain" min="0" max="100" value="50">' +
    '<span class="mixer-sp-val" id="mspSustainVal">50</span>' +
    '</div>';
  html += '</div>';

  // Per-voice channels
  html += '<div class="mixer-sp-section">';
  html += '<div class="mixer-sp-section-hdr">CHANNELS</div>';
  for (var i = 0; i < VOICES.length; i++) {
    var v = VOICES[i];
    html += '<div class="mixer-sp-row">' +
      '<span class="mixer-sp-lbl" style="color:' + v.color + ';">' + v.label + '</span>' +
      '<input type="range" class="mixer-sp-slider" id="msp_' + v.id + '" min="0" max="100" value="50"' +
      ' data-voice="' + v.id + '" data-src="' + v.volId + '">' +
      '<span class="mixer-sp-val" id="msp_' + v.id + 'Val">50</span>' +
      '</div>';
  }
  html += '</div>';

  html += '</div>'; // end content

  page.innerHTML = html;
  document.body.appendChild(page);

  // ── Back button ──
  document.getElementById('mixerSpBack').onclick = function(e) {
    e.stopPropagation();
    page.style.display = 'none';
  };

  // ── Sync values from real mixer sliders ──
  function syncFromReal() {
    var masterEl = document.getElementById('masterVol');
    var mspMaster = document.getElementById('mspMasterVol');
    if (masterEl && mspMaster) { mspMaster.value = masterEl.value; document.getElementById('mspMasterVal').textContent = masterEl.value; }

    var revEl = document.getElementById('reverbSlider');
    var mspRev = document.getElementById('mspReverb');
    if (revEl && mspRev) { mspRev.value = revEl.value; document.getElementById('mspReverbVal').textContent = revEl.value; }

    var susEl = document.getElementById('sustainSlider');
    var mspSus = document.getElementById('mspSustain');
    if (susEl && mspSus) { mspSus.value = susEl.value; document.getElementById('mspSustainVal').textContent = susEl.value; }

    for (var i = 0; i < VOICES.length; i++) {
      var v = VOICES[i];
      var srcEl = document.getElementById(v.volId);
      var mspEl = document.getElementById('msp_' + v.id);
      if (srcEl && mspEl) { mspEl.value = srcEl.value; document.getElementById('msp_' + v.id + 'Val').textContent = srcEl.value; }
    }
  }

  // ── Wire slider events ──
  function wireSlider(mspId, valId, srcId, engineFn) {
    var el = document.getElementById(mspId);
    if (!el) return;
    el.addEventListener('input', function() {
      var val = +this.value;
      document.getElementById(valId).textContent = val;
      var src = document.getElementById(srcId);
      if (src) { src.value = val; if (src.style) src.style.setProperty('--p', val + '%'); }
      if (typeof SoundEngine !== 'undefined' && engineFn) engineFn(val);
    });
  }

  wireSlider('mspMasterVol', 'mspMasterVal', 'masterVol', function(v) { SoundEngine.setMasterVolume(v / 100); });
  wireSlider('mspReverb', 'mspReverbVal', 'reverbSlider', function(v) { SoundEngine.setReverb(v / 100); });
  wireSlider('mspSustain', 'mspSustainVal', 'sustainSlider', function(v) { SoundEngine.setSustain(v / 100); });

  // Per-voice sliders
  var voiceSliders = page.querySelectorAll('[data-voice]');
  for (var si = 0; si < voiceSliders.length; si++) {
    voiceSliders[si].addEventListener('input', function() {
      var val = +this.value;
      var voice = this.getAttribute('data-voice');
      var srcId = this.getAttribute('data-src');
      document.getElementById('msp_' + voice + 'Val').textContent = val;
      var src = document.getElementById(srcId);
      if (src) { src.value = val; src.style.setProperty('--p', val + '%'); }
      if (typeof SoundEngine !== 'undefined') SoundEngine.setVoiceGain(voice, val / 100);
    });
  }

  // ── Public API ──
  window.openMixerSubpage = function() {
    syncFromReal();
    page.style.display = 'flex';
  };
})();

})();

