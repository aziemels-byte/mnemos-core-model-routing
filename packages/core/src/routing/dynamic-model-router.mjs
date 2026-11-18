import { CandidatePoolCurator } from './candidate-pool-curator.mjs';
import { CandidateBid } from './candidate-bid.mjs';
import { classifyProviderRuntimeFailure } from '../execution/provider-runtime-failure-classifier.mjs';

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const lower = value => String(value ?? '').toLowerCase();
const ROLE_ALIASES = Object.freeze({
  coding: Object.freeze(new Set(['coding','frontier-coding','long-horizon-coding','repo-wide-coding']))
});

export function specializedRoleCompatible(modelRoles = [], requestedRole = null) {
  if (!requestedRole) return true;
  const normalized = new Set((modelRoles ?? []).map(lower));
  const requested = lower(requestedRole);
  if (normalized.has(requested)) return true;
  return [...(ROLE_ALIASES[requested] ?? [])].some(role => normalized.has(role));
}

export function roleCompatible(modelRoles = [], requestedRole = null) {
  if (specializedRoleCompatible(modelRoles, requestedRole)) return true;
  return (modelRoles ?? []).map(lower).includes('chat');
}

export function isLocalResourceOom(error) {
  const text = `${error?.message ?? error ?? ''} ${error?.code ?? ''}`;
  return /out[- ]of[- ]memory|cudamalloc|cudamemgetinfo|std::bad_alloc|failed to allocate (?:cuda\d*|cpu|[^\s]* ?buffer)/i.test(text);
}

const knownModelSize = candidate => {
  const value = Number(candidate?.modelProfile?.hardware?.sizeBytes);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export function parseExplicitModelConstraint(message = '') {
  const text = String(message);
  const lines = text.split(/\r?\n/);

  const cleanModelId = value => String(value ?? '')
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/[.,;!?]+$/g, '');

  // Exact-model routing is a user constraint, not a source-code/log extractor.
  // Accept only directive-shaped lines outside fenced code blocks.
  const directivePatterns = [
    /^\s*use\s+exactly\s+(?:the\s+)?(?:ollama\s+)?model\s+[`"']?([A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255})[`"']?[.,;!?]?(?:\s+.*)?$/i,
    /^\s*(?:exact\s+)?(?:model|modeli)\s*(?::\s+|=\s*)[`"']?([A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255})[`"']?\s*[.,;!?]?\s*$/i
  ];

  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    for (const pattern of directivePatterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      const exactModelId = cleanModelId(match[1]);
      if (!exactModelId) continue;

      return {
        exactModelId,
        fallbackAllowed: false,
        source: 'user_text'
      };
    }
  }

  return null;
}

export function inferTaskRole(message = '', requestedRole = null) {
  if (requestedRole) return requestedRole;
  const text = lower(message);
  if (/\b(code|coding|repo|repository|commit|bug|fix|test|implement|refactor|javascript|typescript|python|powershell|git)\b/.test(text)) return 'coding';
  if (/\b(research|compare|investigate|sources|paper|benchmark)\b/.test(text)) return 'research';
  if (/\b(plan|architecture|design|strategy)\b/.test(text)) return 'planning';
  if (/\b(verify|validate|check|audit)\b/.test(text)) return 'verification';
  return 'chat';
}

function candidateFromModel(model, role, externalEvidence = null) {
  const empirical = model.empirical ?? {};
  const finiteMetric=value=>value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const externalSampleCount=finiteMetric(externalEvidence?.sampleCount),runtimeSampleCount=finiteMetric(empirical.samples);
  const externalSuccessRate=finiteMetric(externalEvidence?.verifiedSuccessRate);
  const empiricalReliability=finiteMetric(empirical.reliability);
  const empiricalQuality=finiteMetric(empirical.qualityMean);
  const legacyMetricsWithoutCount=externalSampleCount == null && runtimeSampleCount == null && (empiricalReliability != null || empiricalQuality != null);
  const counted=[];if(externalSampleCount>0&&externalSuccessRate!=null)counted.push({samples:externalSampleCount,rate:clamp01(externalSuccessRate),quality:clamp01(externalSuccessRate),source:externalEvidence?.evidenceSource??'external_verified_evidence'});if(runtimeSampleCount>0&&(empiricalReliability!=null||empiricalQuality!=null))counted.push({samples:runtimeSampleCount,rate:clamp01(empiricalReliability??empiricalQuality),quality:clamp01(empiricalQuality??empiricalReliability),source:'model_laboratory'});const combinedSampleCount=counted.reduce((sum,item)=>sum+item.samples,0);const hasEmpiricalEvidence=combinedSampleCount>0||legacyMetricsWithoutCount;
  const reliability = combinedSampleCount>0 ? counted.reduce((sum,item)=>sum+item.rate*item.samples,0)/combinedSampleCount : hasEmpiricalEvidence ? clamp01(empiricalReliability??empiricalQuality) : 0.5;
  const quality = combinedSampleCount>0 ? counted.reduce((sum,item)=>sum+item.quality*item.samples,0)/combinedSampleCount : hasEmpiricalEvidence ? clamp01(empiricalQuality??empiricalReliability) : (specializedRoleCompatible(model.roles, role) ? 0.7 : 0.5);
  const latency = runtimeSampleCount>0&&empirical.latencyMs!=null ? empirical.latencyMs : externalEvidence?.medianLatencyMs ?? empirical.latencyMs ?? (model.executionLocality === 'LOCAL' ? 2500 : 8000);
  const costClass = model.cost?.class ?? 'unknown';
  const monetaryCost = costClass === 'local_compute' ? 0 : costClass === 'free_tier' ? 0.05 : costClass === 'provider_quota' ? 0.15 : 0.3;
  const capabilityIds = Object.entries(model.capabilities ?? {}).filter(([, enabled]) => enabled === true).map(([name]) => name);
  return {
    id: `${model.providerProfileId}:${model.modelId}`,
    providerProfileId: model.providerProfileId,
    accountProfileId: model.accountProfileId ?? null,
    modelId: model.modelId,
    executionLocality: lower(model.executionLocality),
    capabilities: capabilityIds,
    roles: model.roles ?? [],
    availability: model.availability === 'UNAVAILABLE' ? 'unavailable' : 'available',
    availabilityState: model.availability,
    qualityScore: clamp01(quality * (0.65 + 0.35 * reliability)),
    confidence: model.confidence ?? 0.25,
    evidenceClass: hasEmpiricalEvidence ? 'verified_execution_history' : 'prior_only',
    empiricalQualified: hasEmpiricalEvidence && reliability > 0,
    evidenceSamples: hasEmpiricalEvidence ? (combinedSampleCount > 0 ? combinedSampleCount : null) : 0,
    evidenceSource: counted.length ? [...new Set(counted.map(item=>item.source))].join('+') : legacyMetricsWithoutCount ? 'legacy_model_laboratory_metrics' : null,
    monetaryCost,
    latencyMs: latency,
    risk: model.provenance?.trusted === false ? 0.4 : 0.08,
    learningValue: Math.max(0, 1 - clamp01(model.confidence ?? 0.25)) * 0.15,
    modelProfile: model
  };
}

export class DynamicModelRouter {
  constructor({ providerFleet, curator = new CandidatePoolCurator({ maxCandidates: 12 }), qualityFloor = 0.55, preferLocalMargin = 0.08, evidenceResolver = null, providerHealthRegistry = null, clock = () => new Date() } = {}) {
    if (!providerFleet) throw new Error('DynamicModelRouter requires ProviderFleet');
    this.providerFleet = providerFleet;
    this.curator = curator;
    this.qualityFloor = qualityFloor;
    this.preferLocalMargin = preferLocalMargin;
    this.evidenceResolver = typeof evidenceResolver === 'function' ? evidenceResolver : null;
    this.providerHealthRegistry = providerHealthRegistry;
    this.clock = clock;
    this.decisions = [];
  }

  candidates({ role, privacyClass = 'INTERNAL', exactModelId = null, resourceState = 'NORMAL', residentModelIds = [], allowModelLoad = true, modelLoadAdmission = null } = {}) {
    const resident = new Set((residentModelIds ?? []).map(String));
    const localLoadBlocked = allowModelLoad === false || ['HIGH','CRITICAL'].includes(String(resourceState).toUpperCase());
    const all = this.providerFleet.models({ availableOnly: !exactModelId })
      .filter(model => roleCompatible(model.roles, role))
      .filter(model => (this.providerHealthRegistry?.canRoute?.({providerId:model.providerProfileId,profileId:model.accountProfileId??null}) ?? {allowed:true}).allowed !== false)
      .filter(model => {
        if (lower(model.executionLocality) !== 'local' || resident.has(String(model.modelId))) return true;
        if (localLoadBlocked) return false;
        if (typeof modelLoadAdmission !== 'function') return true;
        return modelLoadAdmission(model)?.allowed !== false;
      });
    let candidates=all.map(model => candidateFromModel(model, role, this.evidenceResolver?.(model, role) ?? null));
    if(!exactModelId){const qualified=candidates.filter(candidate=>candidate.empiricalQualified===true);if(qualified.length)candidates=qualified;}
    return this.curator.curate(candidates, {
      exactModelId,
      privacyClass: privacyClass === 'LOCAL_ONLY' ? 'LOCAL_ONLY' : privacyClass,
      preferLocal: true
    });
  }

  route({ message = '', role = null, privacyClass = 'INTERNAL', exactModelId = null, fallbackAllowed = null, complexity = null, resourceState = 'NORMAL', residentModelIds = [], allowModelLoad = true, modelLoadAdmission = null } = {}) {
    const inferredRole = inferTaskRole(message, role);
    const parsed = exactModelId ? { exactModelId, fallbackAllowed: fallbackAllowed === true } : parseExplicitModelConstraint(message);
    const exact = exactModelId ?? parsed?.exactModelId ?? null;
    const allowFallback = exact ? Boolean(fallbackAllowed ?? parsed?.fallbackAllowed ?? false) : fallbackAllowed !== false;
    const candidates = this.candidates({ role: inferredRole, privacyClass, exactModelId: exact, resourceState, residentModelIds, allowModelLoad, modelLoadAdmission });
    if (exact && !candidates.length) {
      const exactModel=this.providerFleet.models({availableOnly:false}).find(model=>String(model.modelId)===String(exact));
      const resident=new Set((residentModelIds??[]).map(String));
      const admissionBlocked=Boolean(exactModel&&typeof modelLoadAdmission==='function'&&modelLoadAdmission(exactModel)?.allowed===false);
      const resourceBlocked=Boolean(exactModel&&lower(exactModel.executionLocality)==='local'&&!resident.has(String(exactModel.modelId))&&(allowModelLoad===false||['HIGH','CRITICAL'].includes(String(resourceState).toUpperCase())||admissionBlocked));
      const runtimeHealth=exactModel?(this.providerHealthRegistry?.canRoute?.({providerId:exactModel.providerProfileId,profileId:exactModel.accountProfileId??null})??{allowed:true}):null,runtimeBlocked=runtimeHealth?.allowed===false;
      const result = { status: resourceBlocked ? 'RESOURCE_BLOCKED' : runtimeBlocked ? 'PROVIDER_RUNTIME_BLOCKED' : 'EXACT_MODEL_UNAVAILABLE', role: inferredRole, exactModelId: exact, fallbackAllowed: allowFallback, selected: null, candidates: [], resourceState, runtimeHealth:runtimeBlocked?runtimeHealth:null };
      this.decisions.push({ ...result, at: this.clock().toISOString() });
      return result;
    }
    const maxCost = Math.max(0.01, ...candidates.map(c => c.monetaryCost));
    const maxLatency = Math.max(1000, ...candidates.map(c => c.latencyMs));
    const bids = candidates.map(candidate => CandidateBid.fromMetrics({
      candidateId: candidate.id,
      quality: candidate.qualityScore,
      monetaryCost: candidate.monetaryCost,
      maxCost,
      latencyMs: candidate.latencyMs,
      maxLatencyMs: maxLatency,
      risk: candidate.risk,
      locality: candidate.executionLocality === 'local' ? 1 : 0.2,
      learningValue: candidate.learningValue,
      availability: candidate.availability === 'available' ? 1 : 0,
      metadata: { confidence: candidate.confidence }
    }));
    const ranked = CandidateBid.rank(bids, { quality: 0.5, cost: 0.12, latency: 0.1, risk: 0.1, energy: 0.02, locality: 0.08, learningValue: 0.08 });
    let winner = ranked[0] ? candidates.find(c => c.id === ranked[0].candidateId) : null;
    if (!exact && winner && winner.executionLocality !== 'local') {
      const bestLocal = candidates.filter(c => c.executionLocality === 'local' && c.qualityScore >= this.qualityFloor).sort((a, b) => b.qualityScore - a.qualityScore)[0];
      if (bestLocal && bestLocal.qualityScore + this.preferLocalMargin >= winner.qualityScore && Number(complexity ?? 0.5) < 0.8) winner = bestLocal;
    }
    const result = {
      status: winner ? 'ROUTED' : 'NO_CANDIDATE', role: inferredRole, exactModelId: exact, fallbackAllowed: allowFallback, resourceState,
      selected: winner ? { providerProfileId: winner.providerProfileId, accountProfileId: winner.accountProfileId, modelId: winner.modelId, executionLocality: winner.executionLocality, candidateId: winner.id, evidenceClass:winner.evidenceClass, empiricalQualified:winner.empiricalQualified, evidenceSamples:winner.evidenceSamples, evidenceSource:winner.evidenceSource } : null,
      candidates: ranked.map(bid => {const candidate=candidates.find(item=>item.id===bid.candidateId);return{ candidateId: bid.candidateId, score: bid.weightedScore({ quality: 0.5, cost: 0.12, latency: 0.1, risk: 0.1, energy: 0.02, locality: 0.08, learningValue: 0.08 }), evidenceClass:candidate?.evidenceClass??null, empiricalQualified:candidate?.empiricalQualified===true, evidenceSamples:candidate?.evidenceSamples??0, evidenceSource:candidate?.evidenceSource??null};})
    };
    this.decisions.push({ ...result, at: this.clock().toISOString() });
    return result;
  }

  localOomRecoveryCandidate(decision,{residentModelIds=[],allowModelLoad=true,modelLoadAdmission=null}={}) {
    const resident=new Set((residentModelIds??[]).map(String));
    const original = this.providerFleet.models({ availableOnly: true }).find(model =>
      model.providerProfileId === decision.selected.providerProfileId && model.modelId === decision.selected.modelId);
    const originalSize = Number(original?.hardware?.sizeBytes);
    const candidates = this.providerFleet.models({ availableOnly: true })
      .filter(model => lower(model.executionLocality) === 'local')
      .filter(model => roleCompatible(model.roles, decision.role))
      .filter(model => !(model.providerProfileId === decision.selected.providerProfileId && model.modelId === decision.selected.modelId))
      .filter(model => resident.has(String(model.modelId)) || (allowModelLoad!==false && (typeof modelLoadAdmission!=='function' || modelLoadAdmission(model)?.allowed!==false)))
      .map(model => candidateFromModel(model, decision.role));
    const known = candidates.filter(candidate => knownModelSize(candidate) != null)
      .filter(candidate => !Number.isFinite(originalSize) || originalSize <= 0 || knownModelSize(candidate) < originalSize)
      .sort((a, b) => knownModelSize(a) - knownModelSize(b) || a.modelId.localeCompare(b.modelId));
    if (known.length) return known[0];
    if (Number.isFinite(originalSize) && originalSize > 0) return null;
    return candidates.sort((a, b) => (knownModelSize(a) ?? Number.POSITIVE_INFINITY) - (knownModelSize(b) ?? Number.POSITIVE_INFINITY) || a.modelId.localeCompare(b.modelId))[0] ?? null;
  }

  async execute({ messages, maxOutputTokens = 1200, message = messages?.at(-1)?.content ?? '', role = null, privacyClass = 'INTERNAL', exactModelId = null, fallbackAllowed = null, options = {}, routeDecision = null, initialBackend = null, resourceState = 'NORMAL', residentModelIds = [], allowModelLoad = true, modelLoadAdmission = null } = {}) {
    const decision = routeDecision ?? this.route({ message, role, privacyClass, exactModelId, fallbackAllowed, complexity: options.complexity, resourceState, residentModelIds, allowModelLoad, modelLoadAdmission });
    if (!decision.selected) throw Object.assign(new Error(decision.status === 'EXACT_MODEL_UNAVAILABLE' ? `Exact model unavailable: ${decision.exactModelId}` : 'No model candidate available'), { code: decision.status, decision });
    const started = performance.now();
    let selected = decision.selected;
    let answer;
    let recovery = null;
    try {
      const backend = initialBackend ?? await this.providerFleet.backendFor(selected);
      answer = await backend.chat(messages, maxOutputTokens, { ...options, fallbackAllowed: decision.fallbackAllowed, requireExactModel: Boolean(decision.exactModelId) });
    } catch (error) {
      const failure=classifyProviderRuntimeFailure(error);
      if(failure.scope==='provider')await this.providerHealthRegistry?.recordFailure?.({providerId:selected.providerProfileId,profileId:selected.accountProfileId??null},failure);
      const recoverable = !decision.exactModelId && decision.fallbackAllowed === true && selected.executionLocality === 'local' && isLocalResourceOom(error);
      if (!recoverable) throw error;
      const alternative = this.localOomRecoveryCandidate(decision,{residentModelIds,allowModelLoad,modelLoadAdmission});
      if (!alternative) throw error;
      selected = { providerProfileId: alternative.providerProfileId, accountProfileId: alternative.accountProfileId, modelId: alternative.modelId, executionLocality: alternative.executionLocality, candidateId: alternative.id };
      recovery = { originalModel: decision.selected.modelId, recoveryModel: selected.modelId, fallbackReason: 'local_resource_oom' };
      try {
        const recoveryBackend = await this.providerFleet.backendFor(selected);
        answer = await recoveryBackend.chat(messages, maxOutputTokens, { ...options, fallbackAllowed: false, requireExactModel: true });
      } catch (recoveryError) {
        throw Object.assign(recoveryError, { modelRecovery: recovery, originalError: error?.message ?? String(error) });
      }
    }
    await this.providerHealthRegistry?.recordSuccess?.({providerId:selected.providerProfileId,profileId:selected.accountProfileId??null});
    const actualModel = answer.actualModel ?? answer.model ?? selected.modelId;
    const executionLocality = lower(answer.executionLocality ?? selected.executionLocality);
    if (decision.exactModelId && actualModel !== decision.exactModelId) throw Object.assign(new Error(`Exact model mismatch: requested ${decision.exactModelId}, executed ${actualModel}`), { code: 'MODEL_IDENTITY_MISMATCH', requestedModel: decision.exactModelId, actualModel });
    if (recovery && (actualModel !== selected.modelId || executionLocality !== 'local')) throw Object.assign(new Error(`OOM recovery model mismatch: requested local ${selected.modelId}, executed ${actualModel}`), { code: 'MODEL_IDENTITY_MISMATCH', requestedModel: selected.modelId, actualModel, executionLocality });
    return {
      ...answer,
      routeDecision: recovery ? { ...decision, recovery } : decision,
      evidence: {
        schema: 'mnemos.model-execution-evidence.v2', providerProfileId: selected.providerProfileId, requestedModel: decision.exactModelId ?? decision.selected.modelId,
        actualModel, executionLocality, fallbackUsed: Boolean(recovery) || actualModel !== (decision.exactModelId ?? decision.selected.modelId),
        verifiedExactModel: !decision.exactModelId || actualModel === decision.exactModelId, originalSelectedModel: decision.selected.modelId,
        recoveryModel: recovery?.recoveryModel ?? null, fallbackReason: recovery?.fallbackReason ?? null,
        latencyMs: answer.latencyMs ?? (performance.now() - started), at: this.clock().toISOString()
      }
    };
  }
}
