import test from "node:test";
import assert from "node:assert/strict";
import LirikSync, { parseLrc, toLRC, toEnhancedLRC, SOURCES } from "../lib/lyrics/lirik.js";

test("7 source providers are registered", () => {
  assert.equal(Object.keys(SOURCES).length,7);
  assert.ok(new LirikSync({sources:["lrclib"]}).listSources().some(s=>s.id==="lrclib"));
});
test("line LRC yields timestamped normalized lines", () => {
  const data=parseLrc("[ti:Demo]\n[00:01.00]Hello world\n[00:02.50]Goodbye");
  assert.equal(data.lines.length,2);
  assert.equal(data.lines[0].time,1);
  assert.equal(data.lines[0].endTime,2.5);
  assert.equal(data.lines[0].text,"Hello world");
});
test("word-level source converts to Enhanced LRC", () => {
  const result={track:{title:"Demo",artist:"Tester"},synced:true,plain:null,
    lines:[{time:1,endTime:3,text:"Hello world",words:[
      {text:"Hello",start:1,end:2},{text:"world",start:2,end:3}
    ]}]};
  assert.match(toLRC(result),/\[00:01\.00\]Hello world/);
  assert.match(toEnhancedLRC(result),/<00:01\.00>Hello <00:02\.00>world/);
});
