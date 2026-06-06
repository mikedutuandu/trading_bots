import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { BtcPriceTick } from "../types.js";
import type { BtcPriceFeed, PriceTickListener } from "./feed.js";

/**
 * BTC/USD price feed via Polymarket's Real-Time Data Socket (RTDS).
 * Routes the same Chainlink BTC/USD price that Polymarket uses for resolution,
 * eliminating source-basis errors between our model and the market outcome.
 *
 * Endpoint:        wss://ws-live-data.polymarket.com
 * Topic:           crypto_prices_chainlink
 * Filter:          {"symbol":"btc/usd"}
 * Keepalive:       PING every 5s
 * Auth required:   no
 */
export class ChainlinkBtcFeed implements BtcPriceFeed {
  private ws: WebSocket | null = null;
  private listeners = new Set<PriceTickListener>();
  private lastTrade: BtcPriceTick = { ts: 0, price: 0 };
  private reconnectAttempts = 0;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;

  start(): void { this.connect(); }

  stop(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  onTick(fn: PriceTickListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getLast(): BtcPriceTick { return this.lastTrade; }

  private connect(): void {
    const url = config.polymarket.rtdsUrl;
    logger.info("Chainlink RTDS WS connecting", url);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      logger.info("Chainlink RTDS WS connected");
      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: JSON.stringify({ symbol: "btc/usd" }),
        }],
      }));
      this.pingTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.send("PING");
      }, 5000);
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text === "PONG" || !text.startsWith("{")) return;
      try {
        const msg = JSON.parse(text) as {
          topic?: string;
          payload?: { symbol?: string; value?: number | string; timestamp?: number };
        };
        if (msg.topic !== "crypto_prices_chainlink" || !msg.payload) return;
        const price = Number(msg.payload.value);
        if (!Number.isFinite(price) || price <= 0) return;
        const ts = Number(msg.payload.timestamp) || Date.now();
        this.lastTrade = { ts, price };
        for (const fn of this.listeners) {
          try { fn(this.lastTrade); } catch (err) { logger.warn("listener error", err); }
        }
      } catch (err) {
        logger.warn("Chainlink RTDS WS parse error", (err as Error).message);
      }
    });

    ws.on("error", (err) => logger.warn("Chainlink RTDS WS error", err.message));

    ws.on("close", () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (this.closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts++);
      logger.warn(`Chainlink RTDS WS closed; reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });
  }
}
