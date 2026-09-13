import { getAddress } from 'ethers';

/** Reuse the connected Circle wallet, requiring an explicit selection when ambiguous. */
export function selectAgentDelegate(connected: string[], selected?: string): string {
  const addresses = connected.map(address => getAddress(address));
  if (selected) {
    const address = getAddress(selected);
    if (!addresses.includes(address)) throw new Error('ARC_AGENT_WALLET is not in the connected Arc Testnet agent wallets.');
    return address;
  }
  if (addresses.length !== 1) throw new Error('Exactly one connected wallet is required; set ARC_AGENT_WALLET to select an existing wallet.');
  return addresses[0];
}
