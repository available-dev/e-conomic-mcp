/** Shared tool typing used across the tool modules. */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /** Returns a JSON-serializable result; throwing yields an error tool result. */
  handler: (args: Record<string, any>) => Promise<unknown>;
}
