import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvFile(path.join(root, ".env"));

const legacyStepApiKey = process.env.STEP_API_KEY || process.env.STEPFUN_API_KEY || "";
const legacyFishApiKey = process.env.FISH_API_KEY || "";
const legacyStepUrl = process.env.STEP_TTS_BASE_URL || (legacyStepApiKey ? "https://api.stepfun.com/v1/audio/speech" : "");
const legacyFishUrl = process.env.FISH_BASE_URL || (legacyFishApiKey ? "https://api.fish.audio/v1/tts" : "");
const ttsVoiceId = process.env.TTS_VOICE_ID || process.env.STEP_TTS_VOICE || process.env.FISH_VOICE_ID || "";

export const config = {
  root,
  port: Number(process.env.PORT || 8080),
  publicDir: path.join(root, "public"),
  statePath: path.join(root, "state.db"),
  ttsCacheDir: path.join(root, "cache", "tts"),
  promptsDir: path.join(root, "prompts"),
  userDir: path.join(root, "user"),
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || "",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "local-agent"
  },
  ncm: {
    baseUrl: process.env.NCM_BASE_URL || ""
  },
  tts: {
    url: process.env.TTS_URL || legacyStepUrl || legacyFishUrl,
    apiKey: process.env.TTS_API_KEY || legacyStepApiKey || legacyFishApiKey,
    modelId: process.env.TTS_MODEL_ID || process.env.STEP_TTS_MODEL || process.env.FISH_MODEL || "",
    voiceId: ttsVoiceId,
    englishMaleVoiceId: process.env.TTS_EN_MALE_VOICE_ID || process.env.STEP_TTS_EN_MALE_VOICE || process.env.FISH_EN_MALE_VOICE_ID || ttsVoiceId,
    cantoneseFemaleVoiceId: process.env.TTS_YUE_FEMALE_VOICE_ID || process.env.STEP_TTS_YUE_FEMALE_VOICE || process.env.FISH_YUE_FEMALE_VOICE_ID || ttsVoiceId
  }
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
