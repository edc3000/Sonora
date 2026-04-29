export class RadioScheduler {
  constructor({ runShow, broadcast }) {
    this.runShow = runShow;
    this.broadcast = broadcast;
    this.timers = [];
  }

  start() {
    this.planDay();
    this.timers.push(setInterval(() => this.checkHourlyMood(), 60 * 60 * 1000));
    this.timers.push(setInterval(() => this.planDay(), 24 * 60 * 60 * 1000));
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  planDay() {
    const plan = [
      { time: "07:00", title: "Morning open", mood: "clear", status: "planned" },
      { time: "09:00", title: "Work flow", mood: "focused", status: "planned" },
      { time: "14:00", title: "Afternoon pulse", mood: "steady", status: "planned" },
      { time: "21:30", title: "Night landing", mood: "soft", status: "planned" }
    ];
    this.broadcast("plan-updated", { plan });
    return plan;
  }

  checkHourlyMood() {
    this.broadcast("host-speaking", {
      say: "Hourly mood check: I will keep the sound uncluttered so the rhythm stays workable."
    });
  }
}
