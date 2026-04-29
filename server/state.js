import crypto from "node:crypto";
import fs from "node:fs/promises";

const initialState = {
  messages: [],
  plays: [],
  plan: [],
  prefs: {
    volume: 72,
    hostEnabled: true,
    provider: "auto",
    mood: "focused"
  },
  now: {
    status: "idle",
    host: "",
    reason: "",
    segue: "",
    track: null,
    queue: [],
    history: [],
    progress: 0,
    volume: 72,
    ttsUrl: "",
    ttsProvider: "",
    ttsError: ""
  }
};

export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = structuredClone(initialState);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      this.state = { ...structuredClone(initialState), ...(raw.trim() ? JSON.parse(raw) : {}) };
      this.state.now = { ...structuredClone(initialState).now, ...(this.state.now || {}) };
      this.state.prefs = { ...structuredClone(initialState).prefs, ...(this.state.prefs || {}) };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await this.save();
    }
    return this.state;
  }

  get snapshot() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const next = mutator(this.state) || this.state;
    this.state = next;
    await this.save();
    return this.snapshot;
  }

  async save() {
    const body = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(() => fs.writeFile(this.filePath, body));
    return this.writeQueue;
  }

  async appendMessage(message) {
    return this.update((state) => {
      state.messages.unshift({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        ...message
      });
      state.messages = state.messages.slice(0, 80);
      return state;
    });
  }

  async recordPlay(track) {
    return this.update((state) => {
      state.plays.unshift({
        id: crypto.randomUUID(),
        playedAt: new Date().toISOString(),
        title: track?.title || "Unknown",
        artist: track?.artist || "Unknown"
      });
      state.plays = state.plays.slice(0, 120);
      return state;
    });
  }
}
