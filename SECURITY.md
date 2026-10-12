# Security and deployment notes

This independent edition uses Telegram HMAC authentication, a separate operator key, per-operation administrator permissions, and a SQLite-backed Cloudflare Durable Object binding named `BOT_STATE`.

Deploy with the checked-in `wrangler.jsonc`. Uploading only two JavaScript modules without configuring the Durable Object binding and migration is no longer a complete installation. Missing durable state fails closed with HTTP 503. Use a test bot and test channel to verify Telegram behavior before production.

Configure `BOT_TOKEN`, `WEBHOOK_SECRET`, and `ADMIN_KEY` as distinct Cloudflare secrets. For a private bot, set `ADMINS_ID` to your own Telegram numeric IDs. Leaving that list empty intentionally permits all authenticated Telegram users. `ADMIN_KEY` is a trusted operator credential and can manage destinations independently of a Telegram user account.

## Permission policy

- Private messages are limited to the authenticated user's own private chat.
- Channel posting requires the user's `can_post_messages`; editing requires `can_edit_messages`; deletion requires `can_delete_messages`. Channel owners are allowed all operations. The bot's own permissions are also checked, and Telegram enforces the final operation.
- Group deletion requires `can_delete_messages`. Group editing is limited to the original author recorded by this application, the group owner, or the trusted operator. Messages sent before ownership tracking was introduced cannot be edited by another ordinary administrator through this API.
- Ephemeral modifications remain limited to the authenticated receiver; they require a group destination.

## Delivery and retention

Webhook processing finishes before HTTP 200 is returned. Temporary Telegram failures return 503 for redelivery. Successful side effects are checkpointed so a later failed step does not normally repeat earlier sends. Duplicate updates, including concurrent deliveries, are checked in durable storage for 24 hours.

Only update/payload digests, completion flags, rate counters, and group-message author IDs are persisted. Message text and bot credentials are not written to Durable Object storage. Update checkpoints expire after 24 hours; rate windows last one minute; group-message ownership metadata is retained so later editing remains authorized.

Telegram does not provide an idempotency key for sending messages. A timeout after Telegram accepted a request, or a crash between remote success and checkpoint storage, can leave its outcome unknown. This implementation does not claim exactly-once delivery across those ambiguous failures.

Authenticated API identities share a 60-request/minute limit; webhook users share a 20-update/minute limit. Excess user webhook updates return 503 with a retry delay and remain eligible for Telegram redelivery. The limit is shared through Durable Objects, rather than per-Worker memory.

## Browser data and external origins

Drafts, channels, keyboard state and chat IDs are loaded only from a namespace returned by an authenticated server connection. Account switches invalidate previous content and undo state. Old unassigned `tr-*` content is not imported automatically because its owner cannot be established. Browser storage is local plaintext; anyone with access to that browser profile can inspect it. Export valuable old drafts from the previous version before upgrading; the application does not delete those legacy keys automatically.

Drafts include their keyboard and send options. Storage failures keep the editor usable and report unsaved content. A settings control clears the current authenticated workspace.

Admin keys stay in memory. Connections to another HTTPS origin require explicit approval and an operator key; Telegram `initData` is never sent to another origin. Approve only Workers you control. External preview media and maps are opt-in, use HTTPS, and do not send referrers. Common private/loopback media URLs and IPv6 literals are blocked in preview. This browser-side policy is not a guarantee about DNS rebinding or what Telegram itself fetches when publishing media.

The page has a generated CSP with hashes for its inline scripts, no `unsafe-eval`, and restricted framing. Telegram's official SDK is still loaded from `telegram.org`. No Google Fonts request is required; formula fonts are bundled as WOFF2.

## Source provenance and history

This repository starts with a fresh snapshot of the corrected source based on [DarknessShade/TeleRich](https://github.com/DarknessShade/TeleRich). It is an independent GitHub repository; no upstream Git objects or commit history were imported. The original MIT copyright and license are retained.

The upstream history includes a historical `Channel Forwarder Bot` implementation with a fixed, non-removable owner and a literal bot-token-shaped credential. That implementation and credential are absent from this repository. Starting fresh does not erase copies in upstream or other forks and does not revoke the exposed token; the credential owner must revoke any still-active token. Never restore/deploy that implementation unchanged or reuse its credentials.

## Validation and reporting

Run `npm ci --ignore-scripts`, `npm run build`, `npm test`, `npm run test:browser`, `npm run check:secrets`, and `npm audit --audit-level=low`. Browser tests require `npx playwright install chromium`. CI also checks generated-module consistency and performs a Wrangler dry run. All test Telegram identities and credentials are synthetic; outbound Telegram calls are intercepted.

The source secret check is a limited pattern scan and does not certify all credential formats. Report suspected vulnerabilities privately to the repository owner before opening an issue containing sensitive data. Never paste real tokens into issues, logs, screenshots, or the web editor.
