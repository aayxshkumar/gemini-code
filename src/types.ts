export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /**
   * A local file to attach to the message carrying this result — how a tool
   * hands Gemini something text can't express, like a screenshot. Files
   * inside the agent's temp dir are deleted after sending; anything else
   * (e.g. a user's own image) is left alone.
   */
  attachment?: string;
}

export interface ToolDefinition {
  name: string;
  /** Gemini's only documentation of the tool: what it does and its args. */
  description: string;
  /**
   * Left out of the primer, which names it and nothing more. Gemini reads the
   * description when it wants the tool, through tool_search.
   */
  deferred?: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}
