/**
 * Profile (account/company) management tools.
 *
 * These let the model discover which accounts are configured and switch the
 * active one mid-conversation. Individual data tools can also target an account
 * per-call via their `profile` argument; switching here only changes the default
 * used when that argument is omitted.
 *
 * For safety, no token values are returned — only non-secret metadata (profile
 * name, base URL, whether each token is present, and usability).
 */

import type { ClientRegistry } from "../clientRegistry.js";
import type { ToolDefinition } from "./types.js";

export function profileTools(clients: ClientRegistry): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  tools.push({
    name: "economic_list_profiles",
    description:
      "List the configured e-conomic account profiles (companies) and show which one is " +
      "currently active. Each data tool accepts an optional `profile` argument to target a " +
      "specific account; omit it to use the active profile. No secrets are returned.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => ({
      activeProfile: clients.activeProfile,
      defaultProfile: clients.defaultProfile,
      profiles: clients.describe(),
    }),
  });

  tools.push({
    name: "economic_use_profile",
    description:
      "Switch the active e-conomic account profile for subsequent tool calls that don't " +
      "specify their own `profile`. Use economic_list_profiles to see available profiles.",
    inputSchema: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description: "Name of the profile to make active.",
        },
      },
      required: ["profile"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const activeProfile = clients.use(String(args.profile));
      return { activeProfile, profiles: clients.describe() };
    },
  });

  return tools;
}
