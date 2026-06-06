import { logger } from "../logger.js";
import { config } from "../config.js";

export class TelegramNotifier {
  private enabled = false;

  constructor() {
    if (config.telegram.botToken && config.telegram.chatId) {
      this.enabled = true;
      logger.info("Telegram notifier enabled");
    } else {
      logger.debug("Telegram notifier disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)");
    }
  }

  isEnabled(): boolean { return this.enabled; }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) logger.warn("Telegram send non-200", res.status, await res.text());
    } catch (err) {
      logger.warn("Telegram send failed", (err as Error).message);
    }
  }

  fireAndForget(text: string): void { void this.send(text); }
}
