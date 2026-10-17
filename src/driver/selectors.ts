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
export const selectors = {
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
  gemLink: 'a[href^="/gem/"]',

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

  /** Items inside the opened model picker menu. */
  modeMenuItem: '[role="menuitem"]',
} as const;
