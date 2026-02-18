/**
 * @module orchestrator/slack/app
 * Slack Bolt app initialization with Socket Mode.
 */

import { App, LogLevel } from "@slack/bolt";

/**
 * Initialize the Slack Bolt app in Socket Mode and resolve the bot's own user ID.
 *
 * @returns The Bolt app instance and the authenticated bot user ID
 */
export async function createSlackApp(): Promise<{
  app: App;
  botUserId: string;
}> {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  const authResult = await app.client.auth.test();
  const botUserId = authResult.user_id!;

  return { app, botUserId };
}
