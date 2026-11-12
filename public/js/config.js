// Where murmur lives. The same files are also served from other addresses (a home server,
// localhost); these two point back to the public copy.

/** Address that share links point to. Empty: wherever the page was opened. */
export const PUBLIC_URL = 'https://murmur.kemmerling.me/';

/** An https address, offered when the page was opened without https (no microphone there). */
export const SECURE_URL = PUBLIC_URL;
