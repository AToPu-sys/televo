/** Tracks which conversation, if any, is currently on screen.
 *
 * A plain module-level variable rather than React state/context on purpose:
 * the one consumer that matters (the push-notification handler in
 * useMessageNotifications) reads it from inside a Notifications listener
 * callback, which fires outside React's render cycle — there's no component
 * tree position to read context from there, and wiring this through props
 * would mean threading "which chat is open" up to the root from every chat
 * screen for a single boolean read. app/chat/[id].tsx sets this on mount and
 * clears it on unmount (see its own effect).
 */
let currentConversationId: string | null = null;

export function setCurrentConversationId(id: string | null): void {
  currentConversationId = id;
}

export function getCurrentConversationId(): string | null {
  return currentConversationId;
}
