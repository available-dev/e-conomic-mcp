/** Shared tool typing used across the tool modules. */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Returns a JSON-serializable result; throwing yields an error tool result. */
  handler: (args: Record<string, any>) => Promise<unknown>;
}

/**
 * Shared `profile` argument exposed by every data tool. Lets a call target a
 * specific account/company; omitted means the session's active profile.
 */
export const PROFILE_PROPERTY = {
  profile: {
    type: "string",
    description:
      "Optional account profile (company) to target for this call. Defaults to the " +
      "active profile. List configured profiles with economic_list_profiles and switch " +
      "the default with economic_use_profile.",
  },
} as const;

/** Merge the shared `profile` property into a tool's input properties. */
export function withProfile(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return { ...properties, ...PROFILE_PROPERTY };
}
