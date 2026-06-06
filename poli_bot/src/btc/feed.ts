import type { BtcPriceTick } from "../types.js";

export type PriceTickListener = (tick: BtcPriceTick) => void;

export interface BtcPriceFeed {
  start(): void;
  stop(): void;
  onTick(fn: PriceTickListener): () => void;
  getLast(): BtcPriceTick;
}
