import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExplicitModelConstraint,
  DynamicModelRouter
} from '../packages/core/src/routing/dynamic-model-router.mjs';

test('exact model sentence punctuation is never part of model identity',()=>{
  const cases=[
    ['Use exactly the Ollama model minimax-m3:cloud.','minimax-m3:cloud'],
    ['Use exactly the Ollama model qwen3.1:8b,','qwen3.1:8b'],
    ['Use exactly the Ollama model qwen3.1:8b;','qwen3.1:8b'],
    ['Use exactly the Ollama model qwen3.1:8b!','qwen3.1:8b'],
    ['Use exactly the Ollama model qwen3.1:8b?','qwen3.1:8b'],
    ['model: provider/model.v2;','provider/model.v2']
  ];

  for(const [text,model] of cases){
    assert.deepEqual(
      parseExplicitModelConstraint(text),
      {exactModelId:model,fallbackAllowed:false,source:'user_text'},
      text
    );
  }
});

test('direct exact-model directives remain binding',()=>{
  assert.deepEqual(
    parseExplicitModelConstraint('Use exactly the Ollama model minimax-m3:cloud for this run'),
    {exactModelId:'minimax-m3:cloud',fallbackAllowed:false,source:'user_text'}
  );

  assert.deepEqual(
    parseExplicitModelConstraint('model: qwen3:8b'),
    {exactModelId:'qwen3:8b',fallbackAllowed:false,source:'user_text'}
  );

  assert.deepEqual(
    parseExplicitModelConstraint('exact model = provider/model-v2'),
    {exactModelId:'provider/model-v2',fallbackAllowed:false,source:'user_text'}
  );
});

test('pasted code and diagnostic prose do not become exact-model constraints',()=>{
  const diagnostic=[
    'MNEMOS LIVE ROUTING DIAGNOSTIC',
    "   15: const selected={chat:async()=>({content:'done',model:'cell-model'})};",
    "   16: const route={cellId:'cell-1',modelId:'chat-model'};",
    "   37: const x=resolver.resolve('Use exactly the Ollama model minimax-m3:cloud.');",
    "model:'cell',",
    'const object = { model: "cell" };',
    'Never silently substitute another model for an exact-model request.'
  ].join('\n');

  assert.equal(parseExplicitModelConstraint(diagnostic),null);
});

test('fenced examples never become live exact-model constraints',()=>{
  const prompt=[
    'Inspect this example only:',
    '```text',
    'model: qwen3:8b',
    'Use exactly the Ollama model minimax-m3:cloud.',
    '```',
    'Report what the example means.'
  ].join('\n');

  assert.equal(parseExplicitModelConstraint(prompt),null);
});

test('self-qualification wording mentioning exact models does not invent one',()=>{
  const prompt=[
    'Prove that this installation can preserve exact-model requests.',
    'Run small verified requests using at least qwen3:8b locally, if available.',
    'Never silently substitute another model for an exact-model request.',
    'Report requested provider/model and actual provider/model.'
  ].join('\n');

  assert.equal(parseExplicitModelConstraint(prompt),null);
});

test('router selects normal candidate when diagnostics contain model source text',()=>{
  const models=[{
    providerProfileId:'ollama-local',
    accountProfileId:null,
    modelId:'qwen3:8b',
    executionLocality:'LOCAL',
    roles:['chat','planning','coding','research'],
    capabilities:{chat:true},
    availability:'AVAILABLE',
    cost:{class:'local_compute'},
    empirical:{qualityMean:0.8,reliability:1,latencyMs:1000}
  }];

  const router=new DynamicModelRouter({providerFleet:{models:()=>models}});
  const result=router.route({
    message:"diagnostic\n   15: const x={model:'cell'};\nplease inspect this",
    role:'planning'
  });

  assert.equal(result.exactModelId,null);
  assert.equal(result.status,'ROUTED');
  assert.equal(result.selected.modelId,'qwen3:8b');
});
