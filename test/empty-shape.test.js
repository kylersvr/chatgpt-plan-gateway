import test from 'node:test';
import assert from 'node:assert/strict';
import { respond } from '../src/proxy.js';

test('blank terminal fails with shape counts only; does not accept deltas or retry', async () => {
  const secretText = 'SYNTHETIC-TEXT-MUST-NOT-LEAK';
  const evs = [
    { type:'response.output_text.delta', delta:secretText },
    { type:'response.output_text.done', text:secretText },
    { type:'response.output_item.done', item:{content:[{type:'output_text',text:secretText}]} },
    { type:'response.completed', response:{id:'r-test',model:'gpt-6.1-sol',status:'completed',output:[]} }
  ];
  let calls = 0;
  const ctx = { cfg:{idleTimeoutMs:1000,apiBase:'https://example.invalid',tierOrder:['sol','astra']},
    tokens:{getAccessToken:async()=> 'fake-not-real'},
    picker:{current:()=> 'gpt-6.1-sol',top:()=> 'gpt-6-astra'},
    fetchFn:async()=> { calls++; return new Response(evs.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''), {status:200}); } };
  await assert.rejects(respond(ctx,{input:'synthetic',reasoning:{effort:'medium'}}), e => {
    assert.equal(e.code,'upstream_empty_text');
    assert.match(e.message, /"oi":0/);
    assert.match(e.message, new RegExp('"d":'+secretText.length));
    assert.equal(e.message.includes(secretText),false);
    return true;
  });
  assert.equal(calls,1);
});
