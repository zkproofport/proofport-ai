import {getAddress} from 'ethers';
export function validateNanoOffer(offer:any,owner:string,usdc:string){
 if(!offer||offer.network!=='eip155:5042002'||offer.amount!=='1000'||getAddress(offer.payTo)!==getAddress(owner)||getAddress(offer.asset)!==getAddress(usdc)||offer.extra?.name!=='GatewayWalletBatched'||offer.extra?.version!=='1'||getAddress(offer.extra?.verifyingContract)!==getAddress('0x0077777d7EBA4688BDeF3E311b846F25870A19B9'))throw Error('Unexpected nanopayment price, recipient, asset or Gateway domain.');
}
interface Binding{actionHash:string;domainSeparator:string;scope:string;signerRoot:string}
export function validateProofBinding(actual:Binding,expected:Binding){
 for(const field of ['actionHash','domainSeparator','scope','signerRoot'] as const)if(actual[field].toLowerCase()!==expected[field].toLowerCase())throw Error(`Proof ${field} differs from the authorized action or trusted staking gate.`);
}
