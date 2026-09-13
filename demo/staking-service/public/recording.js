const $ = id => document.getElementById(id);
const labels = ['Instruction received', 'Credential policy checked', 'Prover discovered', 'Exact-action authorization', 'Payment & proof', 'Proof verified on Arc', 'On-chain stake'];
const descriptions = ['Waiting for your instruction', 'Check Coinbase KYC policy and Wallet B', 'Discover through the dApp Agent Marketplace', 'Bind Wallet B, amount, action, nonce and deadline', 'Approve 0.001 USDC, then generate one proof', 'Check eligibility and the exact authorized action', 'Approve and deposit USDC from Wallet B'];
const checkLabels = {coinbasePolicy:'Coinbase KYC', authorizedActor:'Authorized wallet', exactAction:'Exact action', nonceUnused:'Unused nonce', deadlineValid:'Valid deadline'};
let active = false;
let currentRunId = null;
let terminalRun = null;
let streamConnected = false;
let lastTerminalSignature = '';
let walletSnapshot = null;
let refreshing = false;
let walletRefreshing = false;
const expandedEvents = new Set();
let shownPermission = null;
const shortAddress = value => typeof value === 'string' ? `${value.slice(0, 8)}…${value.slice(-6)}` : 'Wallet B';
const deadline = value => { const date = new Date(Number(value) * 1000); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', {hour12:false, timeZone:'Asia/Seoul'}) + ' KST' : 'Not prepared'; };
function fitInstruction() {
  const field = $('instruction');
  // Reset first so deleting text also reduces the height. The two pixels include its borders.
  field.style.height = 'auto';
  field.style.height = `${Math.max(104, field.scrollHeight + 2)}px`;
}
function observedResults(run) {
  const results = {};
  for (const line of run?.terminal?.lines ?? []) {
    if (line.kind !== 'tool_result' || typeof line.text !== 'string') continue;
    const match = /^mcp__ledger_house__(\w+)\s+(\{[\s\S]*\})$/.exec(line.text);
    if (!match) continue;
    try { const value = JSON.parse(match[2]); if (value?.ok === true) results[match[1]] = value; } catch { /* Incomplete or non-JSON events cannot establish success. */ }
  }
  return results;
}
function pendingTool(run, name) {
  const last = (run?.terminal?.lines ?? []).filter(line => ['tool_call', 'tool_result'].includes(line.kind) && typeof line.text === 'string' && line.text.startsWith(`mcp__ledger_house__${name} `)).at(-1);
  return run?.status === 'running' && last?.kind === 'tool_call';
}
function safeLink(id, url) {
  if (!url) return;
  try { const parsed = new URL(url, location.origin); if (!['http:', 'https:'].includes(parsed.protocol)) return; $(id).href = parsed.href; $(id).hidden = false; } catch { /* Invalid links remain unavailable. */ }
}
function renderWallet(snapshot, run, results = {}) {
  const wallet = results.prepare_delegation?.wallet ?? run?.wallet ?? snapshot?.wallet;
  $('wallet-address').textContent = wallet || 'Wallet unavailable';
  const kyc = results.read_dapp?.directKyc ?? snapshot?.directKyc;
  const known = kyc?.status === 'found' || kyc?.status === 'not_found';
  $('wallet-kyc').textContent = known ? (kyc.status === 'not_found' ? 'NOT FOUND' : 'FOUND') : 'NOT CHECKED';
  $('wallet-kyc').className = known ? (kyc.status === 'not_found' ? 'status-warning' : 'status-confirmed') : 'status-pending';
  $('wallet-kyc-detail').textContent = known ? `${kyc.source || 'Base EAS'} · ${kyc.checkedAt ? 'checked ' + new Date(kyc.checkedAt).toLocaleTimeString('en-GB', {hour12:false}) : 'checked by the dApp'}` : 'Direct Coinbase KYC has not been confirmed.';
  $('requirement-detail').textContent = kyc?.status === 'not_found' ? 'Wallet B direct KYC: NOT FOUND · private eligibility proof required.' : 'KYC + action authorization proof · the credential holder stays private.';
  const stake = results.stake;
  const before = stake?.positionBefore ?? results.read_dapp?.positionBefore;
  const after = stake?.positionAfter;
  const current = after ?? before ?? snapshot?.positionUSDC;
  $('position-value').textContent = current != null ? `${current} USDC` : '— USDC';
  $('position-change').textContent = before != null && after != null ? `${before} → ${after} USDC · confirmed on Arc` : 'Read from the Arc staking contract';
}
function renderProverMcp(run) {
  const mcp = run?.protocol?.proverMcp;
  const states = {connected:'CONNECTED', calling:'CALLING', returned:'RETURNED'};
  const observed = mcp && Object.hasOwn(states, mcp.status);
  $('mcp-status').textContent = observed ? states[mcp.status] : 'WAITING';
  $('mcp-status').className = observed ? 'status-confirmed' : 'status-pending';
  let endpoint = '';
  try { endpoint = mcp?.endpoint ? new URL(mcp.endpoint).hostname : ''; } catch { /* Never infer an endpoint from malformed evidence. */ }
  $('mcp-server').textContent = observed ? [mcp.serverName ? mcp.serverName + (mcp.version ? ' v' + mcp.version : '') : 'Server identity unavailable', mcp.transport, endpoint].filter(Boolean).join(' · ') : 'Awaiting the actual prover MCP handshake';
  const npmObserved = observed && mcp.packageSource === 'npm';
  $('mcp-packages').hidden = !npmObserved;
  $('mcp-packages').textContent = npmObserved ? ['npm', mcp.mcpVersion ? `MCP ${mcp.mcpVersion}` : '', mcp.sdkVersion ? `SDK ${mcp.sdkVersion}` : ''].filter(Boolean).join(' · ') : '';
  $('mcp-call').textContent = observed && mcp.tool ? [mcp.tool, mcp.status === 'calling' ? 'actual tools/call in progress' : mcp.status === 'returned' ? 'actual tools/call response' : '', mcp.proofBytes != null ? `${mcp.proofBytes} proof bytes` : '', mcp.publicInputCount != null ? `${mcp.publicInputCount} public inputs` : ''].filter(Boolean).join(' · ') : observed ? 'Handshake observed · awaiting a prover tool call' : 'No prover MCP call observed yet';
  $('mcp-details').textContent = observed ? JSON.stringify({serverName:mcp.serverName, version:mcp.version, packageSource:mcp.packageSource, mcpVersion:mcp.mcpVersion, sdkVersion:mcp.sdkVersion, endpoint:mcp.endpoint, transport:mcp.transport, status:mcp.status, tool:mcp.tool, arguments:mcp.arguments, proofBytes:mcp.proofBytes, publicInputCount:mcp.publicInputCount, observedAt:mcp.observedAt}, null, 2) : 'Actual connection and tool arguments appear here when observed.';
}
function renderEvidence(run, results) {
  renderProverMcp(run);
  const installation = results.install_prover_mcp;
  $('mcp-installation').textContent = installation?.ok === true ? `✓ npm installed · MCP ${installation.mcpVersion} · SDK ${installation.sdkVersion}` : results.read_prover_guide ? 'Provider installation instructions read · awaiting npm install' : 'Install from npm after reading provider instructions';
  const payment = run?.protocol?.payment;
  const paid = payment?.status === 'confirmed';
  $('payment-status').textContent = paid ? `✓ ${payment.fee || '0.001'} USDC PAID` : payment?.status === 'pending' ? 'PROCESSING' : 'WAITING';
  $('payment-status').className = paid ? 'status-confirmed' : 'status-pending';
  $('payment-detail').textContent = paid ? (payment.beforeUSDC != null && payment.afterUSDC != null ? `Gateway ${payment.beforeUSDC} → ${payment.afterUSDC} USDC · Wallet B` : 'Payment confirmed · Circle Agent Wallet B') : payment?.status === 'pending' ? 'Circle Agent Wallet B · payment in progress' : 'Circle Agent Wallet B · approval required';
  const proof = results.generate_proof;
  $('proof-status').textContent = proof ? 'GENERATED' : pendingTool(run, 'generate_proof') ? 'GENERATING' : 'WAITING';
  $('proof-status').className = proof ? 'status-confirmed' : 'status-pending';
  $('prover-detail').textContent = proof ? `${proof.proofCount ?? 1} proof · actual MCP response accepted` : pendingTool(run, 'generate_proof') ? 'Generating proof… · actual MCP request' : 'Awaiting proof request';
  const verification = results.verify_proof_on_arc;
  const verified = verification?.valid === true;
  $('verification-status').textContent = verified ? '· Proof verified' : '· Awaiting proof';
  $('verification-status').className = verified ? 'status-confirmed' : '';
  const fragment = document.createDocumentFragment();
  for (const [key, label] of Object.entries(checkLabels)) {
    const value = verification?.checks?.[key];
    const chip = document.createElement('span');
    chip.className = value === true ? 'check passed' : value === false ? 'check failed' : 'check';
    chip.textContent = `${value === true ? '✓' : value === false ? '!' : '○'} ${label}`;
    fragment.append(chip);
  }
  $('verification-checks').replaceChildren(fragment);
  $('verification-detail').textContent = verified ? `Verifier eth_call${verification.checkedBlock ? ' · block ' + verification.checkedBlock : ''}. EligibilityGate rechecks atomically when staking.` : 'Eligibility, authorized wallet, exact action, nonce and deadline are checked before staking.';
  if (verification?.gate) safeLink('gate-link', `https://testnet.arcscan.app/address/${verification.gate}`);
  if (verification?.verifier) safeLink('verifier-link', `https://testnet.arcscan.app/address/${verification.verifier}`);
  const found = results.discover_prover;
  $('market-result').textContent = found ? `${found.name || 'ZKProofport'} · Agent #${found.agentId}` : 'dApp Agent Marketplace';
  $('market-detail').textContent = found ? `Discovery: dApp Agent Marketplace · Identity: ${found.identity || 'ERC-8004'}` : 'Identity: ERC-8004 · prover discovery pending';
  $('market-capability').hidden = !found?.capability;
  $('market-capability').textContent = found ? `${found.capability || ''}${found.priceUSDC != null ? ' · ' + found.priceUSDC + ' USDC' : ''}` : '';
  const gate = results.read_dapp?.manifest?.chain?.gate ?? verification?.gate;
  if (gate) { $('authorization-gate').textContent = shortAddress(gate) + ' · EligibilityGate ↗'; safeLink('authorization-gate', `https://testnet.arcscan.app/address/${gate}`); safeLink('gate-link', `https://testnet.arcscan.app/address/${gate}`); }
  const prepared = results.prepare_delegation;
  const action = prepared?.action?.message;
  const permission = run?.permissions?.find(p => p.kind === 'proof');
  $('authorization-status').textContent = proof ? 'Proof generated' : permission?.status === 'approved' ? 'Approved' : prepared ? 'Prepared · approval required' : 'Awaiting preparation';
  $('authorization-summary').textContent = prepared ? `Private Wallet A **** → Wallet B ${shortAddress(prepared.wallet)}` : 'Private Wallet A → operational Wallet B';
  $('authorization-action').textContent = `Stake ${prepared?.amount ?? run?.amount ?? $('amount').value} USDC · Arc Testnet`;
  $('authorization-nonce').textContent = action?.nonce ?? 'Not prepared';
  $('authorization-deadline').textContent = deadline(action?.expiresAt);
  renderWallet(walletSnapshot, run, results);
}
function renderPermissions(run) {
  const permissions = Array.isArray(run?.permissions) ? run.permissions : [];
  const history = document.createDocumentFragment();
  for (const permission of permissions) {
    const row = document.createElement('p');
    row.textContent = `${permission.kind === 'proof' ? 'Action authorization + proof fee' : 'Staking transaction'} · ${permission.status}`;
    history.append(row);
  }
  $('permission-history').replaceChildren(history);
  const pending = run?.status === 'running' ? permissions.find(p => p.status === 'pending') : null;
  const dialog = $('permission-dialog');
  if (!pending) { if (dialog.open) dialog.close(); shownPermission = null; return; }
  if (shownPermission?.id === pending.id) return;
  shownPermission = pending;
  const proof = pending.kind === 'proof', d = pending.details;
  $('permission-title').textContent = proof ? 'Authorize this action + proof fee' : 'Confirm the verified stake';
  $('permission-explanation').textContent = proof ? 'Private credential holder Wallet A (****) authorizes Wallet B for this exact stake. Circle Agent Wallet B pays for one KYC + action authorization proof. The agent is paused before signing or payment.' : 'The proof has been verified on Arc. Authorize Circle Agent Wallet B to submit this exact staking transaction. EligibilityGate rechecks the proof and action on-chain.';
  const facts = proof ? [['Credential holder', 'Private Wallet A · ****'], ['Authorized wallet B', d.delegate], ['Exact action', `Stake ${d.amount} USDC · Arc Testnet`], ['Proof fee', `${d.fee} USDC · x402 / Gateway Nanopayment`], ['Discovered prover', `#${d.proverId} · ${d.proverUrl}`], ['EligibilityGate', d.gate], ['Nonce', d.action?.message?.nonce], ['Deadline', deadline(d.action?.message?.expiresAt)]] : [['Transaction', `Stake ${d.amount} USDC · Arc Testnet`], ['Authorized wallet B', d.delegate], ['EligibilityGate', d.gate], ['Proof verification', 'Valid · Arc Testnet'], ['Proof fingerprint', d.proofFingerprint]];
  const fragment = document.createDocumentFragment();
  for (const [label, value] of facts) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = String(value ?? 'Unavailable'); fragment.append(dt, dd); }
  $('permission-facts').replaceChildren(fragment);
  $('permission-details').textContent = JSON.stringify(d, null, 2);
  $('approve-permission').textContent = proof ? `Authorize + pay ${d.fee} USDC` : `Confirm ${d.amount} USDC stake`;
  $('permission-error').hidden = true; $('approve-permission').disabled = false; $('reject-permission').disabled = false;
  if (!dialog.open) dialog.showModal();
}

function eventText(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* A tool label may precede its JSON. */ }
  for (const index of [text.indexOf('{'), text.indexOf('[')].filter(index => index > 0).sort((a, b) => a - b)) {
    try { return `${text.slice(0, index).trim()}\n${JSON.stringify(JSON.parse(text.slice(index)), null, 2)}`; }
    catch { /* Documentation excerpts and plain text remain unchanged. */ }
  }
  return text;
}
function renderTerminal(run) {
  const changedRun = run?.id !== terminalRun?.id;
  terminalRun = run;
  if (changedRun) expandedEvents.clear();
  const status = $('cli-stream-status');
  status.textContent = streamConnected ? (run?.status === 'running' ? 'Running' : run?.status === 'completed' ? 'Completed' : run?.status === 'failed' ? 'Stopped' : 'Connected · idle') : 'Reconnecting';
  status.className = `cli-status ${streamConnected && run?.status === 'running' ? 'streaming' : ''}`;
  const instruction = typeof run?.instruction === 'string' ? run.instruction : null;
  $('cli-command').textContent = instruction || 'Your submitted instruction will appear here.';
  $('copy-command').disabled = !instruction;
  const agent = run?.agent;
  $('agent-model').textContent = typeof agent?.provider === 'string' && typeof agent?.model === 'string' ? `${agent.provider} · ${agent.model}` : 'Model shown when the agent starts';
  // This surface accepts tool events only. Model content/reasoning is never rendered.
  const lines = Array.isArray(run?.terminal?.lines) ? run.terminal.lines.filter(line =>
    ['tool_call', 'tool_result'].includes(line.kind) && typeof line.text === 'string').slice(-200) : [];
  const signature = JSON.stringify([run?.id, lines]);
  if (signature === lastTerminalSignature) return;
  lastTerminalSignature = signature;
  const viewport = $('cli-log');
  const follow = changedRun || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 60;
  const fragment = document.createDocumentFragment();
  const visibleKeys = new Set();
  for (const line of lines) {
    const row = document.createElement('div'); row.className = 'cli-line';
    row.classList.add(`cli-${line.kind}`);
    const time = document.createElement('time');
    const date = new Date(line.at);
    if (Number.isFinite(date.getTime())) { time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString('en-GB', { hour12: false }); }
    const content = document.createElement('div'); content.className = 'tool-event';
    const kind = document.createElement('span'); kind.className = 'tool-kind';
    kind.textContent = line.kind === 'tool_call' ? 'TOOL CALL · DAPP AUTHORIZATION ADAPTER' : 'TOOL RESULT · DAPP AUTHORIZATION ADAPTER';
    content.append(kind);
    const fullText = eventText(line.text);
    if (fullText.length > 260 || fullText.includes('\n')) {
      const key = `${line.at}:${line.kind}:${line.text}`;
      visibleKeys.add(key);
      const detail = document.createElement('details'); detail.className = 'tool-detail'; detail.open = expandedEvents.has(key);
      const summary = document.createElement('summary');
      summary.textContent = `${line.text.replace(/\s+/g, ' ').slice(0, 150)}${line.text.length > 150 ? '…' : ''}`;
      const hint = document.createElement('span'); hint.className = 'tool-expand'; hint.textContent = 'Expand response / JSON';
      summary.append(hint);
      const text = document.createElement('pre'); text.textContent = fullText;
      detail.append(summary, text);
      detail.addEventListener('toggle', () => { if (detail.open) expandedEvents.add(key); else expandedEvents.delete(key); });
      content.append(detail);
    } else {
      const text = document.createElement('span'); text.className = 'tool-text'; text.textContent = fullText; content.append(text);
    }
    row.append(time, content); fragment.append(row);
  }
  for (const key of expandedEvents) if (!visibleKeys.has(key)) expandedEvents.delete(key);
  $('cli-output').replaceChildren(fragment);
  $('cli-empty').hidden = lines.length > 0;
  $('cli-empty').textContent = run ? 'Waiting for actual tool calls and results…' : 'Ask the agent to see its tool calls and results here.';
  $('cli-line-count').textContent = `${lines.length} events`;
  if (follow) viewport.scrollTop = viewport.scrollHeight;
}
function renderRun(run) {
  active = run?.status === 'running';
  $('run-button').disabled = active; $('amount').disabled = active; $('instruction').disabled = active;
  $('run-button').firstElementChild.textContent = active ? 'Agent working…' : 'Ask agent';
  const results = observedResults(run);
  const receipt = results.stake;
  const confirmed = receipt?.receiptStatus === 1 && typeof receipt.txHash === 'string' && receipt.block > 0;
  const pendingPermission = run?.permissions?.some(p => p.status === 'pending');
  $('run-status').textContent = pendingPermission ? 'Your approval' : confirmed ? 'Staked' : run ? ({running:'Running',completed:'Finished',failed:'Stopped'}[run.status] ?? 'Unknown') : 'Ready';
  $('run-status').className = `run-status ${confirmed ? 'completed' : run?.status ?? ''}`;
  if (run && currentRunId !== run.id) { $('amount').value = run.amount; if (typeof run.instruction === 'string') { $('instruction').value = run.instruction; fitInstruction(); } currentRunId = run.id; }
  const called = new Set((run?.terminal?.lines ?? []).filter(line => line.kind === 'tool_call').map(line => /^mcp__ledger_house__(\w+)/.exec(line.text)?.[1]));
  const tools = [null, 'read_dapp', 'discover_prover', 'prepare_delegation', 'generate_proof', 'verify_proof_on_arc', 'stake'];
  const done = [Boolean(run?.instruction), Boolean(results.read_dapp), Boolean(results.discover_prover), Boolean(results.prepare_delegation), Boolean(results.generate_proof), results.verify_proof_on_arc?.valid === true, confirmed];
  const prepared = results.prepare_delegation;
  const details = [run?.instruction, results.read_dapp ? 'Coinbase KYC required · operational wallet checked' : null, results.discover_prover ? `dApp marketplace · ERC-8004 agent #${results.discover_prover.agentId}` : null, prepared ? `Wallet B · stake ${prepared.amount} USDC · nonce + deadline bound` : null, results.generate_proof ? 'One KYC + action authorization proof generated' : run?.protocol?.payment?.status === 'confirmed' ? '0.001 USDC payment confirmed · generating proof' : null, results.verify_proof_on_arc?.valid === true ? 'Arc verifier accepted the proof · policy checks reported' : null, confirmed ? `${receipt.amount} USDC confirmed · Arc block ${receipt.block}` : null];
  const fragment = document.createDocumentFragment();
  for (const [index, label] of labels.entries()) {
    const working = !done[index] && called.has(tools[index]) && active;
    const status = done[index] ? 'done' : working ? 'active' : 'waiting';
    const row = document.createElement('li'); row.className = `step ${status}`;
    const icon = document.createElement('span'); icon.className = 'step-icon'; icon.textContent = done[index] ? '✓' : String(index + 1).padStart(2, '0');
    const body = document.createElement('div'), title = document.createElement('h3'), detail = document.createElement('p');
    title.textContent = label; detail.textContent = details[index] || descriptions[index];
    body.append(title, detail); row.append(icon, body); fragment.append(row);
  }
  $('steps').replaceChildren(fragment);
  $('result').hidden = !confirmed;
  if (confirmed) {
    $('result-copy').textContent = receipt.positionBefore != null && receipt.positionAfter != null ? `${receipt.amount} USDC staked · Position ${receipt.positionBefore} → ${receipt.positionAfter} USDC` : `${receipt.amount} USDC staked · Wallet B ${shortAddress(receipt.wallet)}`;
    safeLink('transaction-link', `https://testnet.arcscan.app/tx/${receipt.txHash}`);
  } else $('transaction-link').hidden = true;
  $('run-error').hidden = run?.status !== 'failed'; $('run-error').textContent = run?.error ?? '';
  renderEvidence(run, results); renderTerminal(run); renderPermissions(run);
}
function renderPositions(rows) {
  // The current position and receipt stay in the three-column presentation.
  // Retain the existing transaction data surface without duplicating the latest result.
  const fragment = document.createDocumentFragment();
  for (const row of rows ?? []) {
    const link = document.createElement('a');
    link.textContent = `${row.amount} USDC · ${shortAddress(row.wallet)} · View on Arc Explorer ↗`;
    link.href = `https://testnet.arcscan.app/tx/${row.txHash}`; link.target = '_blank'; link.rel = 'noreferrer'; fragment.append(link);
  }
  $('positions').replaceChildren(fragment);
}
async function refreshWallet() {
  if(walletRefreshing)return;
  walletRefreshing=true;
  try {
    const response = await fetch('/demo/wallet', {cache:'no-store'});
    if (!response.ok) throw Error('Wallet unavailable');
    walletSnapshot = await response.json();
    renderWallet(walletSnapshot, terminalRun, observedResults(terminalRun));
  } catch { if (!walletSnapshot) renderWallet(null, terminalRun, observedResults(terminalRun)); }
  finally{walletRefreshing=false;}
}
async function refresh() {
  if(refreshing)return;
  refreshing=true;
  try {
    const response = await fetch('/demo/state', {cache:'no-store'}); if (!response.ok) throw new Error('State unavailable');
    const data = await response.json(); renderRun(data.run); renderPositions(data.positions);
    $('connection').textContent = data.prover.paymentReady ? 'Live · Prover ready' : data.prover.reachable ? 'Prover setup pending' : 'Prover unavailable';
    $('connection-dot').className = data.prover.paymentReady ? 'online' : '';
    $('tee-mode').textContent = 'ZKProofport prover';
    $('runtime-note').textContent = 'Private eligibility · Arc Testnet';
    if(!walletSnapshot)void refreshWallet();
  } catch { $('connection').textContent = 'Reconnecting…'; $('connection-dot').className = ''; }
  finally{refreshing=false;}
}

$('stake-form').addEventListener('submit',async event=>{event.preventDefault();if(active)return;$('form-error').hidden=true;$('run-button').disabled=true;try{const instruction=$('instruction').value.trim();if(!instruction)throw new Error('Enter an instruction for the agent.');const response=await fetch('/demo/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:$('amount').value,instruction})});const data=await response.json();if(!response.ok)throw new Error(data.error ?? 'Could not start the agent');await refresh();}catch(error){$('form-error').textContent=error.message;$('form-error').hidden=false;$('run-button').disabled=false;}});
$('permission-dialog').addEventListener('cancel',event=>event.preventDefault());
for(const decision of ['approve','reject'])$(decision+'-permission').addEventListener('click',async()=>{
 if(!shownPermission)return;const id=shownPermission.id;$('approve-permission').disabled=true;$('reject-permission').disabled=true;
 try{const response=await fetch(`/demo/permissions/${id}/decision`,{method:'POST',headers:{'Content-Type':'application/json','X-Demo-User-Action':'1'},body:JSON.stringify({decision})});const value=await response.json();if(!response.ok)throw Error(value.error??'Decision failed');await refresh();}
 catch(error){$('permission-error').textContent=error.message;$('permission-error').hidden=false;$('approve-permission').disabled=false;$('reject-permission').disabled=false;}
});
$('copy-command').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('cli-command').textContent);$('copy-command').textContent='Copied';setTimeout(()=>$('copy-command').textContent='Copy',1600);}catch{$('copy-command').textContent='Select below';const range=document.createRange();range.selectNodeContents($('cli-command'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}});
const events=new EventSource('/demo/events');events.onmessage=event=>{try{renderRun(JSON.parse(event.data));if(!active)refresh();}catch{}};
events.onopen=()=>{streamConnected=true;renderTerminal(terminalRun);};
events.onerror=()=>{streamConnected=false;renderTerminal(terminalRun);};
$('instruction').addEventListener('input', fitInstruction);
globalThis.addEventListener?.('resize', fitInstruction);
document.fonts?.ready.then(fitInstruction);
renderRun(null);fitInstruction();refreshWallet();refresh();setInterval(()=>{if(!document.hidden)refresh();},5000);

$('find-prover').addEventListener('click', async () => {
  $('find-prover').disabled = true;
  try {
    const response = await fetch('/marketplace/agents'); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Marketplace unavailable');
    const agent = data.agents?.[0]; if (!agent) throw new Error('No prover registration available');
    $('market-result').textContent = `${agent.name} · Agent #${agent.agentId}`;
    $('market-detail').textContent = 'Discovery: dApp Agent Marketplace · Identity: ERC-8004';
    $('market-capability').hidden = !agent.capability;
    $('market-capability').textContent = `${agent.capability || ''}${agent.priceUSDC != null ? ' · ' + agent.priceUSDC + ' USDC' : ''}`;
  } catch (error) { $('market-result').textContent = 'Prover discovery unavailable'; $('market-detail').textContent = error.message; }
  finally { $('find-prover').disabled = false; }
});
$('amount').addEventListener('input', () => { if (!active) $('authorization-action').textContent = `Stake ${$('amount').value || '—'} USDC · Arc Testnet`; });
