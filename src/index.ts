import type { Plugin } from "@opencode-ai/plugin";
import { createEventHandler } from "./messaging.js";
import { createTools } from "./tools.js";

export const TeamPlugin: Plugin = async ({ client }) => {
  return {
    event: createEventHandler(client),
    tool: createTools(client),
  };
};

export default TeamPlugin;
