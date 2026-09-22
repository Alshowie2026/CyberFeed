# UI Contract

Extend the existing single page and preserve its English UI language. Arabic usernames/passwords are accepted. No frontend framework is needed. Use a modern cybersecurity-inspired dark navy and mint theme, a top navigation bar, and a floating pencil button for immediate access to the composer.

## Navigation and layout

The sticky top navigation shows CyberFeed and either the signed-in username with an Exit button, or a Login button for visitors. Login opens an inline account panel with sign-in and registration modes; it can be closed without navigation. Successful login closes the panel. Expired-session publication opens it again while retaining the draft.

The floating pencil button stays at the bottom-right while scrolling, for visitors and signed-in users. Activating it opens a modal post editor and focuses the text field. Closing the editor with its close button or Escape preserves the draft. Visitors can draft before signing in; Login to publish opens the account panel, then successful sign-in reopens their editor without automatically submitting. Successful publication clears the draft and closes the editor. Layout remains usable on narrow screens, with keyboard focus indicators and a skip-to-posts link.

## Visitor

Feed remains visible. Show Sign in and Create account modes with labeled username/password fields, password masking, appropriate autocomplete (username, current-password/new-password), visible validation guidance, and aria-live feedback. Disable duplicate submission while pending, restore controls on failure, and focus the relevant field. Password inputs are cleared after success or mode changes and are never stored in local/session storage.

Registration success switches to Sign in, pre-fills the returned username, clears the password and announces success. It does not sign the user in automatically. Visitor publish controls explain that sign-in is required.

## Authenticated

Show the server-returned username and Sign out. Remove the editable author-name field from the composer; only text is submitted. Load /api/auth/me on initial page load and when a tab regains focus. Broadcast a non-secret auth-changed notification using BroadcastChannel where available; re-fetch /me rather than broadcasting credentials. Server-side checks enforce logout even if another tab has stale visual state.

Login success returns to the composer in the same page. Switching account or signing out does not relabel previously published posts.

## Drafts and errors

Keep the text area value in page memory during 401, network error, service failure or login mode changes. Do not reload or recreate the composer on these transitions. Clear draft only after confirmed successful publication. Draft persistence across page refresh or browser closure is not promised by this feature.

On 401, transition to visitor/sign-in mode and retain the draft. For a lost publication response, say the result could not be confirmed and ask the user to check the feed before retrying; never auto-resubmit. For 429, show retry guidance from Retry-After without revealing whether the account exists. A failed logout keeps the authenticated display and offers retry rather than declaring success.

Use textContent for usernames, post content and error strings. Keyboard navigation, labeled controls, readable focus indicators and existing mobile layout must continue to work.
