import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamicModelRouter} from '../packages/core/src/routing/dynamic-model-router.mjs';
import {ProviderRuntimeHealthRegistry} from '../packages/core/src/execution/provider-runtime-health-registry.mjs';

const model=(providerProfileId,modelId,quality)=>({providerProfileId,providerId:providerProfileId,modelId,roles:['chat'],availability:'AVAILABLE',executionLocality:'CLOUD',capabilities:{chat:true},cost:{class:'provider_quota'},empirical:{samples:10,reliability:quality,qualityMean:quality,latencyMs:1000},confidence:.9});

function fleetFor(models,backends={}){return{models:()=>models,backendFor:async selected=>backends[selected.providerProfileId]??backends[selected.modelId]};}

test('dynamic model routing excludes runtime-blocked API provider profiles',async()=>{
 const health=new ProviderRuntimeHealthRegistry();await health.recordFailure({providerId:'provider-a'},{failureClass:'quota_exhausted'});
 const router=new DynamicModelRouter({providerFleet:fleetFor([model('provider-a','a1',.99),model('provider-b','b1',.8)]),providerHealthRegistry:health});
 const decision=router.route({message:'hello'});
 assert.equal(decision.status,'ROUTED');assert.equal(decision.selected.providerProfileId,'provider-b');assert.ok(!decision.candidates.some(item=>String(item.candidateId).startsWith('provider-a:')));
});

test('exact model reports provider runtime block instead of generic model unavailable',async()=>{
 const health=new ProviderRuntimeHealthRegistry();await health.recordFailure({providerId:'provider-a'},{failureClass:'authentication_required'});
 const router=new DynamicModelRouter({providerFleet:fleetFor([model('provider-a','a1',.99)]),providerHealthRegistry:health});
 const decision=router.route({message:'hello',exactModelId:'a1',fallbackAllowed:false});
 assert.equal(decision.status,'PROVIDER_RUNTIME_BLOCKED');assert.equal(decision.runtimeHealth.health.failureClass,'authentication_required');
});

test('provider-wide API failure updates runtime health and blocks the next route',async()=>{
 const health=new ProviderRuntimeHealthRegistry();const error=Object.assign(new Error('429 quota exhausted'),{status:429});
 const router=new DynamicModelRouter({providerFleet:fleetFor([model('provider-a','a1',.99)],{'provider-a':{chat:async()=>{throw error;}}}),providerHealthRegistry:health});
 await assert.rejects(()=>router.execute({messages:[{role:'user',content:'hello'}]}),/quota exhausted/);
 const state=health.get({providerId:'provider-a'});assert.equal(state.state,'BLOCKED');assert.equal(state.failureClass,'quota_exhausted');assert.equal(router.route({message:'hello'}).status,'NO_CANDIDATE');
});

test('model-specific failure does not quarantine the whole provider profile',async()=>{
 const health=new ProviderRuntimeHealthRegistry();const error=Object.assign(new Error('model a1 not found'),{status:404});
 const router=new DynamicModelRouter({providerFleet:fleetFor([model('provider-a','a1',.99)],{'provider-a':{chat:async()=>{throw error;}}}),providerHealthRegistry:health});
 await assert.rejects(()=>router.execute({messages:[{role:'user',content:'hello'}]}),/model a1 not found/);
 const route=health.canRoute({providerId:'provider-a'});assert.equal(route.allowed,true);assert.equal(route.health.state,'UNKNOWN');
});
