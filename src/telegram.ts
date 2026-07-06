import { basename, extname } from "node:path";
import { Bot, InputFile } from "grammy";
import type { Api } from "grammy";
import type { ChatAdapter, IncomingAttachment, RelayConfig } from "./types.js";

export class TelegramGateway {
  readonly bot: Bot;

  constructor(
    private readonly config: RelayConfig,
    private readonly handlers: {
      onText: (adapter: ChatAdapter, text: string) => Promise<void>;
      onCommand: (adapter: ChatAdapter, text: string) => Promise<void>;
      onAttachment: (adapter: ChatAdapter, attachment: IncomingAttachment) => Promise<void>;
    }
  ) {
    this.bot = new Bot(config.telegramBotToken);
    this.bot.catch((error) => {
      console.error("[telegram] Middleware error:", error.error);
    });
    this.registerHandlers();
  }

  start() {
    return this.bot.start({
      timeout: this.config.telegram.pollTimeoutSeconds,
      onStart: () => {
        console.log("[main] Telegram Codex remote control started");
      }
    });
  }

  async downloadAttachment(fileId: string) {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error("Telegram file path was missing");
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${this.config.telegramBotToken}/${file.file_path}`
    );

    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: HTTP ${response.status}`);
    }

    return {
      filePath: file.file_path,
      bytes: Buffer.from(await response.arrayBuffer())
    };
  }

  private registerHandlers() {
    this.bot.on("message:text", async (ctx) => {
      if (!isAuthorized(ctx.api, ctx.chat.type, ctx.from.id, this.config.allowedTelegramUserId)) {
        return;
      }

      const adapter = createChatAdapter(ctx.api, ctx.chat.id);
      if (ctx.message.text.startsWith("/")) {
        await this.handlers.onCommand(adapter, ctx.message.text);
        return;
      }

      await this.handlers.onText(adapter, ctx.message.text);
    });

    this.bot.on("message:photo", async (ctx) => {
      if (!isAuthorized(ctx.api, ctx.chat.type, ctx.from.id, this.config.allowedTelegramUserId)) {
        return;
      }

      const photo = ctx.message.photo.at(-1);
      if (!photo) return;

      const adapter = createChatAdapter(ctx.api, ctx.chat.id);
      await this.handlers.onAttachment(adapter, {
        fileId: photo.file_id,
        fileName: `photo-${photo.file_unique_id}.jpg`,
        mimeType: "image/jpeg",
        caption: ctx.message.caption ?? "Analyze this image."
      });
    });

    this.bot.on("message:document", async (ctx) => {
      if (!isAuthorized(ctx.api, ctx.chat.type, ctx.from.id, this.config.allowedTelegramUserId)) {
        return;
      }

      const adapter = createChatAdapter(ctx.api, ctx.chat.id);
      const document = ctx.message.document;
      await this.handlers.onAttachment(adapter, {
        fileId: document.file_id,
        fileName: document.file_name || `document-${document.file_unique_id}${resolveExtension(document.mime_type)}`,
        mimeType: document.mime_type || "application/octet-stream",
        caption: ctx.message.caption ?? "Inspect this file."
      });
    });
  }
}

function createChatAdapter(api: Api, chatId: number): ChatAdapter {
  return {
    async replyHtml(html: string) {
      const message = await api.sendMessage(chatId, html, {
        parse_mode: "HTML"
      });
      return message.message_id;
    },
    async editHtml(messageId: number, html: string) {
      await api.editMessageText(chatId, messageId, html, {
        parse_mode: "HTML"
      });
    },
    async deleteMessage(messageId: number) {
      await api.deleteMessage(chatId, messageId);
    },
    async sendHtml(html: string) {
      await api.sendMessage(chatId, html, {
        parse_mode: "HTML"
      });
    },
    async sendTyping() {
      await api.sendChatAction(chatId, "typing");
    },
    async sendPhoto(path: string, caption?: string) {
      await api.sendPhoto(chatId, new InputFile(path), {
        caption,
        parse_mode: caption ? "HTML" : undefined
      });
    },
    async sendDocument(path: string, fileName: string, caption?: string) {
      await api.sendDocument(chatId, new InputFile(path, fileName), {
        caption,
        parse_mode: caption ? "HTML" : undefined
      });
    }
  };
}

function isAuthorized(
  _api: Api,
  chatType: string,
  fromUserId: number,
  allowedUserId: number
) {
  return chatType === "private" && fromUserId === allowedUserId;
}

function resolveExtension(mimeType: string | undefined) {
  if (!mimeType) return "";
  if (mimeType === "application/zip") return ".zip";
  if (mimeType === "text/plain") return ".txt";
  if (mimeType === "application/pdf") return ".pdf";
  return extname(basename(`x.${mimeType.split("/").at(-1) || "bin"}`));
}
