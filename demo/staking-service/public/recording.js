const $ = id => document.getElementById(id);
const labels = ['Instruction received','Credential required','Prover discovered','Delegation prepared','Payment & proof','On-chain stake'];
const descriptions = ['Waiting for your instruction','The vault checks its access policy','Search the Arc ERC-8004 registry','Authorise a separate wallet to act','Pay with Arc nanopayments and request a proof','Deposit USDC from the agent wallet on Arc'];
let active = false;
let currentRunId = null;
function command() {
  const amount = /^\d+(\.\d{1,6})?$/.test($('amount').value) ? $('amount').value : '1';
  $('command').textContent = `curl -s ${location.origin}/demo/run -H 'Content-Type: application/json' -d '{"amount":"${amount}"}'`;
}
function renderRun(run) {
  active = run?.status === 'running';
  $('run-button').disabled = active;
  $('amount').disabled = active;
  $('run-button').firstElementChild.textContent = active ? 'Agent running…' : run ? 'Run again' : 'Run agent';
  $('run-status').textContent = run ? ({running:'Running',completed:'Verified',failed:'Stopped'}[run.status] ?? 'Unknown') : 'Ready';
  $('run-status').className = `run-status ${run?.status ?? ''}`;
  if (run && currentRunId !== run.id) { $('amount').value = run.amount; currentRunId = run.id; command(); }
  const fragment = document.createDocumentFragment();
  for (const [index, label] of labels.entries()) {
    const step = run?.steps[index];
    const row = document.createElement('li'); row.className = `step ${step?.status ?? 'waiting'}`;
    const icon = document.createElement('span'); icon.className='step-icon'; icon.textContent = step?.status === 'done' ? '✓' : step?.status === 'failed' ? '!' : String(index+1).padStart(2,'0');
    const body = document.createElement('div'); const title = document.createElement('h3'); title.textContent=label;
    const detail = document.createElement('p'); detail.textContent=step?.detail || descriptions[index]; body.append(title, detail); row.append(icon, body);
    if(step?.at){const time=document.createElement('time');time.textContent=new Date(step.at).toLocaleTimeString('en-GB',{hour12:false});row.append(time);}
    fragment.append(row);
  }
  $('steps').replaceChildren(fragment);
  $('result').hidden = run?.status !== 'completed';
  if(run?.status==='completed') $('result-copy').textContent = `${run.amount} USDC staked on Arc · ${run.wallet.slice(0,8)}…${run.wallet.slice(-6)}`;
  $('transaction-link').hidden = !run?.txHash;
  if(run?.txHash) $('transaction-link').href=`https://testnet.arcscan.app/tx/${run.txHash}`;
  $('run-error').hidden = run?.status !== 'failed';
  $('run-error').textContent = run?.error ?? '';
}
function renderPositions(rows) {
  if(!rows?.length) {const p=document.createElement('p');p.className='empty';p.textContent="Your agent's verified position will appear here.";$('positions').replaceChildren(p);return;}
  const table=document.createElement('table');const header=document.createElement('tr');
  for(const text of ['DELEGATE WALLET','AMOUNT','STATUS']){const th=document.createElement('th');th.textContent=text;header.append(th);}const thead=document.createElement('thead');thead.append(header);table.append(thead);
  const tbody=document.createElement('tbody');
  for(const row of rows){const tr=document.createElement('tr');const wallet=document.createElement('td');const code=document.createElement('code');code.textContent=row.wallet;wallet.append(code);const amount=document.createElement('td');amount.textContent=`${row.amount} USDC`;const status=document.createElement('td');const link=document.createElement('a');link.textContent='View transaction ↗';link.href=`https://testnet.arcscan.app/tx/${row.txHash}`;link.target='_blank';link.rel='noreferrer';status.append(link);tr.append(wallet,amount,status);tbody.append(tr);}table.append(tbody);$('positions').replaceChildren(table);
}
async function refresh(){
  try{const response=await fetch('/demo/state',{cache:'no-store'});if(!response.ok)throw new Error('State unavailable');const data=await response.json();renderRun(data.run);renderPositions(data.positions);
    $('connection').textContent=data.prover.paymentReady?'GCP prover ready':data.prover.reachable?'GCP Arc setup pending':'Prover unavailable';$('connection-dot').className=data.prover.paymentReady?'online':'';
    const modes={nitro:'AWS Nitro TEE',local:'GCP Cloud Run',disabled:'Disabled',unknown:'Unknown'};
    $('tee-mode').textContent=modes[data.prover.teeMode] ?? 'Unknown';
    $('runtime-note').textContent=data.prover.teeMode==='nitro'?'AWS Nitro TEE · Arc Testnet · On-chain USDC':'GCP proof generation · Arc ERC-8004 discovery · On-chain USDC staking';
  }catch{$('connection').textContent='Reconnecting…';$('connection-dot').className='';}
}
$('stake-form').addEventListener('submit',async event=>{event.preventDefault();if(active)return;$('form-error').hidden=true;$('run-button').disabled=true;try{const response=await fetch('/demo/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:$('amount').value})});const data=await response.json();if(!response.ok)throw new Error(data.error ?? 'Could not start the agent');await refresh();}catch(error){$('form-error').textContent=error.message;$('form-error').hidden=false;$('run-button').disabled=false;}});
$('amount').addEventListener('input',command);
$('copy-command').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('command').textContent);$('copy-command').textContent='Copied';setTimeout(()=>$('copy-command').textContent='Copy',1600);}catch{$('copy-command').textContent='Select below';const range=document.createRange();range.selectNodeContents($('command'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}});
const events=new EventSource('/demo/events');events.onmessage=event=>{try{renderRun(JSON.parse(event.data));if(!active)refresh();}catch{}};
renderRun(null);command();refresh();setInterval(refresh,5000);

$('find-prover').addEventListener('click',async()=>{
  $('find-prover').disabled=true;$('market-result').textContent='Reading the Arc registry…';
  try{const response=await fetch('/marketplace/agents');const data=await response.json();if(!response.ok)throw new Error(data.error);const agent=data.agents[0];$('market-result').textContent=`${agent.name} · Agent #${agent.agentId}`;$('market-detail').textContent=`On-chain owner verified · ${new URL(agent.endpoint).hostname}`;}
  catch(error){$('market-result').textContent='Prover registration is not ready';$('market-detail').textContent=error.message;}
  finally{$('find-prover').disabled=false;}
});
$('audit-proof').addEventListener('click',async()=>{
  $('audit-proof').disabled=true;$('audit-result').hidden=false;$('audit-result').textContent='Verifying the proof and comparing the candidate…';
  try{const response=await fetch('/demo/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fromEnvironment:true})});const data=await response.json();if(!response.ok)throw new Error(data.error);$('audit-result').textContent=`${data.proofVerified?'Proof verified on Arc':'Proof did not verify'} · Candidate ${data.matches?'matches':'does not match'}. ${data.explanation}`;}
  catch(error){$('audit-result').textContent=error.message;}
  finally{$('audit-proof').disabled=false;}
});
