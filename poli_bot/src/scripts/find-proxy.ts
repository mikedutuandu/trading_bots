import { deriveSafe, deriveProxyWallet, deriveDepositWallet } from "@polymarket/builder-relayer-client";
import { AssetType, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { privateKeyToAccount } from "viem/accounts";
import { createAuthenticatedClobClient } from "../execution/live.js";

const POLYGON_SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
const POLYGON_PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
const POLYGON_DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
const POLYGON_DEPOSIT_WALLET_IMPLEMENTATION = "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";

async function querySdkBalance(funder: string, sigType: SignatureTypeV2): Promise<number> {
  try {
    const { client } = await createAuthenticatedClobClient({
      privateKey: config.polymarket.privateKey,
      host: config.polymarket.clobUrl,
      signatureType: sigType,
      funderAddress: funder,
    });
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return Number(bal.balance) / 1_000_000;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  if (!config.polymarket.privateKey) {
    logger.error("POLYMARKET_PRIVATE_KEY not set");
    process.exit(1);
  }
  const eoa = privateKeyToAccount(config.polymarket.privateKey as `0x${string}`).address;
  const safeAddr = deriveSafe(eoa, POLYGON_SAFE_FACTORY);
  const proxyAddr = deriveProxyWallet(eoa, POLYGON_PROXY_FACTORY);
  const depositAddr = deriveDepositWallet(eoa, POLYGON_DEPOSIT_WALLET_FACTORY, POLYGON_DEPOSIT_WALLET_IMPLEMENTATION);

  logger.info("EOA:", eoa);
  logger.info("Derived addresses:");
  logger.info(`  Safe   (POLY_GNOSIS_SAFE): ${safeAddr}`);
  logger.info(`  Proxy  (POLY_PROXY):       ${proxyAddr}`);
  logger.info(`  Deposit Wallet (POLY_1271): ${depositAddr}`);
  logger.info("Querying balance via Polymarket SDK for each combo (parallel)...");

  const combos: Array<{ funder: string; sig: SignatureTypeV2; label: string }> = [
    { funder: eoa, sig: SignatureTypeV2.EOA, label: "EOA / EOA          " },
    { funder: safeAddr, sig: SignatureTypeV2.POLY_GNOSIS_SAFE, label: "POLY_GNOSIS_SAFE   " },
    { funder: proxyAddr, sig: SignatureTypeV2.POLY_PROXY, label: "POLY_PROXY         " },
    { funder: depositAddr, sig: SignatureTypeV2.POLY_1271, label: "POLY_1271 / Deposit" },
  ];
  const balances = await Promise.all(combos.map((c) => querySdkBalance(c.funder, c.sig)));
  for (let i = 0; i < combos.length; i++) {
    logger.info(`  ${combos[i]!.label} → $${balances[i]!.toFixed(2)}`);
  }

  const sigNames: Record<number, string> = {
    [SignatureTypeV2.EOA]: "EOA",
    [SignatureTypeV2.POLY_GNOSIS_SAFE]: "POLY_GNOSIS_SAFE",
    [SignatureTypeV2.POLY_PROXY]: "POLY_PROXY",
    [SignatureTypeV2.POLY_1271]: "POLY_1271",
  };
  const ranked = combos
    .map((c, i) => ({ ...c, val: balances[i]! }))
    .sort((a, b) => b.val - a.val);
  const winner = ranked[0];
  logger.info("");
  logger.info("Recommended .env values (use whichever has > 0 balance):");
  if (winner && winner.val > 0) {
    logger.info(`  POLYMARKET_FUNDER_ADDRESS=${winner.funder}`);
    logger.info(`  LIVE_SIGNATURE_TYPE=${sigNames[winner.sig]}`);
  } else {
    logger.warn("  None of the four candidates has visible funds. Try POLY_1271 deposit wallet:");
    logger.warn(`    POLYMARKET_FUNDER_ADDRESS=${depositAddr}`);
    logger.warn(`    LIVE_SIGNATURE_TYPE=POLY_1271`);
  }
}

main().catch((err) => { logger.error(err); process.exit(1); });
