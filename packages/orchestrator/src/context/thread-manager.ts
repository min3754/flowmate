/**
 * @module orchestrator/context/thread-manager
 * Conversation CRUD and message history by Slack thread.
 */

import { eq, and, asc } from "drizzle-orm";
import type { FlowmateDb } from "@flowmate/db";
import { conversations, messages } from "@flowmate/db";
import type { ConversationMessage } from "@flowmate/shared";

/** Minimal conversation record used throughout the orchestrator. */
export interface Conversation {
  id: number;
  channelId: string;
  threadTs: string;
  userId: string;
}

/**
 * Find an existing conversation by Slack thread key, or create a new one.
 *
 * @param db - Drizzle ORM database instance
 * @param channelId - Slack channel ID
 * @param threadTs - Slack thread timestamp (used as conversation key)
 * @param userId - Slack user ID who initiated the conversation
 * @returns The existing or newly created conversation record
 */
export function getOrCreateConversation(
  db: FlowmateDb,
  channelId: string,
  threadTs: string,
  userId: string,
): Conversation {
  const existing = db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channelId, channelId),
        eq(conversations.threadTs, threadTs),
      ),
    )
    .get();

  if (existing) {
    return {
      id: existing.id,
      channelId: existing.channelId,
      threadTs: existing.threadTs,
      userId: existing.userId,
    };
  }

  const result = db
    .insert(conversations)
    .values({ channelId, threadTs, userId })
    .returning()
    .get();

  return {
    id: result.id,
    channelId: result.channelId,
    threadTs: result.threadTs,
    userId: result.userId,
  };
}

/**
 * Load all messages for a conversation in chronological order,
 * formatted for the runner's context window.
 *
 * @param db - Drizzle ORM database instance
 * @param conversationId - Internal conversation ID
 * @returns Ordered list of conversation messages
 */
export function getConversationHistory(
  db: FlowmateDb,
  conversationId: number,
): ConversationMessage[] {
  const rows = db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .all();

  return rows.map((r) => ({
    role: r.role as ConversationMessage["role"],
    content: r.content,
  }));
}

/**
 * Persist a message to the conversation log.
 *
 * @param db - Drizzle ORM database instance
 * @param conversationId - Internal conversation ID
 * @param role - Message role (user, assistant, or system)
 * @param content - Message text content
 * @param slackTs - Optional Slack message timestamp for linking
 * @param executionId - Optional execution ID that produced this message
 */
export function saveMessage(
  db: FlowmateDb,
  conversationId: number,
  role: string,
  content: string,
  slackTs?: string,
  executionId?: number,
): void {
  db.insert(messages)
    .values({
      conversationId,
      role,
      content,
      slackTs,
      executionId,
    })
    .run();
}
