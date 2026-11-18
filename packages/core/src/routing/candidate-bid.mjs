const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp01 = value => Math.max(0, Math.min(1, finite(value)));
const inverseScore = (value, ceiling) => clamp01(1 - Math.max(0, finite(value)) / Math.max(1e-9, finite(ceiling, 1)));

export class CandidateBid {
  constructor({ candidateId, quality = 0, cost = 0, latency = 0, risk = 0, energy = 0, locality = 0, learningValue = 0, availability = 1, metadata = {} } = {}) {
    if (!candidateId) throw new Error('candidateId is required');
    // Direct bids intentionally preserve signed/raw utilities. This is the long-standing API and
    // permits a caller to express a cost as a negative utility. `fromMetrics` is the normalized API.
    Object.assign(this, { candidateId, quality: finite(quality), cost: finite(cost), latency: finite(latency), risk: finite(risk), energy: finite(energy), locality: finite(locality), learningValue: finite(learningValue), availability: clamp01(availability), metadata });
  }

  static fromMetrics({ candidateId, quality = 0, monetaryCost = 0, maxCost = 1, latencyMs = 0, maxLatencyMs = 60000, risk = 0, energyJoules = 0, maxEnergyJoules = 10000, locality = 0, learningValue = 0, availability = 1, metadata = {} }) {
    return new CandidateBid({ candidateId, quality: clamp01(quality), cost: inverseScore(monetaryCost, maxCost), latency: inverseScore(latencyMs, maxLatencyMs), risk: 1 - clamp01(risk), energy: inverseScore(energyJoules, maxEnergyJoules), locality: clamp01(locality), learningValue: clamp01(learningValue), availability, metadata: { ...metadata, normalizedMetrics: true } });
  }

  weightedScore(weights = null) {
    const w = weights && Object.keys(weights).length ? weights : { quality: 0.45, cost: 0.12, latency: 0.1, risk: 0.12, energy: 0.04, locality: 0.07, learningValue: 0.1 };
    const raw = this.quality*finite(w.quality) + this.cost*finite(w.cost) + this.latency*finite(w.latency) + this.risk*finite(w.risk) + this.energy*finite(w.energy) + this.locality*finite(w.locality) + this.learningValue*finite(w.learningValue);
    return raw * this.availability;
  }

  static rank(bids, weights = null) { return [...bids].sort((a, b) => b.weightedScore(weights) - a.weightedScore(weights) || a.candidateId.localeCompare(b.candidateId)); }
}
