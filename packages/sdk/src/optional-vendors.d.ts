/**
 * Circle's wallet SDK, declared rather than installed.
 *
 * `walletFromCircle` imports it lazily, so someone paying from a private key
 * or a CDP wallet never needs it. Installing it here purely to satisfy the
 * typechecker does not work: it and `@coinbase/agentkit` disagree about
 * `@solana/kit` (the SDK wants >=5.1.0 through `@x402/svm`, the tree holds
 * 8.2.0), and npm refuses the tree. Forcing it with --legacy-peer-deps to make
 * a typecheck pass would be resolving a real conflict by hiding it.
 *
 * So the two calls used are declared, and nothing else. If Circle changes
 * either signature this declaration goes stale silently -- which is the cost,
 * and it is bounded by how little is declared: an address lookup and a
 * signature. `wallets.ts` checks both results at runtime and throws with the
 * wallet id when either is missing.
 */
declare module '@circle-fin/developer-controlled-wallets' {
  export function initiateDeveloperControlledWalletsClient(config: {
    apiKey: string;
    entitySecret: string;
  }): {
    signTypedData(input: {
      walletId: string;
      data: string;
      memo?: string;
    }): Promise<{ data?: { signature?: string } }>;
    getWallet(input: { id: string }): Promise<{ data?: { wallet?: { address?: string } } }>;
  };
}
