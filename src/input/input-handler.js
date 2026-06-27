'use strict';
// ═══ KEYBOARD INPUT (Phase 7: MIDI sustain) ═══
//
// Key held = note sustains. Key released = note releases.
// Tab = sustain pedal (notes ring until pedal lifted).
//
// Human notes now go through SoundEngine.noteOn/noteOff with voiceName='human'.
// This gives them: managed ADSR, channel strip, instrument routing, sustain.
// They still bypass VoiceManager (invariant 49) — polyphony is unlimited for human.
//
// The old fire-and-forget playNote path is removed for keyboard notes.
// Click/touch notes on the Tonnetz grid still use playNote (no keyUp event).
//
// Exposes:
//   KeyboardInput.getOctave()
//   KeyboardInput.getHeldNotes()     — { key: { midi, noteId } }
//   KeyboardInput.isSustainDown()    — is Tab held?

var KeyboardInput = (function() {
  var octave = 4;
  var keysDown = new Set();

  // Track active notes for noteOff on keyUp
  // heldNotes[keyString] = { midi: int, noteId: int }
  var heldNotes = {};

  // Sustain pedal: when down, keyUp doesn't release notes.
  // When pedal lifts, all pedaled notes release at once.
  var sustainDown = false;
  var pedaledNotes = [];  // [{key, midi, noteId}] — notes held by pedal after keyUp

  var WHITE_MAP = {a:0,s:2,d:4,f:5,g:7,h:9,j:11,k:12,l:14,';':16,"'":17};
  var BLACK_MAP = {w:1,e:3,t:6,y:8,u:10,o:13,p:15};

  function keyToMidi(key) {
    var k = key.toLowerCase(), semitone = null;
    if (WHITE_MAP[k] !== undefined) semitone = WHITE_MAP[k];
    else if (BLACK_MAP[k] !== undefined) semitone = BLACK_MAP[k];
    if (semitone === null) return null;
    return (octave * 12) + semitone;
  }

  function onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    var k = e.key.toLowerCase();

    if (k === 'z') { octave = Math.max(2, octave - 1); e.preventDefault(); return; }
    if (k === 'x') { octave = Math.min(7, octave + 1); e.preventDefault(); return; }
    // Backtick / Backquote: toggle 3D timbral space visualization
    if (k === '`' || e.code === 'Backquote') {
      e.preventDefault();
      if (typeof TimbralSpace !== 'undefined') {
        console.log('TimbralSpace toggle (key: ' + k + ', code: ' + e.code + ')');
        TimbralSpace.toggle();
      } else {
        console.warn('TimbralSpace not loaded');
      }
      return;
    }
    // B: toggle raw data dump overlay (D is a MIDI note key)
    if (k === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (typeof RawDump !== 'undefined') {
        RawDump.toggle();
      }
      return;
    }
    // N: toggle timbral box wireframe/grid
    if (k === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (typeof TimbralSpace !== 'undefined' && TimbralSpace.toggleGrid) {
        TimbralSpace.toggleGrid();
      }
      return;
    }
    if (e.code === 'Space' || k === ' ') {
      e.preventDefault();
      sustainDown = true;
      SoundEngine.setSustainPedal(true);
      return;
    }
    if (keysDown.has(k)) return;
    keysDown.add(k);

    var midi = keyToMidi(k);
    if (midi === null) return;
    e.preventDefault();

    var pc = ((midi % 12) + 12) % 12;
    var register = midi < 48 ? 'bass' : midi < 72 ? 'rhythm' : 'soloist';

    // Fire noteOn and track for keyUp release
    if (window.onNoteInput) {
      var noteId = window.onNoteInput(pc, midi, register);
      if (noteId !== undefined && noteId !== null) {
        heldNotes[k] = { midi: midi, noteId: noteId };
      }
    }
  }

  function onKeyUp(e) {
    var k = e.key.toLowerCase();

    if (e.code === 'Space' || k === ' ') {
      sustainDown = false;
      SoundEngine.setSustainPedal(false);
      // Release all pedaled notes
      for (var i = 0; i < pedaledNotes.length; i++) {
        var pn = pedaledNotes[i];
        try { SoundEngine.noteOff('human', pn.noteId); } catch(ex) {}
      }
      pedaledNotes = [];
      return;
    }

    keysDown.delete(k);

    // Release the note on keyUp
    var held = heldNotes[k];
    if (held) {
      if (sustainDown) {
        // Pedal is down — don't release, queue for pedal-up
        pedaledNotes.push({ key: k, midi: held.midi, noteId: held.noteId });
      } else {
        // Release immediately
        try { SoundEngine.noteOff('human', held.noteId); } catch(ex) {}
      }
      delete heldNotes[k];
    }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ═══ WEB MIDI API (hardware MIDI keyboard support) ═══
  //
  // Connects to any USB/Bluetooth MIDI controller.
  // NoteOn/NoteOff messages routed through the same onNoteInput pipeline.
  // Velocity mapped to volume. Sustain pedal (CC64) supported.
  var midiAccess = null;
  var midiHeldNotes = {}; // midi number → noteId

  function initMIDI() {
    if (!navigator.requestMIDIAccess) {
      console.log('Web MIDI not supported in this browser');
      return;
    }
    navigator.requestMIDIAccess({ sysex: false }).then(function(access) {
      midiAccess = access;
      console.log('MIDI access granted — ' + access.inputs.size + ' input(s)');
      access.inputs.forEach(function(input) {
        console.log('MIDI input: ' + input.name);
        input.onmidimessage = onMIDIMessage;
      });
      // Handle hot-plugged devices
      access.onstatechange = function(e) {
        if (e.port.type === 'input' && e.port.state === 'connected') {
          console.log('MIDI connected: ' + e.port.name);
          e.port.onmidimessage = onMIDIMessage;
        }
      };
    }, function(err) {
      console.log('MIDI access denied:', err);
    });
  }

  function onMIDIMessage(e) {
    var data = e.data;
    if (!data || data.length < 2) return;

    // Capture raw MIDI bytes for RawDump visualizer (before any parsing)
    if (window.RawDump) window.RawDump._captureMidi(data);

    var status = data[0] & 0xF0;
    var midi = data[1];
    var velocity = data.length > 2 ? data[2] : 0;

    if (status === 0x90 && velocity > 0) {
      // Note On
      var pc = ((midi % 12) + 12) % 12;
      var register = midi < 48 ? 'bass' : midi < 72 ? 'rhythm' : 'soloist';
      var volMult = velocity / 127;

      if (window.onNoteInput) {
        var noteId = window.onNoteInput(pc, midi, register, volMult);
        if (noteId !== undefined && noteId !== null) {
          midiHeldNotes[midi] = noteId;
        }
      }
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      // Note Off
      var noteId = midiHeldNotes[midi];
      if (noteId) {
        if (sustainDown) {
          pedaledNotes.push({ key: 'midi_' + midi, midi: midi, noteId: noteId });
        } else {
          try { SoundEngine.noteOff('human', noteId); } catch(ex) {}
        }
        delete midiHeldNotes[midi];
      }
    } else if (status === 0xB0 && midi === 64) {
      // CC64 — Sustain Pedal
      if (velocity >= 64) {
        sustainDown = true;
        SoundEngine.setSustainPedal(true);
      } else {
        sustainDown = false;
        SoundEngine.setSustainPedal(false);
        for (var i = 0; i < pedaledNotes.length; i++) {
          try { SoundEngine.noteOff('human', pedaledNotes[i].noteId); } catch(ex) {}
        }
        pedaledNotes = [];
      }
    }
  }

  // Auto-connect on load
  initMIDI();

  return {
    getOctave: function() { return octave; },
    getHeldNotes: function() { return heldNotes; },
    isSustainDown: function() { return sustainDown; }
  };
})();
