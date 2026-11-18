export class CandidatePoolCurator {
  constructor(options = {}) {
    // Historical API accepted the policy array directly; the v2 API accepts an options object.
    if (Array.isArray(options)) options = { policies: options };
    const { policies = [], maxCandidates = 10, qualityFloor = 0 } = options;
    this.policies = policies; this.maxCandidates = maxCandidates; this.qualityFloor = qualityFloor;
  }

  curate(candidates = [], taskContext = {}) {
    const unique = new Map();
    for (const candidate of candidates) if (candidate?.id && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
    let pool = [...unique.values()].filter(candidate => candidate.availability !== 'unavailable' && candidate.disabled !== true);
    if (taskContext.requiredCapabilities?.length) pool = pool.filter(candidate => taskContext.requiredCapabilities.every(cap => (candidate.capabilities ?? []).includes(cap)));
    if (taskContext.exactModelId) pool = pool.filter(candidate => candidate.modelId === taskContext.exactModelId || candidate.id === taskContext.exactModelId);
    if (taskContext.privacyClass === 'LOCAL_ONLY') pool = pool.filter(candidate => candidate.executionLocality !== 'cloud' && candidate.locationClass !== 'remote');
    pool = pool.filter(candidate => Number(candidate.qualityScore ?? candidate.quality ?? 1) >= this.qualityFloor);
    for (const policy of this.policies) if (typeof policy.filter === 'function') pool = pool.filter(candidate => policy.filter(candidate, taskContext));
    const scored = pool.map(candidate => {
      let score = Number(candidate.qualityScore ?? candidate.quality ?? 0);
      for (const policy of this.policies) if (typeof policy.score === 'function') score += Number(policy.score(candidate, taskContext) ?? 0);
      if (taskContext.preferLocal && candidate.executionLocality === 'local') score += 0.1;
      return { candidate, score };
    });
    scored.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
    return scored.slice(0, this.maxCandidates).map(({ candidate, score }) => ({ ...candidate, curatorScore: score }));
  }
}
