import test from 'node:test';
import assert from 'node:assert/strict';
import { respond } from '../src/proxy.js';

const SECRET = 'SYNTHETIC-CANARY-MUST-NOT-LEAK';
const run = async (evs, { eof = false } = {}) => {
  let calls = 0;
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  const ctx = { cfg:{idleTimeoutMs:1000,apiBase:'https://example.invalid',tierOrder:['sol','astra']},
    tokens:{getAccessToken:async()=> 'fake-not-real'},
    picker:{current:()=> 'gpt-6.1-sol',top:()=> 'gpt-6-astra'},
    fetchFn:async()=> { calls++; return new Response(evs.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''), {status:200}); } };
  let result, error;
  try { result = await respond(ctx,{input:'synthetic',reasoning:{effort:'high'}}); } catch (e) { error = e; }
  finally { Object.assign(console, orig); }
  return { result, error, calls, logs };
};

const delta = (oi, ci, id, d) => ({ type:'response.output_text.delta', output_index:oi, content_index:ci, item_id:id, delta:d });
const tdone = (oi, ci, id, t) => ({ type:'response.output_text.done', output_index:oi, content_index:ci, item_id:id, text:t });
const idone = (oi, id, texts, over = {}) => ({ type:'response.output_item.done', output_index:oi,
  item:{ type:'message', role:'assistant', status:'completed', id, content:texts.map(t=>({type:'output_text',text:t})), ...over } });
const done = (over = {}) => ({ type:'response.completed', response:{ id:'r-test', model:'gpt-6.1-sol', status:'completed', output:[], ...over } });

const TEXT = '  héllo 世界 🌍\n\n tail  ';
const valid = () => [delta(0,0,'m1','  héllo 世'), delta(0,0,'m1','界 🌍\n\n tail  '), tdone(0,0,'m1',TEXT), idone(0,'m1',[TEXT]), done()];

const assertRejected = (r) => {
  assert.equal(r.result, undefined);
  assert.equal(r.error.status, 502);
  assert.equal(r.error.code, 'upstream_empty_text');
  assert.equal(r.calls, 1);
  assert.equal(r.error.message.includes(SECRET), false);
  assert.equal(r.logs.join('\n').includes(SECRET), false);
  assert.equal(r.logs.join('\n').includes('fake-not-real'), false);
};

test('valid finalized stream items are accepted with exact whitespace and multibyte text', async () => {
  const r = await run(valid());
  assert.equal(r.error, undefined);
  assert.equal(r.calls, 1);
  assert.equal(r.result.status, 200);
  assert.equal(r.result.json.output_text, TEXT);
  assert.equal(r.result.json.gateway.response_text_source, 'finalized_stream_items');
  assert.equal(r.result.json.gateway.model, 'gpt-6.1-sol');
  assert.equal(r.result.json.gateway.effort_requested, 'high');
  assert.deepEqual(r.result.json.gateway.retries, []);
});

test('done without deltas is accepted; multiple items and parts are ordered by output_index/content_index', async () => {
  const r = await run([
    tdone(2,0,'m3','C'), idone(2,'m3',['C']),
    { type:'response.output_item.done', output_index:1, item:{ type:'reasoning', id:'rs1' } },
    tdone(0,1,'m1','B '), tdone(0,0,'m1','A '), idone(0,'m1',['A ','B ']),
    done()]);
  assert.equal(r.error, undefined);
  assert.equal(r.result.json.output_text, 'A B C');
  assert.equal(r.result.json.gateway.response_text_source, 'finalized_stream_items');
});

test('nonempty completed.output stays authoritative', async () => {
  const r = await run([...valid().slice(0,-1), done({ output:[{ type:'message', content:[{type:'output_text',text:'authoritative'}] }] })]);
  assert.equal(r.result.json.output_text, 'authoritative');
  assert.equal(r.result.json.gateway.response_text_source, 'completed_output');
});

test('text.done does not match finalized item text', async () => {
  assertRejected(await run([tdone(0,0,'m1',SECRET+'x'), idone(0,'m1',[SECRET]), done()]));
});

test('accumulated deltas do not match finalized text', async () => {
  assertRejected(await run([delta(0,0,'m1',SECRET+'!'), tdone(0,0,'m1',SECRET), idone(0,'m1',[SECRET]), done()]));
});

test('missing output_item.done', async () => {
  assertRejected(await run([delta(0,0,'m1',SECRET), tdone(0,0,'m1',SECRET), done()]));
});

test('missing output_text.done', async () => {
  assertRejected(await run([delta(0,0,'m1',SECRET), idone(0,'m1',[SECRET]), done()]));
});

test('finalized item with wrong status or role or missing id', async () => {
  for (const over of [{ status:'in_progress' }, { role:'user' }, { id:'' }]) {
    assertRejected(await run([delta(0,0,'m1',SECRET), tdone(0,0,'m1',SECRET), idone(0,'m1',[SECRET], over), done()]));
  }
});

test('raw deltas without valid metadata never become a fallback', async () => {
  assertRejected(await run([{ type:'response.output_text.delta', delta:SECRET }, { type:'response.output_text.done', text:SECRET }, idone(0,'m1',[SECRET]), done()]));
  assertRejected(await run([delta(-1,0,'m1',SECRET), tdone(0,0,'m1',SECRET), idone(0,'m1',[SECRET]), done()]));
  assertRejected(await run([tdone(0,0,'',SECRET), idone(0,'m1',[SECRET]), done()]));
});

test('EOF before completed or incomplete status is not accepted even with all finalized text', async () => {
  const eof = await run(valid().slice(0,-1));
  assert.equal(eof.result, undefined);
  assert.equal(eof.error.status, 502);
  assert.equal(eof.error.code, 'upstream_http_502');
  assert.equal(eof.calls, 1);
  const inc = await run([...valid().slice(0,-1), done({ status:'incomplete', incomplete_details:{ reason:'max_output_tokens' } })]);
  assert.equal(inc.error.code, 'upstream_incomplete');
  assert.equal(inc.calls, 1);
  const noStatus = await run([...valid().slice(0,-1), { type:'response.completed', response:{ id:'r', model:'m', output:[] } }]);
  assert.equal(noStatus.error.code, 'upstream_empty_text');
});

test('duplicate done: identical allowed, conflicting rejected', async () => {
  const ok = await run([tdone(0,0,'m1','same'), tdone(0,0,'m1','same'), idone(0,'m1',['same']), idone(0,'m1',['same']), done()]);
  assert.equal(ok.result.json.output_text, 'same');
  assertRejected(await run([tdone(0,0,'m1','same'), tdone(0,0,'m1',SECRET), idone(0,'m1',['same']), done()]));
  assertRejected(await run([tdone(0,0,'m1',SECRET), idone(0,'m1',[SECRET]), idone(0,'m1',[SECRET+'x']), done()]));
  assertRejected(await run([tdone(0,0,'m1',SECRET), tdone(0,0,'m2',SECRET), idone(0,'m1',[SECRET]), done()]));
  assertRejected(await run([tdone(0,0,'m1',SECRET), tdone(1,0,'m1',SECRET), idone(0,'m1',[SECRET]), idone(1,'m1',[SECRET]), done()]));
});

test('identity mismatch and orphan partial text', async () => {
  assertRejected(await run([tdone(0,0,'other',SECRET), idone(0,'m1',[SECRET]), done()]));
  assertRejected(await run([tdone(0,0,'m1',SECRET), tdone(1,0,'m9',SECRET), idone(0,'m1',[SECRET]), done()]));
  assertRejected(await run([tdone(0,0,'m1',SECRET), delta(0,1,'m1',SECRET), idone(0,'m1',[SECRET]), done()]));
  assertRejected(await run([delta(3,0,'m1',SECRET), tdone(0,0,'m1',SECRET), idone(0,'m1',[SECRET]), done()]));
});

test('blank finalized text is rejected', async () => {
  assertRejected(await run([tdone(0,0,'m1',' \n '), idone(0,'m1',[' \n ']), done()]));
});
