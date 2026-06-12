import { config } from "../config.js";
import { binance } from "./binance.js";

/**
 * Point the REST client at a venue — sets BOTH the endpoint and the credentials,
 * so testnet and mainnet keys never get crossed. Returns the matching WS host.
 *   live=false → test venue (BINANCE_TESTNET_* keys/host)
 *   live=true  → mainnet (BINANCE_* keys/host)
 */
export function useVenue(live: boolean): { wsUrl: string; baseUrl: string } {
  const b = config.binance;
  if (live) {
    binance.setBaseUrl(b.baseUrl);
    binance.setCredentials(b.apiKey, b.apiSecret);
    return { wsUrl: b.wsUrl, baseUrl: b.baseUrl };
  }
  binance.setBaseUrl(b.testnetBaseUrl);
  binance.setCredentials(b.testnetApiKey, b.testnetApiSecret);
  return { wsUrl: b.testnetWsUrl, baseUrl: b.testnetBaseUrl };
}
