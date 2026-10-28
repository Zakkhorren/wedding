import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTurnstile} from '../worker/turnstile-verifier.mjs';
const config={token:'test-token',secret:'TEST_ONLY_NOT_A_REAL_SECRET',hostname:'zakkhorren.github.io',verificationId:'12345678-1234-1234-1234-123456789012'};
test('Turnstile sends secret only to Siteverify, checks hostname/action and stable verification ID', async()=>{
  let seen;
  const ok=await verifyTurnstile({...config,fetcher:async(url,options)=>{seen={url,options};return Response.json({success:true,hostname:config.hostname,action:'rsvp'})}});
  assert.equal(ok,true);assert.equal(seen.url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert.equal(seen.options.body.get('idempotency_key'),config.verificationId);assert.equal(seen.options.body.get('secret'),config.secret);
});
test('Expired/duplicate, incorrect hostname/action, and missing tokens fail closed', async()=>{
  for(const result of [{success:false,'error-codes':['timeout-or-duplicate']},{success:true,hostname:'evil.test',action:'rsvp'},{success:true,hostname:config.hostname,action:'login'}])await assert.rejects(verifyTurnstile({...config,fetcher:async()=>Response.json(result)}),{code:'TURNSTILE_RETRY'});
  await assert.rejects(verifyTurnstile({...config,token:''}),{code:'TURNSTILE_RETRY'});
});
test('Network/HTTP/JSON failure cannot authorize a write or expose secret in error',async()=>{
  for(const fetcher of [async()=>{throw Error(config.secret)},async()=>new Response('',{status:503}),async()=>new Response('invalid')]){
    await assert.rejects(verifyTurnstile({...config,fetcher}),e=>e.code==='TURNSTILE_UNAVAILABLE'&&!e.message.includes(config.secret));
  }
});
