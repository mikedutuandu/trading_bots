import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { binance } from "./binance.js";

/**
 * Binance USDT-M Futures user-data stream: listenKey lifecycle + keepalive + a
 * reconnecting WebSocket. The 1h engine reconciles authoritative state via REST
 * each candle, so this stream is a low-latency *supplement* — it surfaces fills
 * and account updates between ticks (and keeps the listenKey alive). It never
 * needs to be running for the engine to be correct.
 */

interface OrderTradeUpdate {
  e: "ORDER_TRADE_UPDATE";
  o: {
    s: string; // symbol
    x: string; // execution type (NEW, TRADE, CANCELED, EXPIRED…)
    X: string; // order status (NEW, FILLED, PARTIALLY_FILLED…)
    S: string; // side
    L: string; // last filled price
    l: string; // last filled qty
    rp: string; // realized pnl
    ot: string; // original order type
  };
}

type UserEvent =
  | OrderTradeUpdate
  | { e: "ACCOUNT_UPDATE"; a: unknown }
  | { e: "listenKeyExpired" }
  | { e: string; [k: string]: unknown };

const KEEPALIVE_MS = 30 * 60 * 1000; // Binance expires a listenKey after 60m; refresh at 30m.

export class UserDataStream {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly wsUrl: string;
  private onFill?: (symbol: string, price: number, qty: number, realizedPnl: number) => void;

  constructor(opts: { wsUrl?: string; onFill?: UserDataStream["onFill"] } = {}) {
    this.wsUrl = opts.wsUrl ?? config.binance.wsUrl;
    this.onFill = opts.onFill;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const { listenKey } = await binance.keyedPost<{ listenKey: string }>("/fapi/v1/listenKey");
    this.listenKey = listenKey;
    this.connect();
    this.keepaliveTimer = setInterval(() => void this.keepalive(), KEEPALIVE_MS);
    logger.info("user-data stream started");
  }

  private connect(): void {
    if (!this.listenKey) return;
    const url = `${this.wsUrl}/ws/${this.listenKey}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("message", (raw) => {
      try {
        const ev = JSON.parse(raw.toString()) as UserEvent;
        this.handle(ev);
      } catch (err) {
        logger.warn("user-stream parse error:", err);
      }
    });
    ws.on("error", (err) => logger.warn("user-stream ws error:", err));
    ws.on("close", () => {
      if (this.stopped) return;
      logger.warn("user-stream closed; reconnecting in 2s");
      setTimeout(() => this.reopen(), 2000);
    });
  }

  private async reopen(): Promise<void> {
    if (this.stopped) return;
    try {
      const { listenKey } = await binance.keyedPost<{ listenKey: string }>("/fapi/v1/listenKey");
      this.listenKey = listenKey;
    } catch (err) {
      logger.warn("user-stream listenKey refresh failed:", err);
    }
    this.connect();
  }

  private handle(ev: UserEvent): void {
    if (ev.e === "listenKeyExpired") {
      logger.warn("listenKey expired; reopening");
      void this.reopen();
      return;
    }
    if (ev.e === "ORDER_TRADE_UPDATE") {
      const o = (ev as OrderTradeUpdate).o;
      if (o.x === "TRADE") {
        const price = Number(o.L);
        const qty = Number(o.l);
        logger.debug(`fill ${o.s} ${o.S} ${qty} @ ${price} (rp ${o.rp})`);
        this.onFill?.(o.s, price, qty, Number(o.rp));
      }
    }
  }

  private async keepalive(): Promise<void> {
    try {
      await binance.keyedPut("/fapi/v1/listenKey");
      logger.debug("listenKey kept alive");
    } catch (err) {
      logger.warn("listenKey keepalive failed:", err);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.ws?.close();
    try {
      if (this.listenKey) await binance.keyedDelete("/fapi/v1/listenKey");
    } catch {
      /* best-effort */
    }
    logger.info("user-data stream stopped");
  }
}
