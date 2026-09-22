// Every LinkedIn selector lives here. When LinkedIn changes its markup, this is the file to fix.
// Each entry is a list of candidates tried in order.

export const SEL = {
  loggedInMarker: ['#global-nav', 'nav.global-nav', 'header.global-nav'],
  loginForm: ['#username', 'form.login__form', 'input[name="session_key"]'],

  // People search results
  searchResultLinks: ['a[href*="/in/"]'],
  searchNoResults: ['.search-reusables__no-results', 'h2:has-text("No results found")'],

  // Profile page
  profileName: ['main h1', 'h1.text-heading-xlarge'],
  profileHeadline: ['main .text-body-medium.break-words', 'main div.text-body-medium'],
  profileDegree: ['main span.dist-value', 'main .distance-badge span.dist-value', 'main span:has-text("1st")'],
  connectButton: [
    'main button[aria-label^="Invite"][aria-label$="to connect"]',
    'main button[aria-label*="to connect"]',
    'main .pvs-profile-actions button:has-text("Connect")',
    'main button:has(span:text-is("Connect"))',
  ],
  moreActionsButton: ['main button[aria-label="More actions"]', 'main .pvs-profile-actions button:has-text("More")', 'main button:has(span:text-is("More"))'],
  moreMenuConnect: [
    'div[aria-label*="to connect"]',
    '.artdeco-dropdown__content div[role="button"]:has-text("Connect")',
    'li:has-text("Connect") div[role="button"]',
  ],
  pendingButton: ['main button[aria-label^="Pending"]', 'main button:has(span:text-is("Pending"))'],
  messageButton: ['main button[aria-label^="Message"]', 'main a[href*="/messaging/"]', 'main button:has(span:text-is("Message"))'],
  followButton: ['main button[aria-label^="Follow"]'],

  // Invitation modal
  addNoteButton: ['button[aria-label="Add a note"]', 'button:has(span:text-is("Add a note"))'],
  noteTextarea: ['textarea#custom-message', 'textarea[name="message"]', '.artdeco-modal textarea'],
  sendInviteButton: [
    'button[aria-label="Send invitation"]',
    'button[aria-label="Send now"]',
    'button[aria-label="Send without a note"]',
    '.artdeco-modal button:has(span:text-is("Send"))',
  ],
  modalDismiss: ['button[aria-label="Dismiss"]', '.artdeco-modal__dismiss'],
  weeklyLimitText: ['text=/weekly invitation limit/i', 'text=/reached the weekly/i', 'text=/You.ve reached the .*limit/i'],
  emailRequiredInput: ['.artdeco-modal input[type="email"]', 'input[name="email"]'],

  // Messaging overlay (opens from the profile Message button)
  msgOverlay: ['.msg-overlay-conversation-bubble', '.msg-overlay-bubble-header', '.msg-form'],
  msgEditor: ['.msg-form__contenteditable[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]'],
  msgSend: ['button.msg-form__send-button', 'button[type="submit"].msg-form__send-btn', '.msg-form button:has(span:text-is("Send"))'],
  msgGroupName: ['.msg-s-message-group__name', '.msg-s-message-group__profile-link'],
  msgBody: ['.msg-s-event-listitem__body'],
  msgOverlayClose: [
    '.msg-overlay-bubble-header button[data-control-name="overlay.close_conversation_window"]',
    '.msg-overlay-bubble-header__controls button:last-child',
    'button[aria-label^="Close your conversation"]',
  ],
};

// Returns the first candidate selector that exists on the page, or null.
export async function firstVisible(page, candidates, timeout = 1500) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch {
      // try next
    }
  }
  return null;
}

export async function anyPresent(page, candidates, timeout = 1000) {
  return !!(await firstVisible(page, candidates, timeout));
}
