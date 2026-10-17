export interface GeminiResponse {
  /** Full rendered text of the latest response turn. */
  text: string;
  /**
   * Trimmed text content of each rendered code block within that response,
   * in DOM order. Markdown fence characters (```) never appear here — the
   * UI renders markdown to HTML before we read it, so a fence becomes a
   * <pre>/<code> element, not literal backtick text. This is why tool-call
   * detection reads code blocks directly instead of regex-matching for
   * ```tool in the extracted text (see agent/toolCallParser.ts).
   */
  codeBlocks: string[];
}

/**
 * The subset of GeminiDriver's surface that the agent loop actually needs.
 * Extracted so tests can swap in a fake driver instead of a real browser
 * (GeminiDriver has private fields, so the concrete class type can't be
 * satisfied by a plain object — this interface can).
 */
export interface IGeminiDriver {
  /**
   * Sends a prompt. `attachFile` uploads a local file alongside it, used
   * when a tool result is too long to paste into the composer (the web UI
   * has a practical text-length limit that the API wouldn't).
   */
  sendPrompt(text: string, opts?: { attachFile?: string | string[] }): Promise<void>;
  waitForResponseComplete(opts?: { timeoutMs?: number; debounceMs?: number }): Promise<void>;
  getLastResponse(): Promise<GeminiResponse>;
  /** Starts a fresh thread. Optional: fakes in tests may not implement it. */
  newConversation?(): Promise<void>;
}
