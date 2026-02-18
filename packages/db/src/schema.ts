/**
 * @module db/schema
 * Drizzle ORM table definitions for the FlowMate SQLite database.
 */

import {
  sqliteTable,
  integer,
  text,
  real,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

/** Slack thread conversations, keyed by (channel_id, thread_ts). */
export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    userId: text("user_id").notNull(),
    title: text("title"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("conv_channel_thread_idx").on(table.channelId, table.threadTs),
  ],
);

/** Individual runner execution records linked to a conversation. */
export const executions = sqliteTable(
  "executions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id),
    containerId: text("container_id"),
    /** Claude model used for this execution (e.g. "haiku", "sonnet", "opus"). */
    model: text("model"),
    status: text("status").notNull().default("pending"),
    prompt: text("prompt").notNull(),
    resultText: text("result_text"),
    errorMessage: text("error_message"),
    costUsd: real("cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    durationMs: integer("duration_ms"),
    numTurns: integer("num_turns"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("exec_conversation_idx").on(table.conversationId),
    index("exec_status_idx").on(table.status),
    index("exec_started_at_idx").on(table.startedAt),
  ],
);

/** Conversation message log for context replay across executions. */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role").notNull(),
    content: text("content").notNull(),
    slackTs: text("slack_ts"),
    executionId: integer("execution_id").references(() => executions.id),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("msg_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);
