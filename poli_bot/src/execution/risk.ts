export interface RiskLimits {
  bankrollUsd: number;
  maxOpenPositions: number;
  maxRiskPerTradeUsd: number;
  maxDailyLossUsd: number;
  maxWindowsPerDay: number;
  stopTradingAtDailyLossPct: number; // halt for the day at this drawdown fraction (e.g. 0.05 = -5%)
}

export interface RiskState {
  openPositions: number;
  dailyRealizedPnlUsd: number;
  windowsTradedToday: number;
  todayKey: string;
}

function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export class RiskManager {
  private limits: RiskLimits;
  private state: RiskState;

  constructor(limits: RiskLimits) {
    this.limits = limits;
    this.state = {
      openPositions: 0,
      dailyRealizedPnlUsd: 0,
      windowsTradedToday: 0,
      todayKey: todayKey(),
    };
  }

  private rollDayIfNeeded(): void {
    const today = todayKey();
    if (today !== this.state.todayKey) {
      this.state = { openPositions: this.state.openPositions, dailyRealizedPnlUsd: 0, windowsTradedToday: 0, todayKey: today };
    }
  }

  canOpen(intendedRiskUsd: number): { ok: boolean; reason?: string } {
    this.rollDayIfNeeded();
    if (this.state.openPositions >= this.limits.maxOpenPositions) {
      return { ok: false, reason: "max open positions reached" };
    }
    if (intendedRiskUsd > this.limits.maxRiskPerTradeUsd) {
      return { ok: false, reason: `risk ${intendedRiskUsd.toFixed(2)} > limit ${this.limits.maxRiskPerTradeUsd}` };
    }
    if (this.state.windowsTradedToday >= this.limits.maxWindowsPerDay) {
      return { ok: false, reason: "max windows per day reached" };
    }
    const lossLimit = this.limits.bankrollUsd * this.limits.stopTradingAtDailyLossPct;
    if (-this.state.dailyRealizedPnlUsd >= lossLimit) {
      return { ok: false, reason: `daily loss limit hit (${this.state.dailyRealizedPnlUsd.toFixed(2)})` };
    }
    if (-this.state.dailyRealizedPnlUsd >= this.limits.maxDailyLossUsd) {
      return { ok: false, reason: `max daily loss hit (${this.state.dailyRealizedPnlUsd.toFixed(2)})` };
    }
    return { ok: true };
  }

  onOpen(): void {
    this.rollDayIfNeeded();
    this.state.openPositions += 1;
    this.state.windowsTradedToday += 1;
  }

  onClose(realizedPnlUsd: number): void {
    this.rollDayIfNeeded();
    this.state.openPositions = Math.max(0, this.state.openPositions - 1);
    this.state.dailyRealizedPnlUsd += realizedPnlUsd;
  }

  snapshot(): Readonly<RiskState> {
    this.rollDayIfNeeded();
    return { ...this.state };
  }
}
