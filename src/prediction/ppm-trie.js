'use strict';
// ═══ PPM* TRIE (base class — copied from v2, memory-optimized) ═══
function TrieNode(){this.children={};this.counts={};this.total=0;}
function PPMTrie(maxDepth){this.root=new TrieNode();this.maxDepth=maxDepth||4;this.context=[];this._predBuf=null;this._exclBuf=null;this._lastAlpha=0;}
PPMTrie.prototype.observe=function(symbol){
  for(var d=0;d<=Math.min(this.context.length,this.maxDepth);d++){
    var node=this.root,start=this.context.length-d;
    for(var i=start;i<this.context.length;i++){var s=this.context[i];if(!node.children[s])node.children[s]=new TrieNode();node=node.children[s];}
    node.counts[symbol]=(node.counts[symbol]||0)+1;node.total++;}
  this.context.push(symbol);if(this.context.length>this.maxDepth+2)this.context.shift();
};
// predict() reuses per-instance Float64Array and Uint8Array scratch buffers
// to avoid allocating on every call (hot path: ~30 calls/note across all voices).
PPMTrie.prototype.predict=function(alphabetSize){
  // Lazily allocate or resize scratch buffers (only on first call or size change)
  if(this._lastAlpha!==alphabetSize){this._predBuf=new Float64Array(alphabetSize);this._exclBuf=new Uint8Array(alphabetSize);this._lastAlpha=alphabetSize;}
  var probs=this._predBuf,excl=this._exclBuf;
  // Zero out (reuse existing buffers)
  for(var zi=0;zi<alphabetSize;zi++){probs[zi]=0;excl[zi]=0;}
  var escape=1.0,exclCount=0;
  for(var d=Math.min(this.context.length,this.maxDepth);d>=0;d--){
    var node=this.root,start=this.context.length-d;
    for(var i=start;i<this.context.length;i++){var s=this.context[i];if(!node.children[s]){node=null;break;}node=node.children[s];}
    if(!node||node.total===0)continue;
    var seenCount=Object.keys(node.counts).length,escapeProb=seenCount/(node.total+seenCount),stayProb=1-escapeProb;
    for(var sym in node.counts){var s=parseInt(sym);if(!excl[s]){probs[s]+=escape*stayProb*(node.counts[sym]/node.total);excl[s]=1;exclCount++;}}
    escape*=escapeProb;}
  var unseenCount=alphabetSize-exclCount;
  if(unseenCount>0&&escape>0){var each=escape/unseenCount;for(var i=0;i<alphabetSize;i++)if(!excl[i])probs[i]+=each;}
  return probs;
};
PPMTrie.prototype.reset=function(){this.root=new TrieNode();this.context=[];};
PPMTrie.prototype.cloneContext=function(){var c=new PPMTrie(this.maxDepth);c.root=this.root;c.context=this.context.slice();return c;};
PPMTrie.prototype.loadFromJSON=function(data){
  function buildNode(d){var node=new TrieNode();node.total=d.t||0;
    if(d.c)for(var k in d.c)node.counts[parseInt(k)]=(node.counts[parseInt(k)]||0)+d.c[k];
    node.total=Object.values(node.counts).reduce(function(a,b){return a+b},0)||node.total;
    if(d.ch)for(var k in d.ch)node.children[parseInt(k)]=buildNode(d.ch[k]);
    return node;}
  this.root=buildNode(data);
};
