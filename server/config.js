import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
loadEnvFile(envPath);

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

const settingFields = [
  { key: "OPENAI_BASE_URL", path: ["openai", "baseUrl"], secret: false },
  { key: "OPENAI_API_KEY", path: ["openai", "apiKey"], secret: true },
  { key: "OPENAI_MODEL", path: ["openai", "model"], secret: false },
  { key: "TTS_URL", path: ["tts", "url"], secret: false },
  { key: "TTS_API_KEY", path: ["tts", "apiKey"], secret: true },
  { key: "TTS_MODEL_ID", path: ["tts", "modelId"], secret: false },
  { key: "TTS_VOICE_ID", path: ["tts", "voiceId"], secret: false },
  { key: "TTS_EN_MALE_VOICE_ID", path: ["tts", "englishMaleVoiceId"], secret: false },
  { key: "TTS_YUE_FEMALE_VOICE_ID", path: ["tts", "cantoneseFemaleVoiceId"], secret: false },
  { key: "NCM_BASE_URL", path: ["ncm", "baseUrl"], secret: false }
];

export function readRuntimeSettings() {
  return {
    openai: {
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      apiKey: secretState(config.openai.apiKey)
    },
    tts: {
      url: config.tts.url,
      provider: inferTtsProvider(config.tts.url),
      modelId: config.tts.modelId,
      voiceId: config.tts.voiceId,
      englishMaleVoiceId: config.tts.englishMaleVoiceId,
      cantoneseFemaleVoiceId: config.tts.cantoneseFemaleVoiceId,
      apiKey: secretState(config.tts.apiKey)
    },
    ncm: {
      baseUrl: config.ncm.baseUrl,
      configured: Boolean(config.ncm.baseUrl)
    }
  };
}

export function saveRuntimeSettings(input = {}) {
  const updates = {};
  const values = flattenSettings(input);
  for (const field of settingFields) {
    if (!Object.hasOwn(values, field.key) || values[field.key] === undefined) continue;
    const value = sanitizeEnvValue(values[field.key]);
    if (field.secret && !value) continue;
    updates[field.key] = value;
  }
  writeEnvFile(envPath, updates);
  for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  applyRuntimeConfig();
  return readRuntimeSettings();
}

function applyRuntimeConfig() {
  config.openai.baseUrl = process.env.OPENAI_BASE_URL || "";
  config.openai.apiKey = process.env.OPENAI_API_KEY || "";
  config.openai.model = process.env.OPENAI_MODEL || "local-agent";
  config.ncm.baseUrl = process.env.NCM_BASE_URL || "";
  config.tts.url = process.env.TTS_URL || legacyStepUrl || legacyFishUrl;
  config.tts.apiKey = process.env.TTS_API_KEY || legacyStepApiKey || legacyFishApiKey;
  config.tts.modelId = process.env.TTS_MODEL_ID || process.env.STEP_TTS_MODEL || process.env.FISH_MODEL || "";
  config.tts.voiceId = process.env.TTS_VOICE_ID || process.env.STEP_TTS_VOICE || process.env.FISH_VOICE_ID || "";
  config.tts.englishMaleVoiceId = process.env.TTS_EN_MALE_VOICE_ID || process.env.STEP_TTS_EN_MALE_VOICE || process.env.FISH_EN_MALE_VOICE_ID || config.tts.voiceId;
  config.tts.cantoneseFemaleVoiceId = process.env.TTS_YUE_FEMALE_VOICE_ID || process.env.STEP_TTS_YUE_FEMALE_VOICE || process.env.FISH_YUE_FEMALE_VOICE_ID || config.tts.voiceId;
}

function flattenSettings(input) {
  return {
    OPENAI_BASE_URL: input.openai?.baseUrl,
    OPENAI_API_KEY: input.openai?.apiKey,
    OPENAI_MODEL: input.openai?.model,
    TTS_URL: input.tts?.url,
    TTS_API_KEY: input.tts?.apiKey,
    TTS_MODEL_ID: input.tts?.modelId,
    TTS_VOICE_ID: input.tts?.voiceId,
    TTS_EN_MALE_VOICE_ID: input.tts?.englishMaleVoiceId,
    TTS_YUE_FEMALE_VOICE_ID: input.tts?.cantoneseFemaleVoiceId,
    NCM_BASE_URL: input.ncm?.baseUrl
  };
}

function writeEnvFile(filePath, updates) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !Object.hasOwn(updates, match[1])) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const key of Object.keys(updates)) {
    if (!seen.has(key)) nextLines.push(`${key}=${updates[key]}`);
  }
  fs.writeFileSync(filePath, `${nextLines.join("\n").replace(/\n+$/, "")}\n`);
}

function sanitizeEnvValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, "").trim();
}

function secretState(value) {
  const text = String(value || "");
  return {
    configured: Boolean(text),
    last4: text ? text.slice(-4) : ""
  };
}

function inferTtsProvider(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower) return "browser";
  if (lower.includes("stepfun.com")) return "step";
  if (lower.includes("fish.audio")) return "fish";
  return "custom";
}

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
