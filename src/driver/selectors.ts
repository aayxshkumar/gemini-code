/**
 * All DOM selectors for the Gemini web app live here, and nowhere else.
 * Google changes this UI without notice, so when the driver stops working
 * this is the first (and hopefully only) file you need to touch.
 *
 * HOW TO (RE)CALIBRATE THESE:
 *   1. Log in once via `npm run login` (uses the same persistent profile
 *      this driver uses, so cookies carry over).
 *   2. In another terminal, run Playwright's own inspector against that
 *      profile so you can click elements and have it print selectors:
 *
 *        npx playwright codegen \
 *          --user-data-dir ./.gemini-code-profile \
 *          https://gemini.google.com/app
 *
 *   3. Click the prompt box, the send button, a "stop generating" button
 *      (mid-response), and a finished response bubble. Copy the selectors
 *      codegen prints into the fields below.
 *
 * WHY THESE USE ^= (starts-with) AND NOT *= (contains):
 *
 * Gemini renders a "More options for <the entire message text>" button for
 * every message in the thread — the whole prompt ends up inside that
 * button's aria-label. So `button[aria-label*="Send" i]` matched those
 * buttons for any conversation containing the word "send" (our own primer
 * says "After you send a tool call"), they sort earlier in the DOM than the
 * real control, and `.first()` clicked a hidden one. The send silently did
 * nothing, and only after a few turns — which is why it looked intermittent.
 * Anchor on the start of the label, and always filter to visible.
 *
 * The selectors here are best-effort placeholders based on the app's
 * general structure (rich-text composer, Angular Material buttons) — they
 * are NOT guaranteed to match the live DOM. Treat them as a starting point.
 */
const consumerSelectors = {
  /**
   * Sign-in control shown when the profile isn't authenticated yet.
   *
   * Scoped to real controls (button/link) rather than a bare `text=Sign in`,
   * which matched ANY occurrence of the phrase on the page — including
   * inside the conversation itself. That produced a spectacular
   * false positive once this project started sending its own README as
   * context: the README documents the "Sign in to Gemini by hand" step, so
   * the phrase appeared in the thread as a <p>, and the agent concluded it
   * had been logged out mid-session.
   */
  signInButton: 'button:has-text("Sign in"), a:has-text("Sign in")',

  /** The contenteditable / rich-text box you type your prompt into. */
  composerInput: 'div[contenteditable="true"]',

  /**
   * Button that submits the current prompt. Only used as a FALLBACK —
   * sendPrompt() presses Enter instead, because this button's aria-label
   * and enabled/visible state change between turns (it's absent while the
   * composer is empty, and becomes the stop button mid-generation), which
   * made it time out on the second send of a session.
   */
  sendButton: 'button[aria-label^="Send" i]',

  /**
   * Hidden file input used to attach a file to the prompt. NOTE: these
   * elements do not exist in the DOM until the upload menu below is opened
   * — a bare setInputFiles() finds nothing and times out. See
   * GeminiDriver.attachFile().
   */
  fileInput: 'input[type="file"]',

  /** Opens the menu that creates the file inputs ("Upload & tools"). */
  uploadButton: 'button[aria-label^="Upload" i]',

  /** The "Upload files" entry inside that menu. */
  uploadFilesText: /upload files/i,

  /**
   * The chip/preview that appears once a file finishes attaching.
   *
   * Counted rather than matched by filename: an IMAGE attachment renders as
   * a thumbnail with no filename text at all, so the original
   * "wait for the filename to appear" check timed out on every pasted
   * screenshot even though the upload had succeeded.
   */
  attachmentChip: '[class*="attachment" i], [class*="file-preview" i]',

  /** Button visible only while Gemini is still generating a response. */
  stopButton: 'button[aria-label^="Stop" i]',

  /** Container wrapping a single model response turn (the last one = latest). */
  responseContainer: '[data-message-author-role="model"], .model-response-text',

  /** Code blocks inside a response, read individually to preserve formatting. */
  codeBlock: 'code',

  /** Starts a brand-new conversation thread. */
  newChatButton: 'button[aria-label^="New chat" i]',

  /**
   * Links to a Gem on the Gems list page (/gems/view). Each href is
   * /gem/<id>, where <id> is a slug for Google's premade Gems
   * ("coding-partner") and an opaque id for your own.
   */
  // Contains, not starts-with: absolute URLs and multi-account paths
  // (/u/1/gem/...) are links to a Gem too. "/gem/" with its slashes still
  // excludes the list page itself (/gems/view).
  gemLink: 'a[href*="/gem/"]',

  /**
   * Temporary chat: a thread Google doesn't save to the account's history
   * or use for personalisation. The agent's dozens of tool-call threads
   * otherwise bury the user's own chats in the sidebar. The first button
   * turns it on; the second is only present while it is on.
   */
  temporaryChatButton: 'button[aria-label="Temporary chat" i]',
  /**
   * The state isn't on the button: a tooltip-like div next to it reads
   * "Turn on temporary chat" or "Turn off temporary chat". Matched as text.
   */
  temporaryChatIsOnText: /turn off temporary chat/i,

  /** Opens the model/mode picker. Its aria-label also reports the current model. */
  modePicker: 'button[aria-label*="mode picker" i]',

  /**
   * Items inside the opened model picker menu. A prefix match, because the
   * models became `menuitemradio` in November 2026, leaving `menuitem` matching
   * only "Thinking level", so no model could be listed or picked.
   */
  modeMenuItem: '[role^="menuitem"]',

  /**
   * The padlock on a model above the account's plan. Locked rows used to carry
   * "upsell" in their id; since November 2026 only this icon marks them.
   */
  lockIcon: '[fonticon="lock"], [data-mat-icon-name="lock"]',

  /** The picker entry that opens the Thinking level submenu, on hover. */
  thinkingLevelMenu: 'gem-menu-item[value="thinking_level"]',

  /** Low / Medium / High in that submenu. They carry no id of their own. */
  thinkingLevelItem: 'gem-menu-item:not([data-test-id^="bard-mode-option"]):not([value="thinking_level"])',

  /** What a model above the account's plan opens instead of switching. */
  upgradeDialog: '[role="dialog"]:has-text("Upgrade"), mat-dialog-container:has-text("Upgrade")',
};

export type Selectors = { -readonly [K in keyof typeof consumerSelectors]: (typeof consumerSelectors)[K] extends RegExp ? RegExp : string };

/**
 * Gemini Enterprise (vertexaisearch.cloud.google.com / business.gemini.google)
 * is a different app: Lit web components (`ucs-*`) with open shadow roots,
 * which Playwright's CSS engine pierces, and Material 3 buttons. Signing out
 * there redirects to a separate sign-in host rather than showing a button.
 *
 * These are UNIONS with the consumer selectors, written from the app's
 * general structure: they have not been calibrated against every
 * organisation's tenant. `gemini-code probe` reports which of them match
 * on your signed-in page, and ~/.gemini-code/selectors.json overrides any of
 * them without a rebuild (see applySelectorOverrides).
 */
const enterpriseSelectors: Partial<Selectors> = {
  signInButton: 'button:has-text("Sign in"), a:has-text("Sign in"), md-filled-button:has-text("Sign in")',
  composerInput: 'div[contenteditable="true"], textarea',
  sendButton:
    'button[aria-label^="Send" i], button[aria-label^="Submit" i], md-icon-button[aria-label^="Send" i], md-icon-button[aria-label^="Submit" i]',
  uploadButton:
    'button[aria-label^="Upload" i], button[aria-label*="Add file" i], md-icon-button[aria-label^="Upload" i], md-icon-button[aria-label*="Add file" i]',
  stopButton: 'button[aria-label^="Stop" i], md-icon-button[aria-label^="Stop" i]',
  responseContainer: 'ucs-summary, [data-message-author-role="model"], .model-response-text',
  newChatButton:
    'button[aria-label^="New chat" i], md-text-button:has-text("New chat"), md-filled-tonal-button:has-text("New chat"), button:has-text("New chat")',
};

/**
 * The live selector table. Mutable so the Enterprise set and the user's own
 * overrides can be applied at startup; every module reads it through this
 * one object, so a change here reaches them all.
 */
export const selectors: Selectors = { ...consumerSelectors } as Selectors;

/**
 * Puts the right selector set in place: consumer or Enterprise, then the
 * user's overrides from a JSON file of `{ "<name>": "<css>" }` (a value
 * written as "/text/i" becomes a regular expression). Unknown names are
 * reported and skipped, so a typo doesn't silently do nothing.
 */
export function applySelectorOverrides(opts: { enterprise: boolean; overrides?: Record<string, unknown> }): string[] {
  Object.assign(selectors, consumerSelectors, opts.enterprise ? enterpriseSelectors : {});
  const notes: string[] = [];
  for (const [name, value] of Object.entries(opts.overrides ?? {})) {
    if (!(name in consumerSelectors)) {
      notes.push(`unknown selector "${name}" — ignored`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      notes.push(`selector "${name}" must be a non-empty string — ignored`);
      continue;
    }
    const isRegex = (consumerSelectors as Record<string, unknown>)[name] instanceof RegExp;
    const m = value.match(/^\/(.*)\/([a-z]*)$/s);
    if (isRegex) {
      try {
        (selectors as Record<string, unknown>)[name] = m ? new RegExp(m[1], m[2]) : new RegExp(value, "i");
      } catch (err) {
        notes.push(`selector "${name}": ${(err as Error).message} — ignored`);
      }
    } else {
      (selectors as Record<string, unknown>)[name] = value;
    }
  }
  return notes;
}
