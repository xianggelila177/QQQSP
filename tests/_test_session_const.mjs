import assert from 'node:assert/strict';
import {extSessions} from '../lib/sessions.js';
import {SESSIONS} from '../mkt.mjs';
const [R0,R1]=SESSIONS.us.reg[0],mkT=min=>Date.UTC(2026,0,15,0,min)/1000;
const bars=[{t:mkT(R0-1),o:100,h:101,l:99,c:100.5,v:10},{t:mkT(R0),o:100.5,h:102,l:100,c:101,v:20},{t:mkT(R0+30),o:101,h:103,l:100.5,c:102,v:30},{t:mkT(R1-1),o:102,h:104,l:101.5,c:103,v:40},{t:mkT(R1),o:103,h:105,l:102.5,c:104,v:50}];
const out=extSessions(bars,{symbol:'QQQ',gmtoffset:0},99);
assert.equal(out.preOpen,100);assert.equal(out.reg.n,3);assert.equal(out.regClose,103);assert.equal(out.post.price,104);
console.log('PASS session segmentation follows canonical session boundaries');
