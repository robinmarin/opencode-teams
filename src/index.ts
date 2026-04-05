import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { createEventHandler } from "./messaging.js";
import { createTools } from "./tools.js";

const TeamPlugin: Plugin = async ({ client }) => {
  return {
    event: createEventHandler(client),
    tool: createTools(client),
  };
};

export const server = TeamPlugin;
export default TeamPlugin;
