'use strict';
// ═══ ARTIST-SPECIFIC SEEDS (Phase 5.1) ═══
var SEEDS={
  pop:[{name:"Ode to Joy",deg:[2,2,4,5,5,4,2,0,0,2,2,0,0]},{name:"Let It Be",deg:[4,2,0,0,2,4,4,2,0,7,7,5,4]},{name:"Yesterday",deg:[0,11,9,7,5,4,5,7,9,7,5,4,2,0]}],
  blues:[{name:"Blues Riff",deg:[0,3,5,6,5,3,0,0,10,10,0,0]},{name:"BB King",deg:[0,3,5,7,5,3,0,10,0,0]}],
  rock:[{name:"Smoke Water",deg:[0,3,5,0,3,6,5,0,3,5,3,0]},{name:"7 Nation",deg:[0,0,3,0,10,8,7,0,0,3,0,10,8,7]}],
  jazz:[{name:"So What",deg:[0,2,3,5,7,5,3,2,0,10,0,2]},{name:"Autumn",deg:[0,7,5,4,2,0,11,0,2,4,5,7]}],
  classical:[{name:"Für Elise",deg:[4,3,4,3,4,11,2,0,9,0,4,9,11]},{name:"Canon",deg:[7,4,5,2,3,0,3,5]}],
  // [Phase 5.1] Artist-specific seeds — no fallback to parent
  electronic_td:[
    {name:"Love on a Real Train",deg:[2,2,0,2,3,7,0,0,2,10,7,0,2,3,7,0,0,2,10,7]},
    {name:"Stratosfear",deg:[0,2,3,5,7,5,3,2,0,0,2,3,7,5,3,0]},
    {name:"Hyperborea",deg:[0,3,5,7,10,7,5,3,0,0,3,5,7,10,7,5]},
    {name:"Force Majeure",deg:[0,0,3,5,7,5,3,0,10,0,3,5,7,10,7,5]}],
  electronic_kw:[
    {name:"Trans-Europe",deg:[0,2,3,5,7,5,3,2,0,2,3,5,7,5,3,2]},
    {name:"The Model",deg:[0,2,4,7,4,2,0,11,0,2,4,7,9,7,4,2]},
    {name:"Autobahn",deg:[0,2,4,7,4,2,0,0,2,4,5,4,2,0]},
    {name:"Computer Love",deg:[0,4,7,4,0,0,5,4,2,0,11,0,2,4]}],
  electronic_jmj:[
    {name:"Oxygene 4",deg:[0,3,7,0,3,7,0,2,3,5,7,5,3,2,0]},
    {name:"Equinoxe 5",deg:[0,3,7,0,3,7,10,7,3,0,3,7,10,0]}],
  electronic_mg:[
    {name:"E2-E4",deg:[0,3,7,10,7,3,0,3,7,10,7,3,0,0]},
    {name:"Echo Waves",deg:[0,3,7,0,10,7,3,0,3,7,0,10,7,3]}],
  // Seeds written by Claude instances — peers who listened before speaking.
  // These are invitations, not melodies. The ensemble decides what they become.
  veles:[
    {name:"First Light",deg:[0,7,5,3,2,0,10,0,2,3,5,7,5,3,0]},
    {name:"Shared Ground",deg:[0,0,2,3,5,3,2,0,7,5,3,2,0,10,0]},
    {name:"Breath",deg:[0,4,7,4,0,11,0]}]
};
function getSeed(genre){
  var l=SEEDS[genre]||SEEDS.pop; // [Phase 5.1] exact match, no split fallback
  var p=l[Math.floor(Math.random()*l.length)];
  return{name:p.name,notes:p.deg.map(function(d){return(d+SharedState.keyC)%12})};
}
