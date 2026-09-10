import { PublicKey, VersionedTransaction, Transaction } from '@solana/web3.js'

// Wallet via the injected standard provider (Phantom / Backpack expose window.solana).
// The @solana/wallet-adapter packages aren't installed and can't be fetched offline;
// the injected provider needs no package and supports versioned transactions.
type Provider = {
  publicKey: PublicKey | null
  isConnected?: boolean
  connect: (opts?: any) => Promise<{ publicKey: PublicKey }>
  disconnect: () => Promise<void>
  signAndSendTransaction: (tx: VersionedTransaction | Transaction) => Promise<{ signature: string }>
  signTransaction?: (tx: VersionedTransaction | Transaction) => Promise<VersionedTransaction | Transaction>
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>
  on?: (evt: string, cb: (...a: any[]) => void) => void
}

export function provider(): Provider | null {
  const w = window as any
  return (w.solana && w.solana.isPhantom ? w.solana : w.solana || w.backpack?.solana) || null
}
export function available(): boolean { return !!provider() }

let _pk: PublicKey | null = null
export function walletPubkey(): PublicKey | null { return _pk }

export async function connect(): Promise<PublicKey> {
  const p = provider()
  if (!p) throw new Error('No Solana wallet found. Install Phantom or Backpack.')
  const res = await p.connect()
  _pk = res.publicKey ? new PublicKey(res.publicKey.toString()) : p.publicKey
  if (!_pk) throw new Error('Wallet did not return a public key.')
  p.on?.('disconnect', () => { _pk = null; window.dispatchEvent(new Event('h2e:wallet')) })
  p.on?.('accountChanged', () => window.dispatchEvent(new Event('h2e:wallet')))
  window.dispatchEvent(new Event('h2e:wallet'))
  return _pk
}
export async function disconnect() { try { await provider()?.disconnect() } catch {} _pk = null; window.dispatchEvent(new Event('h2e:wallet')) }

/** Send a versioned tx: partial-sign with any extra signers (e.g. a fresh mint),
 *  then hand to the wallet to add the payer signature and submit. */
export async function sendVersioned(tx: VersionedTransaction): Promise<string> {
  const p = provider()
  if (!p) throw new Error('No wallet connected.')
  const { signature } = await p.signAndSendTransaction(tx)
  return signature
}

/** Sign an arbitrary UTF-8 message (for off-chain elections, §7.6). */
export async function signMessage(message: string): Promise<Uint8Array> {
  const p = provider()
  if (!p || !p.signMessage) throw new Error('Wallet does not support message signing.')
  const { signature } = await p.signMessage(new TextEncoder().encode(message), 'utf8')
  return signature
}
