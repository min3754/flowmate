/**
 * @module orchestrator/slack/handlers
 * Slack DM message handler: receives messages, manages threads,
 * downloads image attachments, runs executions, and posts results.
 * Supports Agents & AI Apps with markdown blocks and assistant thread events.
 */

import type { App } from "@slack/bolt";
import type { Block } from "@slack/types";
import type { GenericMessageEvent } from "@slack/types";
import type { FlowmateDb } from "@flowmate/db";
import type { Attachment, FlowmateConfig } from "@flowmate/shared";
import {
  getOrCreateConversation,
  saveMessage,
} from "../context/thread-manager.js";
import type { ExecutionService } from "../services/execution.js";
import { formatResponse } from "./formatter.js";
import type { Logger } from "pino";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

/** Subset of Slack file metadata used for image filtering and download. */
interface SlackFile {
  mimetype: string;
  size: number;
  url_private?: string;
  name: string | null;
}

/** Create a single markdown block cast to Slack Block for API compatibility. */
function mdBlock(text: string): Block {
  return { type: "markdown", text } as unknown as Block;
}

/**
 * Download supported image attachments from Slack, handling the CDN redirect pattern.
 *
 * @param files - Slack file metadata array from the message event
 * @param botToken - Slack bot OAuth token for authenticated downloads
 * @param logger - Logger instance
 * @returns Array of base64-encoded image attachments
 */
async function downloadSlackImages(
  files: SlackFile[],
  botToken: string,
  logger: Logger,
): Promise<Attachment[]> {
  logger.debug(
    { totalFiles: files.length, files: files.map((f) => ({ name: f.name, mimetype: f.mimetype, size: f.size, hasUrl: !!f.url_private })) },
    "Processing Slack files",
  );

  const imageFiles = files
    .filter(
      (f) =>
        SUPPORTED_IMAGE_TYPES.has(f.mimetype) &&
        f.size <= MAX_IMAGE_SIZE &&
        f.url_private,
    )
    .slice(0, MAX_IMAGES);

  logger.debug({ imageFileCount: imageFiles.length }, "Filtered image files");

  const attachments: Attachment[] = [];
  for (const file of imageFiles) {
    try {
      // Use redirect: 'manual' because Slack redirects to a signed CDN URL,
      // and fetch strips the Authorization header on cross-origin redirects.
      const res = await fetch(file.url_private!, {
        headers: { Authorization: `Bearer ${botToken}` },
        redirect: "manual",
      });
      logger.debug(
        { file: file.name, status: res.status, location: res.headers.get("location")?.slice(0, 80) },
        "Slack file initial response",
      );

      let imageRes: Response;
      if (res.status >= 300 && res.status < 400) {
        // Follow redirect — the signed CDN URL doesn't need auth
        const redirectUrl = res.headers.get("location");
        if (!redirectUrl) {
          logger.warn({ file: file.name }, "Redirect without location header");
          continue;
        }
        imageRes = await fetch(redirectUrl);
      } else if (res.ok) {
        imageRes = res;
      } else {
        logger.warn({ status: res.status, file: file.name }, "Image download failed");
        continue;
      }

      const contentType = imageRes.headers.get("content-type") ?? "";
      logger.debug(
        { file: file.name, status: imageRes.status, contentType },
        "Image download response",
      );
      if (!imageRes.ok) {
        logger.warn({ status: imageRes.status, file: file.name }, "Image download failed at CDN");
        continue;
      }
      if (!contentType.startsWith("image/")) {
        logger.warn({ file: file.name, contentType }, "Downloaded file is not an image, skipping");
        continue;
      }
      const buf = Buffer.from(await imageRes.arrayBuffer());
      logger.debug(
        { file: file.name, downloadedBytes: buf.length },
        "Image downloaded successfully",
      );
      attachments.push({
        filename: file.name ?? "image",
        mimeType: file.mimetype,
        base64: buf.toString("base64"),
      });
    } catch (err) {
      logger.error(err, "Failed to download image");
    }
  }
  return attachments;
}

/**
 * Register the Slack message handler that processes DMs, downloads image attachments,
 * runs executions, and posts results back to the thread.
 * Also registers Assistant event handlers for Agents & AI Apps features.
 *
 * @param deps - Service dependencies (Slack app, DB, execution service, config, logger)
 */
export function registerHandlers(deps: {
  app: App;
  botUserId: string;
  db: FlowmateDb;
  executionService: ExecutionService;
  config: FlowmateConfig;
  logger: Logger;
}): void {
  const { app, botUserId, db, executionService, config, logger } = deps;

  // Restrict access to specific Slack users (empty = allow all)
  const allowedUsers = new Set(
    process.env.ALLOWED_USER_IDS?.split(",").filter(Boolean) ?? [],
  );
  const botToken = process.env.SLACK_BOT_TOKEN;

  // Per-thread lock to prevent concurrent executions in the same thread
  const threadLocks = new Set<string>();

  // --- Assistant thread events (Agents & AI Apps) ---

  app.event("assistant_thread_started", async ({ event, client }) => {
    const { channel_id, thread_ts } = event.assistant_thread;

    logger.info({ channel_id, thread_ts }, "Assistant thread started");

    // Only set suggested prompts (shown in empty thread UI before user types).
    // No greeting message — the thinking/progress message from app.message() is sufficient.
    await client.assistant.threads.setSuggestedPrompts({
      channel_id,
      thread_ts,
      prompts: [
        { title: "Summarize", message: "Summarize the following:" },
        { title: "Code Review", message: "Review this code and suggest improvements:" },
        { title: "Explain", message: "Explain this concept in simple terms:" },
        { title: "Debug", message: "Help me debug this issue:" },
      ],
    });
  });

  app.event("assistant_thread_context_changed", async ({ event }) => {
    logger.debug(
      { channel_id: event.assistant_thread.channel_id, thread_ts: event.assistant_thread.thread_ts },
      "Assistant thread context changed",
    );
  });

  // --- DM message handler ---

  app.message(async ({ message, client }) => {
    const msg = message as GenericMessageEvent;

    // Filter: DM only, allow regular messages and file_share, no bots, no self
    const subtype = (message as { subtype?: string }).subtype;
    if (subtype !== undefined && subtype !== "file_share") return;
    if (msg.channel_type !== "im") return;
    if (msg.bot_id || msg.user === botUserId) return;
    if (allowedUsers.size > 0 && !allowedUsers.has(msg.user)) {
      logger.warn({ user: msg.user }, "Unauthorized user ignored");
      return;
    }

    const text = msg.text ?? "";
    const files = (msg.files ?? []) as SlackFile[];
    const hasFiles = files.length > 0;
    const supportedImages = files.filter(
      (f) => SUPPORTED_IMAGE_TYPES.has(f.mimetype) && f.url_private,
    );
    const oversizedImages = files.filter(
      (f) => SUPPORTED_IMAGE_TYPES.has(f.mimetype) && f.size > MAX_IMAGE_SIZE,
    );
    const unsupportedFiles = files.filter(
      (f) => !SUPPORTED_IMAGE_TYPES.has(f.mimetype),
    );
    const hasImages = supportedImages.length > 0;

    // Agents & AI Apps: Slack always creates threads, so thread_ts is guaranteed
    const threadTs = msg.thread_ts!;
    const threadKey = `${msg.channel}:${threadTs}`;

    // Reject concurrent executions in the same thread
    if (threadLocks.has(threadKey)) {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        blocks: [mdBlock(":hourglass: A task is already running in this thread. Please wait for it to finish.")],
        text: "A task is already running in this thread. Please wait for it to finish.",
      });
      return;
    }

    // Files attached but none are processable images, and no text
    if (!text.trim() && hasFiles && !hasImages) {
      const reasons: string[] = [];
      if (unsupportedFiles.length > 0) {
        const types = [...new Set(unsupportedFiles.map((f) => f.mimetype))].join(", ");
        reasons.push(`Unsupported format (${types}). Supported: JPEG, PNG, GIF, WebP`);
      }
      if (oversizedImages.length > 0) {
        reasons.push(`Image exceeds 5MB limit`);
      }
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        blocks: [mdBlock( `:warning: ${reasons.join(". ")}` )],
        text: reasons.join(". "),
      });
      return;
    }

    // Require text or images
    if (!text.trim() && !hasImages) return;

    logger.info(
      { user: msg.user, channel: msg.channel, threadTs, hasImages },
      "Message received",
    );

    // Get or create conversation
    const conversation = getOrCreateConversation(
      db,
      msg.channel,
      threadTs,
      msg.user,
    );

    // Save user message
    saveMessage(db, conversation.id, "user", text || "[image]", msg.ts);

    // Download image attachments
    let attachments: Attachment[] | undefined;
    const warnings: string[] = [];
    if (hasImages && botToken) {
      attachments = await downloadSlackImages(files, botToken, logger);
      if (attachments.length === 0) {
        attachments = undefined;
        warnings.push(":warning: Failed to load image(s).");
      } else if (attachments.length < supportedImages.length) {
        warnings.push(`:warning: ${supportedImages.length - attachments.length} image(s) failed to load.`);
      }
    }
    if (supportedImages.length > MAX_IMAGES) {
      warnings.push(`:info: Only the first ${MAX_IMAGES} of ${supportedImages.length} images will be processed.`);
    }
    if (oversizedImages.length > 0 && hasImages) {
      warnings.push(`:warning: ${oversizedImages.length} image(s) skipped (exceeds 5MB limit).`);
    }
    logger.debug(
      { attachmentCount: attachments?.length ?? 0, attachments: attachments?.map((a) => ({ filename: a.filename, mimeType: a.mimeType, base64Length: a.base64.length })) },
      "Attachments ready for execution",
    );

    // Post warning message for image issues (if any)
    if (warnings.length > 0) {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        blocks: [mdBlock( warnings.join("\n") )],
        text: warnings.join(". "),
      });
    }

    // Show thinking indicator via assistant status
    await client.assistant.threads.setStatus({
      channel_id: msg.channel,
      thread_ts: threadTs,
      status: "Processing...",
    });

    threadLocks.add(threadKey);
    try {
      const result = await executionService.execute({
        conversation,
        prompt: text,
        attachments,
        onProgress: async (progressText: string) => {
          const preview =
            progressText.length > 200
              ? progressText.slice(0, 200) + "..."
              : progressText;
          await client.assistant.threads
            .setStatus({
              channel_id: msg.channel,
              thread_ts: threadTs,
              status: preview,
            })
            .catch((err: unknown) =>
              logger.error(err, "Progress update failed"),
            );
        },
      });

      // Clear thinking indicator
      await client.assistant.threads.setStatus({
        channel_id: msg.channel,
        thread_ts: threadTs,
        status: "",
      });

      const formatted = formatResponse(result.text);

      // Post final result as a new message
      const resultMsg = await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        blocks: formatted.blocks,
        text: formatted.fallbackText,
      });

      // Upload overflow as file if needed
      if (formatted.overflow) {
        await client.filesUploadV2({
          channel_id: msg.channel,
          thread_ts: threadTs,
          content: formatted.overflow.toString("utf-8"),
          filename: "result.md",
          title: "Full Result",
        });
      }

      // Set thread title for History tab (uses user prompt as title)
      await client.assistant.threads.setTitle({
        channel_id: msg.channel,
        thread_ts: threadTs,
        title: text.slice(0, 50) || "Task",
      }).catch((err: unknown) => logger.debug(err, "assistant.threads.setTitle unavailable"));

      // Save assistant message
      saveMessage(
        db,
        conversation.id,
        "assistant",
        result.text,
        resultMsg.ts!,
        result.executionId,
      );

      logger.info(
        {
          executionId: result.executionId,
          costUsd: result.costUsd,
        },
        "Execution completed",
      );
    } catch (err) {
      // Clear thinking indicator on failure
      await client.assistant.threads.setStatus({
        channel_id: msg.channel,
        thread_ts: threadTs,
        status: "",
      }).catch(() => {});

      const errorMsg =
        err instanceof Error ? err.message : "Unknown error occurred";
      const errorResult = await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: threadTs,
        blocks: [mdBlock( `:x: Error: ${errorMsg}` )],
        text: `Error: ${errorMsg}`,
      });

      saveMessage(
        db,
        conversation.id,
        "assistant",
        `Error: ${errorMsg}`,
        errorResult.ts!,
      );

      logger.error(err, "Execution failed");
    } finally {
      threadLocks.delete(threadKey);
    }
  });
}
