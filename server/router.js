const musicWords = ["播放", "来一首", "听", "歌", "音乐", "下一首", "上一首", "上一曲", "暂停", "继续", "推荐"];
const controlWords = ["暂停", "继续", "下一首", "上一首", "上一曲", "音量"];

export function routeIntent(input = "", trigger = "user") {
  const text = String(input).trim();
  if (trigger !== "user") {
    return { type: "agent", module: "scheduler", trigger, confidence: 1 };
  }
  if (!text) {
    return { type: "agent", module: "agent", trigger, confidence: 0.5 };
  }
  if (controlWords.some((word) => text.includes(word))) {
    if (text.includes("暂停")) return { type: "control", action: "pause", trigger, confidence: 0.95 };
    if (text.includes("下一首")) return { type: "control", action: "next", trigger, confidence: 0.95 };
    if (text.includes("上一首") || text.includes("上一曲")) return { type: "control", action: "previous", trigger, confidence: 0.95 };
    return { type: "control", action: "play", trigger, confidence: 0.75 };
  }
  if (musicWords.some((word) => text.includes(word))) {
    return { type: "music", module: "ncm", trigger, confidence: 0.85 };
  }
  return { type: "agent", module: "agent", trigger, confidence: 0.75 };
}
