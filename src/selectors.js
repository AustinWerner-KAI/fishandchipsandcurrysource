// Every LinkedIn selector lives here. When LinkedIn changes its markup, this is the file to fix.
// Each entry is a list of candidates tried in order.

export const SEL = {
  loggedInMarker: ['#global-nav', 'nav.global-nav', 'header.global-nav'],
  loginForm: ['#username', 'form.login__form', 'input[name="session_key"]'],

  // People search results
  searchResultLinks: ['a[href*="/in/"]'],
  searchNoResults: ['.search-reusables__no-results', 'h2:has-text("No results found")'],

  // Recruiter Lite contract chooser (blocks Talent URLs when a person has more than one contract)
  contractChooser: ['form[data-test-id="chooser-form"]', 'main:has-text("Choose a contract")', 'section:has(h1:has-text("Choose a contract"))'],
  recruiterLiteContract: ['div:has-text("Recruiter Lite") button:has-text("Select")', 'section:has(h4:has-text("Recruiter Lite")) button:has-text("Select")', 'button[aria-label*="Select Recruiter Lite"]'],

  // Locations filter on the people search page (used to turn "Dubai" into LinkedIn's location id)
  locationsFilterButton: ['button#searchFilter_geoUrn', 'button[aria-label*="Locations filter"]', 'button:has-text("Locations")'],
  locationsInput: ['input[aria-label="Add a location"]', 'input[placeholder="Add a location"]', '.search-reusables__filter-value-item input[type="text"]'],
  locationsSuggestion: ['.basic-typeahead__triggered-content [role="option"]', '.search-typeahead-v2__hit', '[role="listbox"] [role="option"]', '.basic-typeahead__selectable'],
  locationsShowResults: ['button[aria-label="Apply current filter to show results"]', 'button:has(span:text-is("Show results"))'],

  // Profile page. Action buttons are looked up inside the top card (the section holding the h1)
  // and by the person's name, so a "People you may know" card further down can never be clicked.
  topCard: ['main section:has(h1)', 'main .pv-top-card', 'main'],
  profileName: ['main h1', 'h1.text-heading-xlarge'],
  profileHeadline: ['main .text-body-medium.break-words', 'main div.text-body-medium'],
  profileDegree: ['main span.dist-value', 'main .distance-badge span.dist-value', 'main span:has-text("1st")'],
  // relative to the top card; {name} is replaced with the profile's name
  connectButton: ['button[aria-label="Invite {name} to connect"]', 'button[aria-label$="to connect"]', 'button:has(span:text-is("Connect"))'],
  moreActionsButton: ['button[aria-label="More actions"]', 'button:has(span:text-is("More"))'],
  moreMenuConnect: ['[aria-label="Invite {name} to connect"]', '[role="button"][aria-label$="to connect"]'],
  pendingButton: ['button[aria-label^="Pending"]', 'button:has(span:text-is("Pending"))'],
  messageButton: ['button[aria-label="Message {name}"]', 'button[aria-label^="Message"]', 'button:has(span:text-is("Message"))'],
  followButton: ['button[aria-label^="Follow"]'],
  inmailMarker: ['input[name="subject"]', '.msg-form input[placeholder*="Subject"]', 'text=/InMail/i'],

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

// CSS attribute-value escaping for names with quotes or backslashes.
export function cssStr(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function withName(candidates, name) {
  return candidates
    .filter(sel => !sel.includes('{name}') || name)
    .map(sel => sel.replace('{name}', cssStr(name || '')));
}

// Returns the first candidate selector that exists on the page (or within `scope`), or null.
export async function firstVisible(scope, candidates, timeout = 1500) {
  for (const sel of candidates) {
    try {
      const loc = scope.locator(sel).first();
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
