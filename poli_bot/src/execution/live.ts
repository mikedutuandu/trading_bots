import { AssetType, Chain, ClobClient, OrderType, Side as SdkSide, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { logger } from "../logger.js";
import { config } from "../config.js";
import type { Side } from "../types.js";

export type TickSize = "0.1" | "0.01" | "0.001" | "0.0001";

export function pickSignatureType(name: string): SignatureTypeV2 {
  const k = name.toUpperCase();
  if (k === "EOA") return SignatureTypeV2.EOA;
  if (k === "POLY_PROXY") return SignatureTypeV2.POLY_PROXY;
  if (k === "POLY_GNOSIS_SAFE") return SignatureTypeV2.POLY_GNOSIS_SAFE;
  if (k === "POLY_1271") return SignatureTypeV2.POLY_1271;
  throw new Error(`Unknown LIVE_SIGNATURE_TYPE: ${name}`);
}

export async function createAuthenticatedClobClient(opts: {
  privateKey: string;
  host: string;
  signatureType: SignatureTypeV2;
  funderAddress?: string;
}): Promise<{ client: ClobClient; address: `0x${string}` }> {
  const account = privateKeyToAccount(opts.privateKey as `0x${string}`);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  const bootstrap = new ClobClient({
    host: opts.host, chain: Chain.POLYGON, signer: walletClient,
    signatureType: opts.signatureType, funderAddress: opts.funderAddress,
  });
  const creds = await bootstrap.createOrDeriveApiKey();
  const client = new ClobClient({
    host: opts.host, chain: Chain.POLYGON, signer: walletClient, creds,
    signatureType: opts.signatureType, funderAddress: opts.funderAddress,
  });
  return { client, address: account.address };
}

export interface LiveOrderArgs {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  tickSize?: TickSize;
}

export interface LiveOrderResult {
  ok: boolean;
  orderId?: string;
  raw?: unknown;
  error?: string;
}

export interface BalanceSnapshot {
  collateralBalanceUsd: number;
  collateralAllowances: Record<string, string>;
}

export class LiveTrader {
  private client: ClobClient | null = null;
  private accountAddress: `0x${string}` | null = null;
  private dryRun = true;
  private initialized = false;

  async init(): Promise<boolean> {
    if (this.initialized) return true;
    const pk = config.polymarket.privateKey;
    if (!pk) {
      logger.warn("LiveTrader: POLYMARKET_PRIVATE_KEY not set — staying in DRY_RUN, no live calls possible");
      return false;
    }
    const signatureType = pickSignatureType(config.live.signatureType);
    const funderAddress = config.polymarket.funder || undefined;
    logger.info("LiveTrader: connecting to Polymarket CLOB...", {
      host: config.polymarket.clobUrl,
      eoaAddress: privateKeyToAccount(pk as `0x${string}`).address,
      funderAddress: funderAddress ?? "(none — using EOA as funder)",
      signatureType: config.live.signatureType,
    });
    const { client, address } = await createAuthenticatedClobClient({
      privateKey: pk,
      host: config.polymarket.clobUrl,
      signatureType,
      funderAddress,
    });
    this.client = client;
    this.accountAddress = address;
    this.dryRun = config.live.dryRun;
    this.initialized = true;
    logger.info("LiveTrader: connected", { dryRun: this.dryRun, address });
    return true;
  }

  async getCollateralBalance(): Promise<BalanceSnapshot> {
    if (!this.client) throw new Error("LiveTrader not initialized — call init() first");
    const resp = await this.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return {
      collateralBalanceUsd: Number(resp.balance) / 1_000_000,
      collateralAllowances: resp.allowances,
    };
  }

  async ensureCollateralAllowance(): Promise<void> {
    if (!this.client) throw new Error("LiveTrader not initialized");
    logger.info("LiveTrader: updating pUSD allowance...");
    await this.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    logger.info("LiveTrader: pUSD allowance set");
  }

  setDryRun(value: boolean): void {
    this.dryRun = value;
    logger.warn(`LiveTrader DRY_RUN = ${value}`);
  }

  isDryRun(): boolean { return this.dryRun; }
  isInitialized(): boolean { return this.initialized; }
  getAddress(): string | null { return this.accountAddress; }

  async placeBuy(args: LiveOrderArgs): Promise<LiveOrderResult> {
    if (!this.client) return { ok: false, error: "LiveTrader not initialized" };
    if (args.size < 5) return { ok: false, error: `size ${args.size} below Polymarket min (5)` };
    if (this.dryRun) {
      logger.info("[DRY_RUN] would place BUY", args);
      return { ok: true, orderId: `dry-${Date.now()}` };
    }
    try {
      const resp = await this.client.createAndPostOrder(
        { tokenID: args.tokenId, price: args.price, side: SdkSide.BUY, size: args.size },
        { tickSize: args.tickSize ?? "0.01" },
        OrderType.GTC,
      );
      const r = resp as { success?: boolean; errorMsg?: string; orderID?: string; status?: string | number; error?: string } | undefined;
      const httpStatus = typeof r?.status === "number" ? r.status : typeof r?.status === "string" ? Number(r.status) : 0;
      const isError = r?.success === false || !!r?.error || (httpStatus >= 400);
      if (isError) {
        const msg = r?.errorMsg ?? r?.error ?? `HTTP ${httpStatus}`;
        logger.error("LIVE BUY rejected", { errorMsg: msg, status: r?.status, side: args.side, price: args.price, size: args.size });
        return { ok: false, error: msg, raw: resp };
      }
      const orderId = r?.orderID;
      if (!orderId) {
        logger.error("LIVE BUY response missing orderID — treating as failure:", resp);
        return { ok: false, error: "no orderID in response", raw: resp };
      }
      logger.info("LIVE BUY placed", { orderId, status: r?.status, side: args.side, price: args.price, size: args.size });
      return { ok: true, orderId, raw: resp };
    } catch (err) {
      const error = (err as Error).message;
      logger.error("LIVE BUY threw exception", error);
      return { ok: false, error };
    }
  }

  async getOrder(orderId: string): Promise<unknown> {
    if (!this.client) throw new Error("LiveTrader not initialized");
    return this.client.getOrder(orderId);
  }

  async getTradesForMarket(marketConditionId: string): Promise<unknown[]> {
    if (!this.client) throw new Error("LiveTrader not initialized");
    return (await this.client.getTrades({ market: marketConditionId })) as unknown[];
  }

  /** Resting (open) orders for a given outcome token. Used to reconcile reserved-but-unconfirmed rows. */
  async getOpenOrdersForToken(tokenId: string): Promise<Array<{ id: string; asset_id: string; side: string; size_matched: string; original_size: string; price: string }>> {
    if (!this.client) throw new Error("LiveTrader not initialized");
    return (await this.client.getOpenOrders({ asset_id: tokenId })) as Array<{ id: string; asset_id: string; side: string; size_matched: string; original_size: string; price: string }>;
  }
}
