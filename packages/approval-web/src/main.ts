import './styles.css';
import { ApiError, ApprovalApi, captureCapability } from './api';
import { actionFields, expirationTime, freezeAction, validAddress, walletPayload, type ApprovalSession, type FieldNode } from './model';
import { ApprovalWallet, walletError, type EvmProvider } from './wallet';
const root = document.querySelector<HTMLElement>('#app')!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    if (text !== undefined)
        node.textContent = text;
    return node;
}
const paths: Record<string, string> = { shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M9 12l2 2 4-4', document: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z M14 2v6h6 M8 13h8 M8 17h5', wallet: 'M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H5a3 3 0 0 1-3-3V6 M20 12h-5v5h5 M16 14.5h.01', check: 'm5 12 4 4L19 6', clock: 'M12 8v4l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', key: 'M9 15a5 5 0 1 1 3-9l10 10v4h-4v-3h-3l-3-3 M6 7h.01', chevron: 'm9 6 6 6-6 6', info: 'M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0' };
function icon(name: string): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[name] ?? paths.info);
    svg.append(path);
    return svg;
}
function card(title: string, iconName: string): HTMLElement {
    const section = el('section', 'card');
    const heading = el('h2', 'section-heading');
    heading.append(icon(iconName), el('span', '', title));
    section.append(heading);
    return section;
}
function row(label: string, value: string, mono = false): HTMLElement {
    const item = el('div', 'info-row');
    item.append(el('dt', '', label), el('dd', mono ? 'mono' : '', value));
    return item;
}
function button(label: string, style: string, fn: () => void, disabled = false): HTMLButtonElement {
    const control = el('button', style, label);
    control.type = 'button';
    control.disabled = disabled;
    control.addEventListener('click', fn);
    return control;
}
function fieldView(field: FieldNode): HTMLElement {
    const name = el('span', 'field-name', field.name), type = el('span', 'field-type', field.type);
    if (field.children) {
        const details = el('details', 'typed-group');
        const summary = el('summary');
        summary.append(icon('chevron'), name, type);
        details.append(summary);
        const children = el('div', 'typed-children');
        if (!field.children.length)
            children.append(el('p', 'muted', 'Empty array'));
        field.children.forEach(field => children.append(fieldView(field)));
        details.append(children);
        return details;
    }
    const node = el('div', 'typed-field');
    const label = el('div', 'field-label');
    label.append(name, type);
    node.append(label, el('p', 'field-value', field.value));
    return node;
}
interface WalletChoice {
    id: string;
    name: string;
    provider: EvmProvider;
}
let session: ApprovalSession | undefined, api: ApprovalApi, wallet: ApprovalWallet | undefined;
let error = '', operation = false, configReady = false, projectId: string | undefined, connectedName = '';
let frozenIdentity = '', polling = false, broken = false;
let mobileAttempted = false;
const wallets: WalletChoice[] = [];
const statuses = { pending: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected', consumed: 'Used by requester', expired: 'Expired' };
const circuitNames: Record<string, string> = { giwa_attestation: 'GIWA KYC', arc_eligibility: 'Coinbase KYC (Arc)' };
function pending(): boolean { return !broken && session?.status === 'pending' && expirationTime(session.expiresAt) > Date.now(); }
function report(cause: unknown): void { error = cause instanceof ApiError ? cause.message : walletError(cause); render(); }
async function connect(choice: WalletChoice): Promise<void> {
    if (!pending() || operation)
        return;
    error = '';
    connectedName = choice.name;
    try {
        await wallet!.connect(choice.provider);
    }
    catch (cause) {
        report(cause);
    }
    render();
}
async function disconnectMobile(): Promise<void> {
    if (!pending() || operation || wallet?.busy)
        return;
    operation = true;
    error = '';
    // Stop approval listeners and clear its address before ending the session.
    wallet?.dispose();
    render();
    try {
        const { resetMobileWallet } = await import('./walletconnect');
        await resetMobileWallet();
        connectedName = '';
        mobileAttempted = false;
    }
    catch (cause) { report(cause); }
    finally { operation = false; render(); }
}
function identity(value: ApprovalSession): string { return JSON.stringify([value.approvalId, value.circuit, value.scope, value.expectedSigner, value.expiresAt, walletPayload(value.action)]); }
function accept(value: ApprovalSession, initial = false): void {
    if (!value || !Object.hasOwn(statuses, value.status) || typeof value.circuit !== 'string' || !value.circuit || typeof value.scope !== 'string' || !value.scope || !expirationTime(value.expiresAt) || (value.expectedSigner !== undefined && !validAddress(value.expectedSigner)))
        throw new ApiError('This proof request is incomplete. Ask the requester for a new link.');
    const action = freezeAction(value.action);
    const next = { ...value, action };
    if (!initial && identity(next) !== frozenIdentity) {
        broken = true;
        wallet?.invalidate();
        throw new ApiError('The request details changed. Signing is disabled. Ask the requester for a new link.');
    }
    if (initial)
        frozenIdentity = identity(next);
    session = next;
    if (session.status === 'approved' || session.status === 'consumed')
        error = '';
    if (!pending() && wallet?.address)
        wallet.invalidate();
}
async function refresh(): Promise<void> {
    if (polling || !session || broken)
        return;
    polling = true;
    try {
        const previousStatus = session.status;
        const previousError = error;
        accept(await api.read());
        // Avoid rebuilding focused controls and open disclosures on unchanged polls.
        if (session.status !== previousStatus || error !== previousError)
            render();
    }
    catch (cause) {
        report(cause);
    }
    finally {
        polling = false;
    }
}
async function reject(): Promise<void> {
    if (!pending() || operation)
        return;
    operation = true;
    error = '';
    wallet?.invalidate();
    render();
    try {
        await api.reject();
        await refresh();
    }
    catch (cause) {
        report(cause);
    }
    finally {
        operation = false;
        render();
    }
}
function render(): void {
    if (session?.status === 'pending' && expirationTime(session.expiresAt) <= Date.now()) {
        session = { ...session, status: 'expired' };
        if (wallet) {
            // Invalidation notifies this renderer with the new terminal state.
            wallet.invalidate();
            return;
        }
    }
    const expanded = [...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d => d.dataset.key);
    const previousTerminal = root.querySelector<HTMLElement>('.terminal');
    const previousTerminalStatus = previousTerminal?.dataset.status;
    const terminalHadFocus = previousTerminal !== null && previousTerminal === document.activeElement;
    root.replaceChildren();
    root.setAttribute('aria-busy', 'false');
    const brand = el('header', 'brand');
    const wordmark = el('div', 'wordmark');
    wordmark.append(icon('shield'), el('span', '', 'ZKProofport'));
    brand.append(wordmark, el('span', 'header-label', 'WALLET APPROVAL'));
    root.append(brand);
    const intro = el('div', 'intro');
    intro.append(el('p', 'eyebrow', 'PROOF REQUEST'), el('h1', '', 'Review proof request'), el('p', 'subtitle', 'Review the conditions and exact action before approving with your credential wallet.'));
    root.append(intro);
    if (error) {
        const alert = el('div', 'alert', error);
        alert.setAttribute('role', 'alert');
        root.append(alert);
    }
    if (!session)
        return;
    const request = card('Request details', 'document');
    const identityRow = el('div', 'request-identity');
    const tile = el('div', 'icon-tile');
    tile.append(icon('shield'));
    const titles = el('div');
    titles.append(el('p', 'muted small', 'APPLICATION-PROVIDED NAME'), el('h3', 'request-title', session.action.domain.name));
    identityRow.append(tile, titles);
    request.append(identityRow, el('p', 'card-note requester-note', 'This name is supplied by the requesting application.'));
    const statusRow = el('div', 'request-meta');
    statusRow.append(el('span', `status ${session.status}`, statuses[session.status]));
    const expiry = el('span', 'expiry');
    expiry.append(icon('clock'), el('span', '', `Expires ${new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
    expiry.title = session.expiresAt;
    statusRow.append(expiry);
    request.append(statusRow);
    root.append(request);
    const conditions = card('Proof conditions', 'shield');
    const conditionsList = el('dl', 'rows');
    conditionsList.append(row('Credential', Object.hasOwn(circuitNames, session.circuit) ? circuitNames[session.circuit] : session.circuit), row('Scope', session.scope), row('Expected signing wallet', session.expectedSigner ?? 'Connect the wallet holding your credential.', !!session.expectedSigner));
    conditions.append(conditionsList);
    root.append(conditions);
    const action = card('Action to sign', 'document');
    action.append(el('p', 'card-note', 'The requesting application defines this action. Your wallet signs the exact type and values shown below.'));
    const actionDetails = el('details', 'action-details');
    const actionSummary = el('summary', 'action-type');
    const actionTitle = el('span');
    actionTitle.append(el('span', 'muted small', 'PRIMARY TYPE'), el('strong', '', session.action.primaryType));
    actionSummary.append(actionTitle, icon('chevron'));
    actionDetails.append(actionSummary);
    const fields = el('div', 'fields');
    actionFields(session.action).forEach(field => fields.append(fieldView(field)));
    actionDetails.append(fields);
    action.append(actionDetails, el('p', 'small muted action-hint', 'Expand to review the exact fields your wallet will sign.'));
    root.append(action);
    const disclosure = card('What this request shares', 'eye');
    for (const [glyph, title, body] of [['shield', 'Requested proof', 'A credential proof for the circuit and scope above, bound to this action.'], ['eye', 'Shared with the service and requester', 'Your wallet address and action signature. The resulting proof follows the selected circuit’s disclosure rules.'], ['key', 'Stays in your wallet', 'This page never requests your private key or recovery phrase.']]) {
        const item = el('div', 'disclosure');
        item.append(icon(glyph));
        const text = el('div');
        text.append(el('h3', '', title), el('p', '', body));
        item.append(text);
        disclosure.append(item);
    }
    root.append(disclosure);
    const technical = el('details', 'card technical');
    const technicalSummary = el('summary', 'section-heading');
    technicalSummary.append(icon('info'), el('span', '', 'Signing details'), icon('chevron'));
    technical.append(technicalSummary);
    const technicalList = el('dl', 'rows');
    technicalList.append(row('Circuit ID', session.circuit, true), row('Domain', session.action.domain.name), row('Version', session.action.domain.version), row('Network', `Chain ${session.action.domain.chainId}`), row('Verifying contract', session.action.domain.verifyingContract, true), row('Signature format', 'EIP-712 · externally owned account'), row('Request expires', new Date(session.expiresAt).toLocaleString()));
    technical.append(technicalList, el('p', 'card-note', 'Approval expiry does not revoke an action signature. The requesting application defines its validity and use.'));
    root.append(technical);
    // Keep the numeric chain visible even when technical details are collapsed.
    technicalSummary.append(el('span', 'chain-label', `Chain ${session.action.domain.chainId}`));
    if (pending()) {
        const walletCard = card(wallet?.address ? 'Connected wallet' : 'Choose your wallet', 'wallet');
        if (wallet?.address) {
            const connected = el('div', 'connected');
            connected.append(icon('check'), el('strong', '', connectedName), el('p', 'mono', wallet.address), el('span', 'muted small', `Chain ${session.action.domain.chainId}`));
            walletCard.append(connected, button('Change wallet', 'text-button', () => { wallet?.invalidate(); error = ''; render(); }, wallet.busy));
            if (connectedName === 'WalletConnect')
                walletCard.append(button('Disconnect mobile wallet', 'wallet-option', () => void disconnectMobile(), operation || wallet.busy));
        }
        else {
            walletCard.append(el('p', 'card-note', `Use your credential wallet on chain ${session.action.domain.chainId}. Connecting does not sign the action.`));
            wallets.forEach(choice => walletCard.append(button(choice.name, 'wallet-option', () => void connect(choice), !!wallet?.busy || operation)));
            if (!wallets.length)
                walletCard.append(el('p', 'muted small', 'No browser wallets detected. Open this page in a compatible wallet browser, or connect a mobile wallet.'));
            walletCard.append(button('Connect mobile wallet', 'wallet-option', () => void (async () => { if (!projectId || operation)
                return; operation = true; mobileAttempted = true; error = ''; wallet?.dispose(); render(); try {
                const { mobileWallet } = await import('./walletconnect');
                const provider = await mobileWallet(projectId, session!.action.domain.chainId);
                operation = false;
                await connect({ id: 'walletconnect', name: 'WalletConnect', provider });
            }
            catch (cause) {
                report(cause);
            }
            finally {
                operation = false;
                render();
            } })(), !projectId || !configReady || operation || !!wallet?.busy));
            if (configReady && !projectId)
                walletCard.append(el('p', 'muted small', 'Mobile wallet connection is not configured. Use an available browser wallet.'));
            if (mobileAttempted) {
                walletCard.append(button('Reset mobile connection', 'wallet-option', () => void disconnectMobile(), operation || !!wallet?.busy));
                walletCard.append(el('p', 'card-note', 'A saved session may be reused without a QR code. Reset it, then connect again to pair your wallet with a new QR code.'));
            }
        }
        root.append(walletCard);
        const actions = el('section', 'actions');
        if (error) {
            const feedback = el('p', 'alert signing-feedback', error);
            feedback.setAttribute('role', 'alert');
            actions.append(feedback);
        }
        else if (wallet?.busy) {
            const feedback = el('p', 'signing-feedback muted', 'Waiting for your wallet and confirmation from the server. Keep this page open.');
            feedback.setAttribute('role', 'status');
            actions.append(feedback);
        }
        actions.append(button(wallet?.busy ? 'Waiting for wallet…' : 'Review and sign', 'primary', () => void (async () => { error = ''; try {
            await wallet!.sign();
        }
        catch (cause) {
            report(cause);
        } render(); })(), !wallet?.address || wallet.busy || operation), button('Reject request', 'secondary', () => void reject(), operation));
        actions.append(el('p', 'action-note', 'Approval lets the requester continue generating the proof. Signing an action can authorize its use by the requesting application.'));
        root.append(actions);
    }
    else {
        const terminal = card(({ approved: 'Approval complete', rejected: 'Request rejected', consumed: 'Approval used', expired: 'Request expired', pending: 'Signing unavailable' })[session.status], session.status === 'approved' ? 'check' : 'info');
        terminal.classList.add('terminal');
        terminal.dataset.status = session.status;
        if (session.status === 'approved' || session.status === 'consumed')
            terminal.classList.add('success');
        terminal.setAttribute('aria-live', 'polite');
        terminal.tabIndex = -1;
        const copy = { approved: 'The requester can now continue proof generation. This is not a transaction confirmation.', rejected: 'No approval was granted. You can close this page.', consumed: 'The requester has used this approval to continue the proof flow.', expired: 'This request can no longer be approved. Ask the requester for a new link.', pending: 'Ask the requester for a new approval link.' };
        terminal.append(el('p', 'card-note', copy[session.status]));
        root.append(terminal);
        if (terminalHadFocus || previousTerminalStatus !== session.status)
            terminal.focus({ preventScroll: true });
        if (previousTerminalStatus !== session.status)
            terminal.scrollIntoView({ block: 'center' });
    }
    const footer = el('footer');
    footer.append(icon('shield'), el('span', '', 'ZKProofport · Wallet-held credentials'));
    root.append(footer);
    root.querySelectorAll<HTMLDetailsElement>('details').forEach((details, i) => { details.dataset.key = String(i); details.open = expanded.includes(String(i)); });
}
window.addEventListener('eip6963:announceProvider', ((event: CustomEvent) => {
    const { info, provider } = event.detail ?? {};
    if (!info || typeof info.uuid !== 'string' || typeof info.name !== 'string' || !provider || typeof provider.request !== 'function' || wallets.some(w => w.id === info.uuid) || wallets.length >= 20)
        return;
    wallets.push({ id: info.uuid, name: info.name.slice(0, 80), provider });
    if (session)
        render();
}) as EventListener);
async function start(): Promise<void> {
    try {
        let storage: Storage | undefined;
        try {
            storage = window.sessionStorage;
        }
        catch { /* blocked storage is optional */ }
        const capability = captureCapability(location, path => history.replaceState(null, '', path), storage);
        api = new ApprovalApi(capability.id, capability.token);
        const initial = await api.read();
        if (initial.approvalId !== capability.id)
            throw new ApiError('This approval link does not match its request.');
        accept(initial, true);
        wallet = new ApprovalWallet(session!.action, session!.expectedSigner, pending, async (address, signature) => { await api.approve(address, signature); await refresh(); }, message => { if (message)
            error = message; render(); });
        render();
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        try {
            const config = await api.config();
            if (typeof config.walletConnectProjectId === 'string' && config.walletConnectProjectId)
                projectId = config.walletConnectProjectId;
        }
        catch { /* Injected wallets remain usable if optional configuration is unavailable. */ }
        configReady = true;
        render();
        setInterval(() => { if (!session || broken)
            return; if (session.status === 'pending' || session.status === 'approved')
            void refresh(); }, 4000);
        setInterval(() => { if (session?.status === 'pending' && expirationTime(session.expiresAt) <= Date.now())
            render(); }, 1000);
        window.addEventListener('pagehide', () => wallet?.dispose(), { once: true });
    }
    catch (cause) {
        broken = true;
        error = cause instanceof ApiError ? cause.message : 'This proof request could not be safely displayed. Ask the requester for a new link.';
        render();
    }
}
void start();
