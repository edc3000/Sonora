import test from "node:test";
import assert from "node:assert/strict";
import { buildStoryLinkedIntro, compactTrackStory, detectLanguage, selectIntroForTrack } from "../server/intro.js";

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

test("detectLanguage: cantopop artist returns yue", () => {
  assert.equal(detectLanguage({ title: "于心有愧", artist: "陈奕迅", album: "What's Going On...?" }), "yue");
});

test("detectLanguage: mandarin track returns zh", () => {
  assert.equal(detectLanguage({ title: "关于郑州的记忆", artist: "李志", album: "梵高先生" }), "zh");
});

test("detectLanguage: english track returns en", () => {
  assert.equal(detectLanguage({ title: "My Jinji", artist: "Sunset Rollercoaster", album: "Cake Shop" }), "en");
});

test("buildStoryLinkedIntro: chinese track gets a chinese fallback intro", () => {
  const intro = buildStoryLinkedIntro({
    title: "关于郑州的记忆",
    artist: "李志",
    album: "梵高先生",
    publishTime: "2009",
    lyricLines: [{ time: 8, text: "郑州的天总是阴沉" }]
  }, { index: 1, reason: "similar to liked song: 你离开了南京从此没人和我说话" });
  assert.match(intro, /关于郑州的记忆/);
  assert.match(intro, /李志/);
  assert.match(intro, /郑州的天总是阴沉/);
  assert.doesNotMatch(intro, /\bOpening with\b|\bNext\b/, "chinese track should not use english opening");
  assert.ok(intro.length <= 360);
});

test("buildStoryLinkedIntro: fallback no longer hard-codes artist personality (no fixed prefix per artist)", () => {
  // 同一个艺人在不同歌曲下不应都被冠以"Eason 唱这类歌不靠音量..."这种固定句
  const a = buildStoryLinkedIntro({
    title: "歌曲甲",
    artist: "陈奕迅",
    album: "专辑甲",
    publishTime: "2010",
    lyricLines: [{ time: 5, text: "甲乙丙丁戊己庚辛" }]
  });
  const b = buildStoryLinkedIntro({
    title: "歌曲乙",
    artist: "陈奕迅",
    album: "专辑乙",
    publishTime: "2015",
    lyricLines: [{ time: 5, text: "另一句完全不同的歌词" }]
  });
  // 不应该出现旧版固定 prefix
  assert.doesNotMatch(a, /不靠音量|不靠喊|靠咬字的停顿/);
  assert.doesNotMatch(b, /不靠音量|不靠喊|靠咬字的停顿/);
  // 但都应该包含各自具体的事实
  assert.match(a, /歌曲甲|专辑甲|甲乙丙丁/);
  assert.match(b, /歌曲乙|专辑乙|另一句/);
});

test("buildStoryLinkedIntro: english fallback drops the old subjective set-fit filler", () => {
  const intro = buildStoryLinkedIntro({
    title: "Mid",
    artist: "Some Band",
    album: "Plain",
    publishTime: "2020"
  }, { index: 2, reason: "night landing" });
  // 旧的主观短语不应再出现
  assert.doesNotMatch(intro, /late signal|breathe before the track|scene to enter, not just a tempo/);
  // 但仍包含基本事实
  assert.match(intro, /Mid/);
  assert.match(intro, /Some Band/);
});

test("buildChineseIntro is stable for the same track id (deterministic hash)", () => {
  const track = {
    id: "stable-track-id",
    title: "稳定测试",
    artist: "测试歌手",
    album: "测试专辑",
    publishTime: "2020",
    lyricLines: [{ time: 5, text: "第一行歌词" }]
  };
  const a = buildStoryLinkedIntro(track);
  const b = buildStoryLinkedIntro(track);
  assert.equal(a, b, "same track must produce the same fallback intro");
});

test("selectIntroForTrack: stored english intro on a chinese track is replaced (language mismatch)", () => {
  const track = {
    title: "在空中的这一秒",
    artist: "林家谦",
    album: "SUMMER BLUES Live",
    publishTime: "2023",
    intro: "This 2023 live recording from Hong Kong's Coliseum by Lin Ka-him has a meditative, suspended quality that feels born of late-night reflection.",
    lyricLines: [{ time: 4, text: "这一秒 我们悬在半空" }]
  };
  const got = selectIntroForTrack(track);
  assert.doesNotMatch(got, /Hong Kong's Coliseum|This 2023 live recording/, "old english intro on chinese track must be discarded");
  assert.match(got, /[一-鿿]/, "rewritten intro should contain chinese characters");
  assert.match(got, /林家谦|《在空中的这一秒》/);
});

test("selectIntroForTrack: stored chinese intro on a chinese track is preserved (no false mismatch)", () => {
  const track = {
    title: "花洒",
    artist: "古巨基",
    album: "Human 我生",
    publishTime: "2006",
    intro: "上一首的钢琴还留在耳边，下一首换古巨基的「花洒」。2006 年《Human 我生》里的歌，讲的是用最日常的水流声，去冲掉一些说不出口的情绪。"
  };
  const got = selectIntroForTrack(track);
  assert.equal(got, track.intro, "well-formed chinese intro should be preserved as-is");
});

test("selectIntroForTrack: stored english intro on an english track is preserved", () => {
  const track = {
    title: "My Jinji",
    artist: "Sunset Rollercoaster",
    album: "Cake Shop, 2018",
    intro: "Sunset Rollercoaster's 'My Jinji' is a 1997 sound played back through a 2018 lens — warm, humid, very Taipei."
  };
  const got = selectIntroForTrack(track);
  assert.equal(got, track.intro);
});

test("selectIntroForTrack: english intro that only references chinese artist name (no real chinese narration) is still replaced", () => {
  // 关键场景：上一版残留——主体英文，仅在艺人名/歌名中夹了中文
  const track = {
    title: "世一 (不可一世)",
    artist: "MC 张天赋 / Kiri T",
    intro: "This 2023 single by MC 张天赋 featuring Kiri T has a bold, declarative energy. It is the kind of confident statement that opens a set with weight."
  };
  const got = selectIntroForTrack(track);
  assert.doesNotMatch(got, /This 2023 single|declarative energy/, "the english-bodied intro must be discarded");
  // fallback 应为中文事实拼接
  assert.match(got, /世一|MC 张天赋/);
});

test("selectIntroForTrack: chinese intro with embedded english proper nouns (album/single name) is preserved", () => {
  const track = {
    title: "花洒",
    artist: "古巨基",
    album: "Human 我生",
    intro: "上一首的钢琴还留在耳边，下一首换古巨基的「花洒」。2006 年《Human 我生》里的歌，讲的是用最日常的水流声。"
  };
  const got = selectIntroForTrack(track);
  assert.equal(got, track.intro, "english proper nouns inside chinese narration should not trigger mismatch");
});

test("lyric image strips duet role prefixes like '陈：' / '祖儿：' / 'Eason:'", () => {
  const intro = buildStoryLinkedIntro({
    title: "Listen to Eason's Moment",
    artist: "陈奕迅",
    album: "Listen to Eason Chan",
    publishTime: "2007",
    lyricLines: [
      { time: 4, text: "陈：说 我该怎么说" },
      { time: 8, text: "祖儿：我该怎么做" }
    ]
  }, { index: 1 });
  // 角色标记应该被剥离
  assert.doesNotMatch(intro, /陈：|祖儿：/, "intro must not show duet role labels");
  // 歌词内容仍保留
  assert.match(intro, /说 我该怎么说|我该怎么做/);
});

test("lyric image strips english role prefixes too (e.g. 'Eason:')", () => {
  const intro = buildStoryLinkedIntro({
    title: "Duet",
    artist: "Eason Chan / Joey Yung",
    lyricLines: [
      { time: 2, text: "Eason: keep the chorus quiet" }
    ]
  });
  assert.doesNotMatch(intro, /Eason:/, "english role label should be stripped from lyric quote");
  assert.match(intro, /keep the chorus quiet/);
});
