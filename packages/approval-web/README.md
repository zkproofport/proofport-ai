# Human action approval page

Private Vite + TypeScript workspace for the AI service's `/approve/:id` page.
The server serves the generated `public/approval/index.html` at that route and
the generated assets at `/approval/`. Generated files are not committed.
Node 20.19+ or 22.12+ is required by Vite 8.

From the AI repository root:

```sh
npm run build --workspace @zkproofport-ai/approval-web
npm run test --workspace @zkproofport-ai/approval-web
npx playwright install chromium
npm run test:browser --workspace @zkproofport-ai/approval-web
```

`APPROVAL_SCREENSHOT_DIR` optionally selects the browser screenshot output
directory. Otherwise screenshots are written to the OS temporary directory.
The repository-owned browser test intercepts a virtual HTTPS origin and serves
the production bundle without starting a development server. Its injected
wallet and approval API are simulated. It does not demonstrate real wallet
pairing, a real WalletConnect signature, or a paid proof.

The app uses the mobile app's dark Proofport palette and review-card hierarchy.
All request-provided values are text nodes. Typed fields follow schema order;
structs and arrays use native disclosures. Unknown chain IDs display their
actual numeric value. The signing payload freezes the exact action and derives
only the standard EIP712Domain schema. Only EOA signatures are supported.

The browser capability arrives in the fragment, is removed immediately during
bootstrap, and is retained in memory and per-tab session storage for refresh.
API calls send it only in the Authorization header. The HTML and requests use
no-referrer; API requests disable caching and redirects. Server routes must
also send no-store/no-referrer headers and keep capabilities/signatures out of
logs. Terminal status responses never need to return a signature.

Browser wallets are discovered through EIP-6963 and selected explicitly.
Mobile wallet support requires the server's config endpoint to return an
explicit `walletConnectProjectId`; otherwise the page explains its absence.
The official WalletConnect EthereumProvider and its QR modal are bundled and
loaded only after the user chooses mobile connection. The metadata URL is the
origin alone. No capability or request identifier is passed to WalletConnect.
One provider is reused per page, including cancelled pairing retries; an active
session with the requested chain and signing permission is reused without another pairing.
The requested, already approved chain is selected through WalletConnect's public
API before checking the session: its restored wrapper and internal EIP-155
default can disagree. Chain checks accept hexadecimal EIP-1193 strings and safe
integer responses and still enforce the exact action domain before and after signing.
An unsuccessful connection offers **Reset mobile connection**; an established
mobile connection offers **Disconnect mobile wallet**. Both end the session without
creating another Core. The next connection opens a new pairing. Reset is disabled
while pairing or signing, and never deletes unrelated browser storage. Unsupported
chains remain explicit errors; no chain or RPC URL is guessed.

Review/sign rechecks account and chain both before and after the wallet prompt.
Account/network/disconnect events invalidate the selection. A failed approval
POST is never automatically resubmitted because its server outcome can be
unknown; reload to read the stored request status.

Official integration references:

- [EIP-6963 wallet discovery](https://eips.ethereum.org/EIPS/eip-6963)
- [WalletConnect Ethereum provider](https://docs.reown.com/advanced/providers/ethereum)
- [Vite production build](https://vite.dev/guide/build)
