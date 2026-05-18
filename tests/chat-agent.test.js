import test from "node:test";
import assert from "node:assert/strict";
import { ChatAgent } from "../server/chat-agent.js";

function makeDeps(overrides = {}) {
  const calls = { runShow: 0, nextTrack: 0, previousTrack: 0, pause: 0, resume: 0, searchAndEnqueue: [] };
  const baseNow = { track: { title: "Sample", artist: "Test" }, queue: [], history: [], status: "playing" };
  const deps = {
    state: { snapshot: { now: baseNow } },
    runShow: async ({ input } = {}) => {
      calls.runShow += 1;
      calls.lastRunShowInput = input;
      return baseNow;
    },
    nextTrack: async () => { calls.nextTrack += 1; return baseNow; },
    previousTrack: async () => { calls.previousTrack += 1; return baseNow; },
    pausePlayback: async () => { calls.pause += 1; return { ...baseNow, status: "paused" }; },
    resumePlayback: async () => { calls.resume += 1; return baseNow; },
    searchAndEnqueueNext: async (query, opts) => {
      calls.searchAndEnqueue.push({ query, opts });
      return {
        now: baseNow,
        added: 1,
        skipped: 0,
        tracks: [{ id: "t1", title: query, artist: "X" }],
        results: [{ id: "t1", title: query, artist: "X" }]
      };
    },
    ...overrides
  };
  return { deps, calls };
}

test("fallback: keyword '下一首' triggers next_track without LLM", async () => {
  const { deps, calls } = makeDeps();
  const agent = new ChatAgent({ openai: {}, deps });
  const result = await agent.handle({ message: "下一首", userId: "u1" });
  assert.equal(calls.nextTrack, 1);
  assert.equal(calls.runShow, 0);
  assert.match(result.reply, /next/i);
});

test("fallback: music keyword routes to runShow (replace) when no LLM key", async () => {
  const { deps, calls } = makeDeps();
  const agent = new ChatAgent({ openai: {}, deps });
  await agent.handle({ message: "播放一些 lofi", userId: "u1" });
  assert.equal(calls.runShow, 1);
  assert.equal(calls.searchAndEnqueue.length, 0);
});

test("history is isolated per userId and trimmed", async () => {
  const { deps } = makeDeps();
  const agent = new ChatAgent({ openai: {}, deps });
  for (let i = 0; i < 20; i += 1) {
    await agent.handle({ message: `msg-${i}`, userId: "alice" });
  }
  await agent.handle({ message: "hi", userId: "bob" });
  const alice = agent.getHistory("alice");
  const bob = agent.getHistory("bob");
  assert.ok(alice.length <= 14, `alice history should be trimmed, got ${alice.length}`);
  assert.equal(bob.length, 2);
  assert.notDeepStrictEqual(alice, bob);
});

test("dispatchTool search_and_play_next calls searchAndEnqueueNext with the query and does NOT replace the show", async () => {
  const { deps, calls } = makeDeps();
  const agent = new ChatAgent({ openai: {}, deps });
  const result = await agent.dispatchTool("search_and_play_next", { query: "周杰伦 晴天", limit: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(calls.searchAndEnqueue.length, 1);
  assert.equal(calls.searchAndEnqueue[0].query, "周杰伦 晴天");
  assert.equal(calls.searchAndEnqueue[0].opts.limit, 2);
  assert.match(result.note, /FRONT|next/, "tool result should indicate front-of-queue / play next semantics");
  assert.equal(calls.runShow, 0, "search must not trigger replace_show / runShow");
});

test("dispatchTool replace_show calls runShow exactly once", async () => {
  const { deps, calls } = makeDeps();
  const agent = new ChatAgent({ openai: {}, deps });
  await agent.dispatchTool("replace_show", { prompt: "换成深夜爵士" });
  assert.equal(calls.runShow, 1);
  assert.equal(calls.lastRunShowInput, "换成深夜爵士");
  assert.equal(calls.searchAndEnqueue.length, 0);
});

test("dispatchTool catches errors and returns ok=false", async () => {
  const { deps } = makeDeps({
    searchAndEnqueueNext: async () => { throw new Error("ncm down"); }
  });
  const agent = new ChatAgent({ openai: {}, deps });
  const result = await agent.dispatchTool("search_and_play_next", { query: "x" });
  assert.equal(result.ok, false);
  assert.match(result.error, /ncm down/);
});

test("empty message returns a prompt without calling any tool", async () => {
  const { deps, calls } = makeDeps();
  const agent = new ChatAgent({ openai: {}, deps });
  const result = await agent.handle({ message: "   ", userId: "u1" });
  assert.equal(calls.runShow, 0);
  assert.equal(calls.searchAndEnqueue.length, 0);
  assert.ok(result.reply.length > 0);
});
