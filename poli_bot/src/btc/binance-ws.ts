import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { BtcPriceTick } from "../types.js";
import type { BtcPriceFeed, PriceTickListener } from "./feed.js";

export class BinanceBtcFeed implements BtcPriceFeed {
  private ws: WebSocket | null = null;
  private listeners = new Set<PriceTickListener>();
  private lastTrade: BtcPriceTick = { ts: 0, price: 0 };
  private reconnectAttempts = 0;
  private closed = false;

  start(): void {
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  onTick(fn: PriceTickListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getLast(): BtcPriceTick {
    return this.lastTrade;
  }

  private connect(): void {
    // Combined streams: btcusdt@trade + btcusdt@bookTicker
    const url = `${config.binance.wsUrl}/btcusdt@trade/btcusdt@bookTicker`;
    logger.info("Binance WS connecting", url);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      logger.info("Binance WS connected");
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const stream = String(msg.e ?? "");
        if (stream === "trade") {
          const price = Number(msg.p);
          if (Number.isFinite(price)) {
            this.lastTrade = { ...this.lastTrade, ts: Number(msg.T) || Date.now(), price };
            this.emit();
          }
        } else if (msg.u !== undefined && msg.b !== undefined && msg.a !== undefined) {
          // bookTicker payload (no `e` field). Has b/a (bid/ask) and u (update id).
          const bid = Number(msg.b);
          const ask = Number(msg.a);
          if (Number.isFinite(bid) && Number.isFinite(ask)) {
            this.lastTrade = { ...this.lastTrade, bid, ask };
            this.emit();
          }
        }
      } catch (err) {
        logger.warn("Binance WS parse error", err);
      }
    });

    ws.on("error", (err) => logger.warn("Binance WS error", err.message));

    ws.on("close", () => {
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts++);
      logger.warn(`Binance WS closed; reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try { fn(this.lastTrade); } catch (err) { logger.warn("listener error", err); }
    }
  }
}
