import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../src/core/http.js';
import {createService} from '../src/core/service.js';
import {openStore} from '../src/core/store.js';

process.env.APP_URL='http://localhost:3000';
process.env.ADMIN_PASSWORD='test-password-at-least-16';
const sample={name:'Alex Doe',email:'alex@example.com',role:'setup',availability:'Saturday morning'};
function fixture(t){
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const app=createService({store,deliver:async()=>({status:'accepted',providerId:'test-id'})});
  return (path,options={})=>handle(new Request(`http://localhost:3000${path}`,options),'test-client',()=>app);
}
const post=(headers={},body=JSON.stringify(sample))=>({method:'POST',headers:{'content-type':'application/json',...headers},body});
test('POST without Origin returns 403',async t=>{
  const response=await fixture(t)('/api/submit',post());
  assert.equal(response.status,403);
});
test('JSON POST with matching Origin returns success JSON',async t=>{
  const response=await fixture(t)('/api/submit',post({origin:process.env.APP_URL,accept:'application/json'}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/application\/json/);
  assert.equal((await response.json()).ok,true);
});
test('body over 16000 bytes returns 413',async t=>{
  const response=await fixture(t)('/api/submit',post({origin:process.env.APP_URL},'x'.repeat(16001)));
  assert.equal(response.status,413);
});
test('text/plain returns 415',async t=>{
  const response=await fixture(t)('/api/submit',post({origin:process.env.APP_URL,'content-type':'text/plain'},'hello'));
  assert.equal(response.status,415);
});
test('GET admin without auth returns the same 401 challenge for HTML and JSON',async t=>{
  const request=fixture(t);
  for(const accept of ['text/html','application/json']){
    const response=await request('/admin',{headers:{accept}});
    assert.equal(response.status,401);
    assert.equal(response.headers.get('www-authenticate'),'Basic realm="Operator", charset="UTF-8"');
  }
});
test('GET health returns 200',async t=>{
  const response=await fixture(t)('/health');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true});
});
