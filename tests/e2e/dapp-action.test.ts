/** Live dApp → Claude → npm MCP/SDK → paid proof → Arc verification → stake.
 * Explicit opt-in; one 10 USDC stake and one 0.001 USDC proof, never retried.
 */
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {chromium,type Browser,type Page} from 'playwright';
import {ethers} from 'ethers';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {loadDemoConfig} from '../../demo/shared/config.ts';
import {readGatewayBalance} from '../../demo/shared/walletStatus.ts';
import {extractArcPublicMetadata} from '../../demo/audit/address-audit.ts';
import {publishedProverPackages} from '../../demo/shared/proverPackages.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {assertUnusedStakeAction} from '../../demo/shared/userAction.ts';

const enabled=process.env.ARC_DAPP_LIVE_E2E==='1';
const reuse=process.env.ARC_DAPP_REUSE_COMPLETED==='1';
const base=process.env.ARC_DAPP_URL??'http://localhost:4118';
const instruction='Stake 10 USDC with my Agent Wallet. Find a registered ZKProofport prover in the dApp Agent Marketplace and verify its ERC-8004 identity. Read its installation instructions, install the published SDK and MCP packages from npm, then connect and read the MCP tools. Ask me to approve the exact-action authorization and proof fee, then ask me again before submitting the verified stake. Use the EIP-712 action I submitted unchanged.';

describe.skipIf(!enabled).sequential('live user-supplied action in the dApp',()=>{
 let browser:Browser,page:Page,action:any,completed:any,proof:any;
 const errors:string[]=[];
 const config=loadDemoConfig();
 const provider=new ethers.JsonRpcProvider(config.rpcUrl);
 const gate=new ethers.Contract(config.gate,[
  'function balances(address) view returns(uint256)',
  'function actionHash(address,uint256,uint256,string) view returns(bytes32)',
  'function usedNonces(address,bytes32) view returns(bool)',
  'function stakePacked(uint256,bytes,bytes,uint256,string)',
 ],provider);
 const state=async()=>{const r=await fetch(base+'/demo/state');expect(r.ok).toBe(true);return await r.json() as any;};
 const results=(run:any)=>Object.fromEntries(run.terminal.lines.filter((l:any)=>l.kind==='tool_result').map((l:any)=>{
  const match=/^mcp__ledger_house__(\w+) ([\s\S]+)$/.exec(l.text);return match?[match[1],JSON.parse(match[2])]:['ignored',{}];
 }));
 async function waitFor(check:(s:any)=>boolean,timeout=600_000){
  const until=Date.now()+timeout;
  while(Date.now()<until){const s=await state();if(check(s))return s;
   if(s.run?.status==='failed')throw Error('Actual agent run stopped: '+s.run.error);
   await new Promise(resolve=>setTimeout(resolve,1000));
  }throw Error('Timed out waiting for the actual agent result. No automatic paid retry.');
 }
 beforeAll(async()=>{
  const url=new URL(base);expect(['localhost','127.0.0.1']).toContain(url.hostname);expect(url.protocol).toBe('http:');
  const initial=await state();expect(initial.prover.ready).toBe(true);
  if(reuse){expect(initial.run?.status).toBe('completed');completed=initial.run;action=completed.action;proof=await(await fetch(base+'/demo/proof')).json();}
  else expect(initial.run).toBeNull();
  browser=await chromium.launch({channel:'chrome',headless:process.env.ARC_DAPP_HEADLESS!=='0'});
  page=await browser.newPage({viewport:{width:1920,height:1080}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await page.locator('#action-editor summary').click();
  await page.waitForFunction(()=>Boolean((document.getElementById('action-input') as HTMLTextAreaElement)?.value));
 },30_000);
 afterAll(async()=>{await browser?.close();await provider.destroy();});

 it.skipIf(reuse)('rejects an altered action through the real form without starting or spending',async()=>{
  action=JSON.parse(await page.locator('#action-input').inputValue());
  await page.locator('#instruction').fill(instruction);
  await page.locator('#action-input').fill(JSON.stringify({...action,message:{...action.message,amount:'10000001'}}));
  const response=page.waitForResponse(r=>r.url()===base+'/demo/run'&&r.request().method()==='POST');
  await page.locator('#run-button').click();expect((await response).status()).toBe(400);
  expect((await state()).run).toBeNull();expect(await page.locator('#form-error').isVisible()).toBe(true);
  expect(errors).toEqual([]);
 },30_000);

 it.skipIf(reuse)('signs and proves the submitted fields, waits for browser approvals, and stakes exactly once',async()=>{
  action.message.nonce='user-e2e-'+randomUUID();
  action.message.expiresAt=String(Math.floor(Date.now()/1000)+2700);
  await page.locator('#action-input').fill(JSON.stringify(action,null,2));
  const wallet=action.message.delegate;
  const walletInfo=await (await fetch(base+'/demo/wallet')).json() as any;
  expect(walletInfo.walletType).toBe('Circle Agent Wallet');expect(walletInfo.directKyc.status).toBe('not_found');
  expect(ethers.parseUnits(walletInfo.walletUSDC,6)>=10_000_000n).toBe(true);
  const before={position:await gate.balances(wallet) as bigint,gateway:await readGatewayBalance(wallet)};
  const runResponse=page.waitForResponse(r=>r.url()===base+'/demo/run'&&r.request().method()==='POST');
  await page.locator('#run-button').click();expect((await runResponse).status()).toBe(202);
  expect((await state()).run.action).toEqual(action);
  expect(await page.locator('#action-input').isDisabled()).toBe(true);
  const first=await waitFor(s=>s.run?.permissions?.some((p:any)=>p.kind==='proof'&&p.status==='pending'));
  const permission=first.run.permissions.find((p:any)=>p.kind==='proof');
  expect(permission.details.action).toEqual(action);expect(permission.details.fee).toBe('0.001');
  expect(results(first.run).read_dapp.submittedAction).toEqual(action);
  expect(results(first.run).prepare_delegation.action).toEqual(action);
  expect(first.run.protocol.payment).toBeUndefined();
  expect(first.run.terminal.lines.filter((l:any)=>l.kind==='tool_call'&&/^mcp__ledger_house__generate_proof /.test(l.text))).toHaveLength(0);
  expect(await readGatewayBalance(wallet)).toBe(before.gateway);
  await page.waitForFunction(()=>document.querySelector('#permission-dialog')?.hasAttribute('open'));
  expect(JSON.parse(await page.locator('#permission-details').textContent()||'{}').action).toEqual(action);
  await page.locator('#approve-permission').click();

  const second=await waitFor(s=>s.run?.permissions?.some((p:any)=>p.kind==='stake'&&p.status==='pending'));
  const current=results(second.run);
  expect(current.verify_proof_on_arc.valid).toBe(true);
  expect(Object.values(current.verify_proof_on_arc.checks).every(Boolean)).toBe(true);
  expect(second.run.protocol.proverMcp.serverName).toBe('zkproofport-mcp');
  expect(second.run.protocol.proverMcp.packageSource).toBe('npm');
  expect(second.run.protocol.proverMcp.arguments.action).toEqual(action);
  expect(second.run.permissions.find((p:any)=>p.kind==='stake').details.action).toEqual(action);
  expect(await gate.balances(wallet)).toBe(before.position);
  await page.waitForFunction(()=>document.querySelector('#permission-dialog')?.hasAttribute('open')&&document.querySelector('#permission-title')?.textContent==='Confirm the verified stake');
  expect(JSON.parse(await page.locator('#permission-details').textContent()||'{}').action).toEqual(action);
  await page.locator('#approve-permission').click();
  completed=(await waitFor(s=>s.run?.status==='completed')).run;
  const executed=results(completed),stake=executed.stake;
  expect(stake.receiptStatus).toBe(1);expect(stake.amount).toBe('10');
  expect(completed.terminal.lines.filter((l:any)=>l.kind==='tool_call'&&/^mcp__ledger_house__generate_proof /.test(l.text))).toHaveLength(1);
  expect(completed.terminal.lines.filter((l:any)=>l.kind==='tool_call'&&/^mcp__ledger_house__stake /.test(l.text))).toHaveLength(1);
  proof=await (await fetch(base+'/demo/proof')).json();
  const metadata=extractArcPublicMetadata(proof.publicInputs);
  expect(metadata.actionHash.toLowerCase()).toBe((await gate.actionHash(wallet,10_000_000n,action.message.expiresAt,action.message.nonce)).toLowerCase());
  expect(await gate.usedNonces(wallet,ethers.id(action.message.nonce))).toBe(true);
  expect(await gate.balances(wallet)).toBe(before.position+10_000_000n);
  const afterGateway=await readGatewayBalance(wallet);
  expect(ethers.parseUnits(before.gateway,6)-ethers.parseUnits(afterGateway,6)).toBe(1000n);
  const receipt=await provider.getTransactionReceipt(stake.txHash);expect(receipt?.status).toBe(1);
  await page.waitForFunction(()=>document.querySelector('#run-status')?.textContent==='Staked');
  expect(await page.locator('#position-value').textContent()).toContain(ethers.formatUnits(before.position+10_000_000n,6));
  const address=process.env.ATTESTATION_KEY?new ethers.Wallet(process.env.ATTESTATION_KEY).address.toLowerCase():'';
  const publicText=(JSON.stringify(completed)+' '+await page.locator('body').innerText()).toLowerCase();
  expect(Boolean(address&&publicText.includes(address))).toBe(false);expect(errors).toEqual([]);
  await writeFile(new URL('../../demo/artifacts/user-action-e2e.json',import.meta.url),JSON.stringify({
   observedAt:new Date().toISOString(),source:'Real Playwright dApp interaction; actual Claude, npm MCP/SDK, staging prover and Arc calls',
   action,before:{positionUSDC:ethers.formatUnits(before.position,6),gatewayUSDC:before.gateway},
   after:{positionUSDC:ethers.formatUnits(await gate.balances(wallet),6),gatewayUSDC:afterGateway},
   proof:{bytes:(proof.proof.length-2)/2,publicInputCount:proof.publicInputs.length,...metadata},
   proverMcp:completed.protocol.proverMcp,permissions:completed.permissions,verification:executed.verify_proof_on_arc,stake,
   explorer:'https://testnet.arcscan.app/tx/'+stake.txHash,
  },null,2)+'\n');
  console.log(JSON.stringify({actualStakeTx:stake.txHash,feeUSDC:'0.001',stakeUSDC:'10',userNonce:action.message.nonce}));
 },900_000);

 it('the deployed Gate rejects altered authorizations and reuse via eth_call',async()=>{
  expect(proof).toBeDefined();
  const packed=ethers.hexlify(ethers.concat(proof.publicInputs)),wallet=action.message.delegate;
  const selector=(name:string)=>ethers.id(name+'()').slice(0,10);
  async function refused(name:string,amount=10_000_000n,nonce=action.message.nonce,expiry=action.message.expiresAt,from=wallet,inputs=packed){
   let reason='';try{await gate.stakePacked.staticCall(amount,proof.proof,inputs,expiry,nonce,{from});}catch(error){reason=String((error as {data?:unknown}).data??'').slice(0,10);}
   expect(reason).toBe(selector(name));
  }
  await refused('ActionMismatch',10_000_001n);
  await refused('ActionMismatch',10_000_000n,action.message.nonce+'-changed');
  await refused('ActionMismatch',10_000_000n,action.message.nonce,action.message.expiresAt,'0x1111111111111111111111111111111111111111');
  await refused('ExpiredDelegation',10_000_000n,action.message.nonce,1);
  const changed=[...proof.publicInputs];changed[32]=ethers.zeroPadValue(ethers.toBeHex(Number(BigInt(changed[32]))^1),32);
  await refused('DomainMismatch',10_000_000n,action.message.nonce,action.message.expiresAt,wallet,ethers.hexlify(ethers.concat(changed)));
  await refused('DelegationUsed');
  await expect(assertUnusedStakeAction(action,new ethers.Contract(config.gate,['function usedNonces(address,bytes32) view returns(bool)','function usedActions(bytes32) view returns(bool)'],provider) as any)).rejects.toThrow('already used');
 },60_000);
});

describe.skipIf(!enabled)('published MCP accepts arbitrary action fields',()=>{
 it('both proof paths sign custom fields and refuse a non-KYC fixture before payment',async()=>{
  const config=loadDemoConfig(),packages=publishedProverPackages();
  const observed=await (await fetch(base+'/demo/wallet')).json() as {wallet:string};
  const before=await readGatewayBalance(observed.wallet);
  const fixture=ethers.Wallet.createRandom();
  const action={domain:{name:'User custom dApp',version:'3',chainId:5042002,verifyingContract:config.gate},
   primaryType:'UserChosenAction',types:{UserChosenAction:[{name:'who',type:'address'},{name:'customText',type:'string'},
    {name:'customFlag',type:'bool'},{name:'customAmount',type:'uint256'},{name:'customTags',type:'string[]'}]},
   message:{who:observed.wallet,customText:'User chooses all type names, keys and values',customFlag:true,customAmount:'42',customTags:['one','two']}};
  const transport=new StdioClientTransport({command:process.execPath,args:[packages.mcpEntry],stderr:'pipe',env:{
   PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'',PROOFPORT_URL:config.discovery.allowedOrigin,
   ATTESTATION_KEY:fixture.privateKey,ARC_AGENT_WALLET:observed.wallet,CIRCLE_ACCEPT_TERMS:'1',
  }});
  let signed=false;
  transport.stderr?.on('data',chunk=>{if(String(chunk).includes('Step 1: Sign Typed Action'))signed=true;});
  const client=new Client({name:'custom-action-e2e',version:'1.0.0'},{capabilities:{}});
  try{
   await client.connect(transport);
   expect(client.getServerVersion()?.name).toBe('zkproofport-mcp');
   const response=await client.callTool({name:'generate_proof',arguments:{circuit:'arc_eligibility',scope:'custom-action-e2e',action,pay_with:'arc',pay_on:'arc-testnet-nano',max_payment:'0'}},undefined,{timeout:120000});
   expect(signed).toBe(true);expect(response.isError).toBe(true);
   const content=response.content as {type:string;text?:string}[];
   const error=JSON.parse(content.filter(c=>c.type==='text').map(c=>c.text).join('')).error as string;
   expect(/attestation|KYC/i.test(error)).toBe(true);
   const prepared=await client.callTool({name:'prepare_inputs',arguments:{circuit:'arc_eligibility',scope:'custom-action-e2e',action}},undefined,{timeout:120000});
   expect(prepared.isError).toBe(true);
   const preparedContent=prepared.content as {type:string;text?:string}[];
   const preparationError=JSON.parse(preparedContent.filter(c=>c.type==='text').map(c=>c.text).join('')).error as string;
   // Old MCP accepted action but used personal_sign and omitted recovery hashes.
   // The upgraded package must reach the actual KYC lookup with correct hashes.
   expect(preparationError).toMatch(/No attestation found/);
   expect(await readGatewayBalance(observed.wallet)).toBe(before);
  }finally{await client.close();}
 },150_000);
});
