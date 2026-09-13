import {it,expect} from 'vitest';
import {validateNanoOffer,validateProofBinding} from '../demo/user-agent/src/policy.ts';
const a='0x'+'1'.repeat(40),u='0x'+'2'.repeat(40),h='0x'+'3'.repeat(64);
const offer={network:'eip155:5042002',amount:'1000',payTo:a,asset:u,extra:{name:'GatewayWalletBatched',version:'1',verifyingContract:'0x0077777d7EBA4688BDeF3E311b846F25870A19B9'}};
it('accepts the pinned nano offer but rejects fee, recipient and domain changes',()=>{expect(()=>validateNanoOffer(offer,a,u)).not.toThrow();for(const changed of [{amount:'1001'},{payTo:u},{extra:{...offer.extra,name:'USDC'}}])expect(()=>validateNanoOffer({...offer,...changed},a,u)).toThrow();});
it('rejects a cryptographically valid proof for a different authorized action',()=>{const m={actionHash:h,domainSeparator:h,scope:h,signerRoot:h};expect(()=>validateProofBinding(m,m)).not.toThrow();expect(()=>validateProofBinding({...m,actionHash:'0x'+'4'.repeat(64)},m)).toThrow();});
