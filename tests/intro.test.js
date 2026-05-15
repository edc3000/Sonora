import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryLinkedIntro, compactTrackStory, selectIntroForTrack } from "../server/intro.js";

test("buildStoryLinkedIntro uses lyric and album details instead of generic fit language", () => {
  const intro = buildStoryLinkedIntro({
    title: "Late Night Story",
    artist: "The Example Band",
    album: "Small Hours",
    publishTime: "2018-10-12",
    reasons: ["similar to liked song: Quiet Street"],
    lyricLines: [
      { time: 12, text: "I kept the light on by the window" },
      { time: 38, text: "Waiting for the city to answer" }
    ]
  }, { index: 0, reason: "night landing" });

  assert.match(intro, /Late Night Story/);
  assert.match(intro, /The Example Band/);
  assert.match(intro, /Small Hours/);
  assert.match(intro, /2018/);
  assert.match(intro, /kept the light on by the window/);
  assert.doesNotMatch(intro, /gives the intro|station focused/);
  assert.doesNotMatch(intro, /without pulling too much focus|little shape without getting in the way/);
  assert.ok(intro.length <= 500);
});

test("compactTrackStory exposes song-specific material for the LLM prompt", () => {
  const story = compactTrackStory({
    title: "A",
    artist: "B",
    album: "Album B",
    publishTime: "2020-01-01",
    source: "netease:simi",
    seed: { type: "song", id: "1" },
    reasons: ["similar to liked song: Seed Song"],
    lyricLines: [
      { time: 0, text: "作词：Someone" },
      { time: 1, text: "First usable lyric" },
      { time: 2, text: "Second usable lyric" }
    ]
  });

  assert.deepEqual(story, {
    album: "Album B",
    year: "2020",
    source: "netease:simi",
    seed: "song:1",
    reasons: ["similar to liked song: Seed Song"],
    lyricQuote: "First usable lyric / Second usable lyric"
  });
});

test("compactTrackStory ignores provider errors and credit metadata in lyric quotes", () => {
  const story = compactTrackStory({
    title: "Bad Feed",
    artist: "Example",
    album: "Recovered",
    publishTime: "2021-01-01",
    lyricLines: [
      { time: 0, text: "获取歌词失败，请稍后重试" },
      { time: 1, text: "Strings arrangement and transcription : Someone" },
      { time: 2, text: "A: First real line" },
      { time: 3, text: "Second real line" }
    ]
  });

  assert.equal(story.lyricQuote, "First real line / Second real line");
});

test("selectIntroForTrack rewrites old fallback intros that read like internal copy", () => {
  const intro = selectIntroForTrack({
    title: "及时行乐",
    artist: "洪嘉豪",
    album: "及时行乐",
    publishTime: 1643212800000,
    intro: "Coming up next 及时行乐 by 洪嘉豪. From 及时行乐, 2022, it gives the intro a real image: \"这晚看灯饰煽情.\" It keeps the station focused while still giving the song its own small story.",
    lyricLines: [
      { time: 14.62, text: "这晚看灯饰煽情" },
      { time: 21.13, text: "这里繁盛不懂呼应" }
    ]
  }, { index: 1, reason: "work focus" });

  assert.match(intro, /及时行乐/);
  assert.match(intro, /这晚看灯饰煽情/);
  assert.doesNotMatch(intro, /gives the intro|station focused/);
});

test("selectIntroForTrack replaces generic model intros with story-linked fallback", () => {
  const intro = selectIntroForTrack({
    title: "Harbour Light",
    artist: "Night Ferry",
    album: "Crossing",
    publishTime: "2019-04-02",
    intro: "Harbour Light by Night Ferry fits the vibe without stealing focus.",
    lyricLines: [
      { time: 4, text: "The harbour kept every goodbye" }
    ]
  }, { index: 1, reason: "night landing" });

  assert.match(intro, /Harbour Light/);
  assert.match(intro, /Crossing/);
  assert.match(intro, /harbour kept every goodbye/);
  assert.doesNotMatch(intro, /fits the vibe without stealing focus/);
});
