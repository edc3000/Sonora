import test from "node:test";
import assert from "node:assert/strict";
import { AgentBrain, affinityAdjustment, sampleAcrossTiers } from "../server/agent.js";

function makeNcm(overrides = {}) {
  return {
    configured: true,
    search: async () => [],
    similarSongs: async () => [],
    artistTopSongs: async () => [],
    recommend: async () => [],
    ...overrides
  };
}

function baseFragments(extra = {}) {
  return {
    currentInput: "",
    musicTaste: {
      topArtists: [],
      songSeeds: [],
      artistSeeds: []
    },
    memory: { recentPlays: [] },
    toolResults: { searchResults: [] },
    ...extra
  };
}

test("affinityAdjustment: top-5 artist gets +5, top-20 artist gets 0, unknown artist gets +12 novelty bonus", () => {
  const core = new Set(["Famous"]);
  const wellKnown = new Set(["Famous", "MidName"]);
  assert.equal(affinityAdjustment("Famous", core, wellKnown), 5);
  assert.equal(affinityAdjustment("MidName", core, wellKnown), 0);
  assert.equal(affinityAdjustment("CompletelyNew", core, wellKnown), 12);
});

test("affinityAdjustment: artist matching is case-insensitive and substring-tolerant", () => {
  const core = new Set(["Sunset Rollercoaster"]);
  const wellKnown = new Set(["Sunset Rollercoaster"]);
  assert.equal(affinityAdjustment("sunset rollercoaster / guest", core, wellKnown), 5);
  assert.equal(affinityAdjustment("Brand New Band", core, wellKnown), 12);
});

test("sampleAcrossTiers: preserves tier3 candidates even when tier1 is plentiful", () => {
  const sorted = [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `t1-${i}`, title: `H${i}`, artist: "A", score: 90 })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `t2-${i}`, title: `M${i}`, artist: "B", score: 60 })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `t3-${i}`, title: `L${i}`, artist: "C", score: 45 }))
  ];
  const picked = sampleAcrossTiers(sorted, { total: 60, tier1: 30, tier2: 15, tier3: 15 });
  assert.equal(picked.length, 60, "should fill to 60");
  const t3Count = picked.filter((c) => c.score <= 50).length;
  assert.equal(t3Count, 15, `tier3 should keep its 15 quota, got ${t3Count}`);
  const t2Count = picked.filter((c) => c.score > 50 && c.score < 70).length;
  assert.equal(t2Count, 15, `tier2 should keep its 15 quota, got ${t2Count}`);
});

test("sampleAcrossTiers: backfills under-quota tiers from sorted list", () => {
  // tier3 only has 3, tier2 has 5, tier1 has plenty
  const sorted = [
    ...Array.from({ length: 80 }, (_, i) => ({ id: `t1-${i}`, title: `H${i}`, artist: "A", score: 90 })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `t2-${i}`, title: `M${i}`, artist: "B", score: 60 })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `t3-${i}`, title: `L${i}`, artist: "C", score: 45 }))
  ];
  const picked = sampleAcrossTiers(sorted, { total: 60, tier1: 30, tier2: 15, tier3: 15 });
  assert.equal(picked.length, 60, "should still fill to 60 via backfill");
  // all 3 tier3 + all 5 tier2 should be in
  assert.equal(picked.filter((c) => c.score === 45).length, 3);
  assert.equal(picked.filter((c) => c.score === 60).length, 5);
  // remainder filled from tier1
  assert.equal(picked.filter((c) => c.score === 90).length, 52);
});

test("buildCandidatePool: novelty bonus raises daily-recommended unknown artists into LLM-visible tier", async () => {
  const ncm = makeNcm({
    recommend: async () => [
      { id: "d-unknown", title: "Daily New", artist: "BrandNewArtist", duration: 240 },
      { id: "d-known", title: "Daily Familiar", artist: "Famous", duration: 240 }
    ]
  });
  const agent = new AgentBrain({ openai: {}, ncm });
  const pool = await agent.buildCandidatePool(baseFragments({
    musicTaste: {
      topArtists: [{ artist: "Famous" }],
      songSeeds: [],
      artistSeeds: []
    }
  }));
  const unknown = pool.find((c) => c.id === "d-unknown");
  const known = pool.find((c) => c.id === "d-known");
  assert.ok(unknown, "novelty-side daily song should be in candidate pool");
  assert.ok(known, "familiar-side daily song should be in candidate pool");
  assert.equal(unknown.score, 52 + 12, "novelty bonus +12 should apply");
  assert.equal(known.score, 52 + 5, "core-artist affinity +5 should apply");
  assert.ok(unknown.score > known.score, "novelty bonus should outrank +5 core affinity");
});

test("buildCandidatePool: recentPlays penalty covers the full 30-track window, not just 12", async () => {
  const recentPlays = Array.from({ length: 30 }, (_, i) => ({ title: `R${i}`, artist: "Famous" }));
  const ncm = makeNcm({
    recommend: async () => [
      { id: "stale", title: "R25", artist: "Famous", duration: 240 },
      { id: "fresh", title: "FreshTrack", artist: "Famous", duration: 240 }
    ]
  });
  const agent = new AgentBrain({ openai: {}, ncm });
  const pool = await agent.buildCandidatePool(baseFragments({
    memory: { recentPlays },
    musicTaste: { topArtists: [{ artist: "Famous" }], songSeeds: [], artistSeeds: [] }
  }));
  const stale = pool.find((c) => c.id === "stale");
  const fresh = pool.find((c) => c.id === "fresh");
  assert.ok(stale && fresh, "both songs should be in pool");
  assert.equal(fresh.score - stale.score, 35, "stale (within 30-window) should be penalised by exactly 35");
});

test("buildCandidatePool: returned list is sorted by score desc", async () => {
  const ncm = makeNcm({
    recommend: async () => [
      { id: "low", title: "L", artist: "Unknown1", duration: 240 },
      { id: "mid", title: "M", artist: "Unknown2", duration: 240 }
    ],
    similarSongs: async () => [
      { id: "high", title: "H", artist: "Unknown3", duration: 240 }
    ]
  });
  const agent = new AgentBrain({ openai: {}, ncm });
  const pool = await agent.buildCandidatePool(baseFragments({
    musicTaste: {
      topArtists: [],
      songSeeds: [{ id: "seed1", title: "S", artist: "X", popularity: 80 }],
      artistSeeds: []
    }
  }));
  for (let i = 1; i < pool.length; i += 1) {
    assert.ok((pool[i - 1].score || 0) >= (pool[i].score || 0), "pool must be sorted by score desc");
  }
});
