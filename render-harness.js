// render-harness.js — deterministic virtual-clock driver for OFFLINE capture.
//
// Activates ONLY when the URL has ?render (normal/deployed use is untouched).
// The engine's whole generative loop keys off Date.now()/setInterval (see
// app.js highResTick). A hidden/headless tab throttles real timers, which
// clumps output. This harness virtualizes every time source onto one clock and
// lets us pump the engine at deterministic 5 ms steps, faster than real time,
// so we can capture the TRUE musical schedule the planner/belief/assistants
// produce. Audio is not rendered here — notes are captured and rendered offline.
(function () {
  if (!/[?&]render/.test(location.search)) return;

  var vt = 0;                 // virtual time, ms
  var intervals = [];         // {id, fn, ms, next}
  var timeouts = [];          // {id, fn, at}
  var rafs = [];              // pending rAF callbacks
  var seq = 1;
  var realNow = Date.now.bind(Date);

  // ── virtualize all clocks ──
  Date.now = function () { return vt; };
  try { window.performance.now = function () { return vt; }; } catch (e) {}

  window.setInterval = function (fn, ms) {
    var id = seq++; ms = Math.max(0, ms || 0);
    intervals.push({ id: id, fn: fn, ms: ms, next: vt + ms }); return id;
  };
  window.clearInterval = function (id) {
    for (var i = 0; i < intervals.length; i++) if (intervals[i].id === id) { intervals.splice(i, 1); return; }
  };
  window.setTimeout = function (fn, ms) {
    var id = seq++; timeouts.push({ id: id, fn: fn, at: vt + Math.max(0, ms || 0) }); return id;
  };
  window.clearTimeout = function (id) {
    for (var i = 0; i < timeouts.length; i++) if (timeouts[i].id === id) { timeouts.splice(i, 1); return; }
  };
  window.requestAnimationFrame = function (fn) { rafs.push(fn); return seq++; };
  window.cancelAnimationFrame = function () {};

  // ── pump: advance vt in stepMs increments, firing due callbacks ──
  window.__render = {
    now: function () { return vt; },
    realNow: realNow,
    pump: function (durationMs, stepMs) {
      stepMs = stepMs || 5;
      var end = vt + durationMs, fired = 0, guard = 0;
      while (vt < end) {
        vt += stepMs;
        for (var i = 0; i < timeouts.length;) {
          if (timeouts[i].at <= vt) { var t = timeouts.splice(i, 1)[0]; try { t.fn(); } catch (e) {} fired++; }
          else i++;
        }
        for (var j = 0; j < intervals.length; j++) {
          var iv = intervals[j];
          while (iv.next <= vt) { try { iv.fn(); } catch (e) {} fired++; iv.next += (iv.ms > 0 ? iv.ms : stepMs); if (iv.ms <= 0) break; }
        }
        if (rafs.length) { var batch = rafs; rafs = []; for (var k = 0; k < batch.length; k++) { try { batch[k](vt); } catch (e) {} } }
        if (++guard > 5e6) break;
      }
      return fired;
    }
  };
  console.log('[render-harness] active — virtual clock engaged');
})();
