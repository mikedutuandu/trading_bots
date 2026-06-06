import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Best-effort Telegram alerts via the Bot API (no SDK, just fetch). A no-op when
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID aren't set, so the engine runs fine
 * without it. Failures are logged, never thrown — alerts must not break trading.
 *
 * Setup: message @BotFather → /newbot → token; message your bot once, then read
 * the chat id from https://api.telegram.org/bot<token>/getUpdates.
 */
const { telegramToken: TOKEN, telegramChatId: CHAT } = config.notifications;

export const telegramEnabled = Boolean(TOKEN && CHAT);

export async function notify(text: string): Promise<void> {
  if (!telegramEnabled) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!res.ok) logger.warn(`telegram send failed: HTTP ${res.status} ${await res.text()}`);
  } catch (err) {
    logger.warn("telegram send error:", err);
  }
}

/** Prefix an alert with a severity emoji for quick scanning. */
export function notifyEvent(kind: "entry" | "exit" | "halt" | "error" | "info", text: string): Promise<void> {
  const icon = { entry: "🟢", exit: "🔵", halt: "🛑", error: "⚠️", info: "ℹ️" }[kind];
  return notify(`${icon} ${text}`);
}
