export const INTRO_PERSONA_VERSION = "v2-late-night-2026-05-18";

export function introForTrack(track, { index = 0, reason = "" } = {}) {
  return buildStoryLinkedIntro(track, { index, reason });
}

export function selectIntroForTrack(track, { index = 0, reason = "" } = {}) {
  const existing = cleanText(track?.intro);
  const langMismatch = existing && hasLanguageMismatch(track, existing);
  if (existing && !langMismatch && !isGenericIntro(existing)) return existing.slice(0, 500);
  return buildStoryLinkedIntro(track, { index, reason });
}

function hasLanguageMismatch(track, intro) {
  const lang = detectLanguage(track);
  if (lang === "en") return false;
  const cjk = (intro.match(/[一-鿿]/g) || []).length;
  const latin = (intro.match(/[A-Za-z]/g) || []).length;
  const totalLetters = cjk + latin;
  if (!totalLetters) return false;
  return latin / totalLetters >= 0.5;
}

export function buildStoryLinkedIntro(track, { index = 0, reason = "" } = {}) {
  if (!track?.title) return "";
  const lang = detectLanguage(track);
  if (lang === "yue" || lang === "zh") return buildChineseIntro(track, { index, reason });
  return buildEnglishIntro(track, { index, reason });
}

function buildEnglishIntro(track, { index, reason }) {
  const title = track.title;
  const artist = track.artist || "this artist";
  const opening = index === 0
    ? `Opening with ${title} by ${artist}.`
    : `Next: ${title} by ${artist}.`;
  const story = compactTrackStory(track);
  const middle = storySummary(track, story);
  const closing = setFitLine(track, { reason });
  return `${opening} ${middle} ${closing}`.replace(/\s+/g, " ").trim().slice(0, 600);
}

function buildChineseIntro(track, { index, reason }) {
  const title = track.title;
  const artist = track.artist || "这位歌手";
  const opening = index === 0
    ? `开场：${artist} 的《${title}》。`
    : `下一首：${artist}《${title}》。`;
  const story = compactTrackStory(track);
  const middle = storySummaryZh(track, story);
  const closing = setFitLineZh(track, { reason });
  return `${opening}${middle}${closing}`.replace(/\s+/g, " ").trim().slice(0, 360);
}

function pickHookIndex(track, modulo) {
  const key = String(track.id || `${track.title || ""}::${track.artist || ""}`);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash % Math.max(1, modulo);
}


function storySummaryZh(track, story) {
  const record = [story.album, story.year].filter(Boolean).join("·");
  const hook = pickHookIndex(track, 3);
  if (story.lyricQuote && record) {
    const variants = [
      `出自《${record}》，开头一句"${story.lyricQuote}"，先把画面立起来。`,
      `《${record}》里的这首，从"${story.lyricQuote}"开口，剩下几分钟你会自己接住。`,
      `《${record}》——它的第一句是"${story.lyricQuote}"。`
    ];
    return variants[hook];
  }
  if (story.lyricQuote) {
    const variants = [
      `它一开口就是"${story.lyricQuote}"。`,
      `第一句"${story.lyricQuote}"，画面先于旋律落下。`,
      `从"${story.lyricQuote}"那一句开始听。`
    ];
    return variants[hook];
  }
  if (record) {
    const variants = [
      `这首出自《${record}》。`,
      `《${record}》里的歌，那年的录音质感你会认出来。`,
      `《${record}》——把它放在这个钟点。`
    ];
    return variants[hook];
  }
  if (story.reasons?.length) {
    const cleanReason = story.reasons[0].replace(/similar to liked song:|liked-song seed|familiar liked-song seed/i, "").trim();
    if (cleanReason) return `它是顺着你以前听过的 ${cleanReason} 那条线摸过来的。`;
  }
  return "";
}

function setFitLineZh(track, { reason = "" } = {}) {
  const story = compactTrackStory(track);
  const reasonText = cleanText(reason) || story.reasons?.[0] || "";
  if (/similar to liked song:/i.test(reasonText)) {
    const seed = reasonText.replace(/.*similar to liked song:\s*/i, "").trim();
    if (seed) return ` 这首是顺着你以前听 ${seed} 那条线接过来的。`;
  }
  if (/liked-song seed|familiar liked-song seed/i.test(reasonText)) {
    return " 它已经在你的播放记忆里。";
  }
  return "";
}

function knownArtistStoryZh(track, lang) {
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`.toLowerCase();
  if (/陈奕迅|陳奕迅|eason/.test(text)) {
    return "Eason 唱这类歌不靠音量，他靠咬字的停顿——总有一两个字他故意让它欲言又止。";
  }
  if (/周柏豪|pakho/.test(text) && /卫兰|衛蘭|janice/.test(text)) {
    return "Pakho 和卫兰的对唱从来不抢戏，两个人都在收着，留白比情绪本身更动人。";
  }
  if (/周柏豪|pakho/.test(text)) {
    return "周柏豪最稳的那种深夜粤语情歌，把感情按在水面下，但浮力一直在。";
  }
  if (/容祖儿|容祖兒|joey/.test(text)) {
    return "容祖儿的版本永远干净利落，副歌不靠喊，靠咬住那个稳定的中音。";
  }
  if (/杨千嬅|楊千嬅|miriam/.test(text)) {
    return "杨千嬅那种直接、带伤但不卖伤的港乐性格，旋律一进来你就会认得。";
  }
  if (/张敬轩|張敬軒|hins/.test(text)) {
    return "张敬轩在这种歌里最像一个真正的歌手——克制、精准，但情绪始终在出口处。";
  }
  if (/林家谦|林家謙|terence lam/.test(text)) {
    return "林家谦的写法很私人，钢琴几个音先把房间安静下来，他再开口。";
  }
  if (/陈柏宇|陳柏宇|jason chan/.test(text)) {
    return "陈柏宇这几年的歌都在练'轻'，不靠技巧炫，靠把一句话说得像第一次说。";
  }
  if (/dear jane|rubberband|beyond/.test(text)) {
    return "香港 band sound 的脉络，吉他承担的情绪和人声一样多。";
  }
  if (/my little airport/.test(text)) {
    return "My Little Airport 那种近乎日常的录音质感，像在很近的地方录的，没修过。";
  }
  if (/李志/.test(text)) {
    return "李志用一把不算亮的吉他和一个干净的人声，把没什么戏剧性的事讲得别人也听过。";
  }
  if (/周杰伦|周杰倫|jay chou/.test(text)) {
    return "周杰伦把华语流行重新写了一遍那几张专辑里的歌——和声排布和节奏断点至今都还有人在抄。";
  }
  if (/陈绮贞|陳綺貞|cheer chen/.test(text)) {
    return "陈绮贞的吉他和人声基本是同一种材质，所以这首听起来像她自己写给自己听的版本。";
  }
  if (/林俊杰|林俊傑|jj lin/.test(text)) {
    return "JJ 的强项一向是把流行歌的旋律编得不流行——你会被某个转折抓住。";
  }
  if (lang === "yue" || isCantoneseTrack(track)) {
    return "粤语流行歌里那种把私人情绪压到很轻的写法，配在这个时段刚好。";
  }
  return "";
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
  const record = [story.album, story.year].filter(Boolean).join(", ");
  if (story.lyricQuote && record) {
    return `From ${record}, it opens on "${story.lyricQuote}," giving the next few minutes a concrete image.`;
  }
  if (story.lyricQuote) {
    return `The first image is "${story.lyricQuote}," so the song enters with a clear scene.`;
  }
  if (record) {
    return `From ${record}, with the room cues that recording gives.`;
  }
  if (story.reasons?.length) {
    return `It came through ${story.reasons[0]}, so the handoff starts from a real listening trail.`;
  }
  return "";
}

function setFitLine(track, { reason = "" } = {}) {
  const story = compactTrackStory(track);
  const reasonText = cleanText(reason) || story.reasons?.[0] || "";
  if (/similar to liked song:/i.test(reasonText)) {
    const seed = reasonText.replace(/.*similar to liked song:\s*/i, "").trim();
    if (seed) return `Pulled from your listening trail through ${seed}.`;
  }
  if (/liked-song seed|familiar liked-song seed/i.test(reasonText)) {
    return "Already in your library.";
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
  const raw = cleanText(value);
  // 在剥离角色前缀前先检测原始文本里的 metadata 关键词（作词/作曲/制作 等），
  // 避免 "作词：Someone" 被剥离成 "Someone" 后绕过 BAD_LYRIC_TEXT_PATTERN 过滤
  if (BAD_LYRIC_TEXT_PATTERN.test(raw)) return "";
  // 对唱/分声部角色前缀：1-5 个中英文字符 + 冒号
  // 覆盖 "A:" / "合:" / "男:" / "陈:" / "祖儿:" / "Eason:" 等
  return raw
    .replace(/^[一-鿿A-Za-z]{1,5}\s*[:：]\s*/, "")
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
  const hasSpecificAnchor = /"[^"]{6,}"|"[^"]{4,}"|\b(19|20)\d{2}\b|\balbum\b|\blyric\b|\bfrom\b.+\bby\b|专辑|專輯|歌词|歌詞|出自|《[^》]+》/i.test(text);
  return genericPatterns.some((pattern) => pattern.test(lower)) && !hasSpecificAnchor;
}

export function detectLanguage(track = {}) {
  if (isCantoneseTrack(track)) return "yue";
  const text = `${track.title || ""} ${track.artist || ""} ${track.album || ""}`;
  const cjk = text.match(/[一-鿿]/g) || [];
  const latin = text.match(/[A-Za-z]/g) || [];
  if (cjk.length >= 2 && cjk.length >= latin.length / 2) return "zh";
  return "en";
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
