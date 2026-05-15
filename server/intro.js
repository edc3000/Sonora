export function introForTrack(track, { index = 0, reason = "" } = {}) {
  return buildStoryLinkedIntro(track, { index, reason });
}

export function selectIntroForTrack(track, { index = 0, reason = "" } = {}) {
  const existing = cleanText(track?.intro);
  if (existing && !isGenericIntro(existing)) return existing.slice(0, 500);
  return buildStoryLinkedIntro(track, { index, reason });
}

export function buildStoryLinkedIntro(track, { index = 0, reason = "" } = {}) {
  if (!track?.title) return "";
  const title = track.title;
  const artist = track.artist || "this artist";
  const placement = index === 0 ? "We are opening with" : "Coming up next";
  const story = compactTrackStory(track);
  const trackContext = storySummary(track, story);
  const setContext = setFitLine(track, { reason });
  return `${placement} ${title} by ${artist}. ${trackContext} ${setContext}`
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function compactTrackStory(track = {}) {
  const album = cleanText(track.album || track.albumName);
  const year = yearFromTrack(track);
  const reasons = Array.isArray(track.reasons)
    ? track.reasons.filter(Boolean).slice(0, 3)
    : [];
  const lyricQuote = lyricImage(track.lyricLines);
  const seed = compactSeed(track.seed);
  return compact({
    album,
    year,
    source: cleanText(track.source),
    seed,
    reasons,
    lyricQuote
  });
}

function storySummary(track, story) {
  const knownArtistContext = knownArtistStory(track);
  const record = [story.album, story.year].filter(Boolean).join(", ");
  if (story.lyricQuote && record) {
    return `From ${record}, it opens on "${story.lyricQuote}," giving the next few minutes a concrete image.`;
  }
  if (story.lyricQuote) {
    return `The first image is "${story.lyricQuote}," so the song enters with a clear scene.`;
  }
  if (knownArtistContext) return knownArtistContext;
  if (record) return `The ${record} setting gives the song a specific place in the set.`;
  if (story.reasons?.length) return `It came through ${story.reasons[0]}, so the handoff starts from a real listening trail.`;
  return "It has a distinct melodic center, enough to make the handoff feel chosen rather than shuffled.";
}

function setFitLine(track, { reason = "" } = {}) {
  const story = compactTrackStory(track);
  const reasonText = cleanText(reason) || story.reasons?.[0] || "";
  if (/similar to liked song:/i.test(reasonText)) {
    const seed = reasonText.replace(/.*similar to liked song:\s*/i, "").trim();
    if (seed) return `I am using that link back to ${seed} as the emotional bridge into this one.`;
  }
  if (/liked-song seed|familiar liked-song seed/i.test(reasonText)) {
    return "Because it already lives in your listening memory, the handoff can lean into recognition rather than discovery.";
  }
  if (/night|late|soft/i.test(reasonText)) {
    return "It fits the late signal by letting the story breathe before the track arrives.";
  }
  if (/work|focus|steady/i.test(reasonText)) {
    return "It keeps the set steady while giving the song a specific doorway in.";
  }
  return "It fits this set because the song has a scene to enter, not just a tempo to fill.";
}

function knownArtistStory(track = {}) {
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
  if (/the chairs|椅子/.test(text)) {
    return "The Chairs bring that soft Taiwanese indie-pop glow: close harmonies, unhurried guitars, and a melody that feels hand-drawn.";
  }
  if (/周柏豪|pakho/.test(text) && /卫兰|衛蘭|janice/.test(text)) {
    return "It is a Cantonese pop duet built on restraint, where two familiar voices trade tenderness instead of drama.";
  }
  if (/周柏豪|pakho/.test(text)) {
    return "Pakho Chau is at his best in this kind of late-night Cantopop ballad, keeping the feeling controlled but unmistakably present.";
  }
  if (/陈奕迅|陳奕迅|eason/.test(text)) {
    return "Eason Chan turns a pop song into a small piece of theatre, letting the lyric land through phrasing more than volume.";
  }
  if (/容祖儿|容祖兒|joey/.test(text)) {
    return "Joey Yung carries the song with a polished Cantopop clarity, making the hook feel graceful rather than oversized.";
  }
  if (/杨千嬅|楊千嬅|miriam/.test(text)) {
    return "Miriam Yeung brings that bright, bruised Hong Kong-pop character: direct, resilient, and quietly cinematic.";
  }
  if (/张敬轩|張敬軒|hins/.test(text)) {
    return "Hins Cheung leans into the song with the precision of a classic Cantopop balladeer, measured but emotionally open.";
  }
  if (/dear jane|rubberband|beyond/.test(text)) {
    return "It sits in the Hong Kong band tradition, with guitars carrying the emotion as much as the vocal line.";
  }
  if (isCantoneseTrack(track)) {
    return "This is Cantopop in its intimate mode: melodic, lyrical, and built for the small private weather of the day.";
  }
  return "";
}

function lyricImage(lines = []) {
  if (!Array.isArray(lines)) return "";
  const usable = lines
    .map((line) => normalizeLyricText(line?.text))
    .filter(isUsableLyricText)
    .slice(0, 2);
  return usable.join(" / ").slice(0, 140);
}

function normalizeLyricText(value) {
  return cleanText(value)
    .replace(/^[A-Z]\s*[：:]\s*/i, "")
    .replace(/^[合独男男女女声]\s*[：:]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsableLyricText(text) {
  if (!text) return false;
  if (text.length > 90) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (BAD_LYRIC_TEXT_PATTERN.test(text)) return false;
  if (/^[\w\s,().&'@/-]{2,45}\s*[：:]/.test(text)) return false;
  return true;
}

function compactSeed(seed) {
  if (!seed || typeof seed !== "object") return "";
  const parts = [seed.type, seed.title || seed.name || seed.id].filter(Boolean);
  return parts.join(":");
}

function isGenericIntro(text) {
  const lower = cleanText(text).toLowerCase();
  if (!lower) return true;
  if (/it gives the intro a real image|station focused while still giving the song its own small story/.test(lower)) {
    return true;
  }
  const genericPatterns = [
    /fits? (the|this) (mood|vibe|moment|set)/,
    /without (stealing|taking|pulling) (too much )?focus/,
    /clear melody/,
    /nice vibe/,
    /great song/,
    /perfect for (now|tonight|this moment)/,
    /sets? the tone/,
    /brings? (a|the) mood/
  ];
  const hasSpecificAnchor = /"[^"]{6,}"|\b(19|20)\d{2}\b|\balbum\b|\blyric\b|\bfrom\b.+\bby\b/i.test(text);
  return genericPatterns.some((pattern) => pattern.test(lower)) && !hasSpecificAnchor;
}

const BAD_LYRIC_TEXT_PATTERN = /(?:\berror\b|\bfailed\b|\bfailure\b|\bunavailable\b|\bundefined\b|\bnull\b|\bexception\b|\brequest\b|\bnot found\b|\btimeout\b|\bnetwork\b|\bcopyright\b|\binstrumental\b|\bcomposer\b|\blyricist\b|\blyrics by\b|\barranger\b|\bproducer\b|\brecording\b|\bmix(?:ed)? by\b|\bmaster(?:ed)? by\b|\bvocal\b|\bguitar\b|\bbass\b|\bdrums\b|\bpiano\b|\bviolin\b|\bviola\b|\bcello\b|\bstrings\b|\bdistributed by\b|无法|失敗|失败|錯誤|错误|報錯|报错|獲取|获取|暂无|作词|作詞|作曲|编曲|編曲|制作人|監製|监制|出品|发行|發行|纯音乐|純音樂|音乐总监|音樂總監|舞台总监|舞台總監|音响总监|音響總監|高级音乐顾问|高級音樂顧問|原唱|录音|錄音|混音|母带|母帶|OP|SP|ISRC|℗|©)/i;

function yearFromTrack(track = {}) {
  const value = track.publishTime || track.publish_time || track.publish_date || track.year || "";
  if (Number.isFinite(value) && value > 0) return new Date(value).getFullYear().toString();
  const match = String(value).match(/\b(19|20)\d{2}\b/);
  return match?.[0] || "";
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === null || item === undefined || item === "") return false;
      if (Array.isArray(item) && item.length === 0) return false;
      return true;
    })
  );
}

function isCantoneseTrack(track = {}) {
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
  if (/(粤|粵|廣東|广东|cantonese|cantopop|\(yue\)|（粤）|（粵）|粤语|粵語)/i.test(text)) return true;
  const cantoneseArtists = [
    "陈奕迅", "陳奕迅", "eason chan", "张敬轩", "張敬軒", "hins cheung",
    "谢安琪", "謝安琪", "kay tse", "容祖儿", "容祖兒", "joey yung",
    "杨千嬅", "楊千嬅", "miriam yeung", "郑秀文", "鄭秀文", "sammi cheng",
    "王菲", "faye wong", "林忆莲", "林憶蓮", "sandy lam", "卢巧音", "盧巧音",
    "卫兰", "衛蘭", "janice vidal", "麦浚龙", "麥浚龍", "juno mak",
    "方皓玟", "charmaine fong", "my little airport", "dear jane", "rubberband",
    "古巨基", "leo ku", "张学友", "張學友", "jacky cheung", "林家谦", "林家謙",
    "terence lam", "陈柏宇", "陳柏宇", "jason chan", "薛凯琪", "薛凱琪",
    "周柏豪", "pakho chau", "林二汶", "at17", "twins", "beyond", "黄耀明", "黃耀明"
  ];
  if (cantoneseArtists.some((artist) => text.includes(artist.toLowerCase()))) return true;
  const traditionalOrCantoneseChars = text.match(/[嘅咗佢哋唔啲喺冇嚟嚿嗰俾畀諗睇聽講會愛無裡裏風開點]/g) || [];
  return traditionalOrCantoneseChars.length >= 2;
}
