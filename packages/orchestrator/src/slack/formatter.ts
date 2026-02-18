/**
 * @module orchestrator/slack/formatter
 * Slack message formatting using markdown blocks and table blocks for Agents & AI Apps rendering.
 */

import type { Block, RawTextElement } from "@slack/types";

/** Maximum total text length across all markdown blocks in a single message. */
const MARKDOWN_BLOCK_LIMIT = 12_000;

/** Slack markdown block for Agents & AI Apps rendering. */
export interface MarkdownBlock {
  type: "markdown";
  text: string;
}

/** Slack table block for structured data. */
interface TableBlock {
  type: "table";
  rows: RawTextElement[][];
}

/** Formatted message ready for Slack API: blocks + plaintext fallback + optional overflow file. */
export interface FormattedResponse {
  blocks: Block[];
  fallbackText: string;
  overflow?: Buffer;
}

/** Regex matching consecutive lines that start and end with `|` (a markdown table). */
const MD_TABLE_RE = /(?:^\|.+\|$\n?)+/gm;

/** Regex matching the separator row of a markdown table (e.g. `| --- | :---: | ---: |`). */
const SEPARATOR_RE = /^\|([\s\-:]+\|)+$/;

/**
 * Parse a single cell text, stripping markdown formatting that raw_text cannot render.
 * Slack table cells only support plain text — bold/italic/code markers must be removed.
 */
function parseCell(raw: string): RawTextElement {
  const text = raw
    .trim()
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold** → bold
    .replace(/__(.+?)__/g, "$1")        // __bold__ → bold
    .replace(/\*(.+?)\*/g, "$1")        // *italic* → italic
    .replace(/_(.+?)_/g, "$1")          // _italic_ → italic
    .replace(/`(.+?)`/g, "$1");         // `code` → code
  return { type: "raw_text", text };
}

/**
 * Parse a markdown table string into a Slack table block.
 * Strips the separator row (`| --- | --- |`) and converts each row to RawTextElement cells.
 */
function parseMarkdownTable(tableText: string): TableBlock {
  const lines = tableText.trimEnd().split("\n");
  const rows: RawTextElement[][] = [];

  for (const line of lines) {
    if (SEPARATOR_RE.test(line)) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(parseCell);
    rows.push(cells);
  }

  return { type: "table", rows };
}

/**
 * Split text into alternating segments of prose (markdown) and tables (table blocks).
 * Slack allows only one table block per message, so only the first markdown table
 * becomes a native table block; subsequent tables are wrapped in code blocks.
 */
function splitIntoBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let lastIndex = 0;
  let tableUsed = false;

  for (const match of text.matchAll(MD_TABLE_RE)) {
    const tableStr = match[0];
    const matchIndex = match.index!;

    // Check if this is actually a table (has separator row), not just pipe-delimited text
    const lines = tableStr.trimEnd().split("\n");
    const hasSeparator = lines.some((l) => SEPARATOR_RE.test(l));
    if (!hasSeparator) continue;

    // Add preceding markdown text
    const before = text.slice(lastIndex, matchIndex).trim();
    if (before) {
      blocks.push({ type: "markdown", text: before } as unknown as Block);
    }

    if (!tableUsed) {
      // First table: native Slack table block
      blocks.push(parseMarkdownTable(tableStr) as unknown as Block);
      tableUsed = true;
    } else {
      // Subsequent tables: keep as code block so alignment is preserved
      blocks.push({
        type: "markdown",
        text: "```\n" + tableStr.trimEnd() + "\n```",
      } as unknown as Block);
    }

    lastIndex = matchIndex + tableStr.length;
  }

  // Add remaining markdown text
  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    blocks.push({ type: "markdown", text: remaining } as unknown as Block);
  }

  return blocks;
}

/**
 * Format runner output into Slack blocks with overflow handling.
 *
 * - Converts markdown tables to native Slack table blocks
 * - Non-table content uses markdown blocks
 * - Over 12,000 chars: truncated + full text as file attachment
 *
 * @param text - Full response text from the runner
 * @returns Blocks, plaintext fallback for notifications, and optional overflow buffer
 */
export function formatResponse(text: string): FormattedResponse {
  const fallbackText = text.length > 200 ? text.slice(0, 200) + "..." : text;
  const overflow =
    text.length > MARKDOWN_BLOCK_LIMIT
      ? Buffer.from(text, "utf-8")
      : undefined;

  const content = overflow
    ? text.slice(0, MARKDOWN_BLOCK_LIMIT - 100) +
      "\n\n... _(full result attached as file)_"
    : text;

  return {
    blocks: splitIntoBlocks(content),
    fallbackText,
    overflow,
  };
}
