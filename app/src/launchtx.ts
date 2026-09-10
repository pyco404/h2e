import {
  PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction,
  AddressLookupTableProgram, AddressLookupTableAccount, ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  launchCoinIx, launchCoinAltAddresses, wrapSolIxs, closeWsolIx, BN,
  LaunchCoinParams, LaunchCoinAccounts,
} from '../../h2e/client'
import { conn } from './rpc'
import { sendVersioned } from './wallet'

export interface LaunchForm {
  name: string; symbol: string; uri: string
  devBuyLamports: bigint
  defaultPayoutMint: PublicKey
}

/** Build the launch instructions and the ALT address set. Pure assembly — no
 *  chain calls — so a Preview can show it offline. Mirrors tests/launch_coin.ts. */
export function assembleLaunch(payer: PublicKey, config: PublicKey, platformWallet: PublicKey, form: LaunchForm) {
  const baseMint = Keypair.generate()
  const accts: LaunchCoinAccounts = { payer, baseMint: baseMint.publicKey, config, platformWallet }
  const params: LaunchCoinParams = {
    name: form.name, symbol: form.symbol, uri: form.uri,
    dev_buy_lamports: new BN(form.devBuyLamports.toString()),
    default_payout_mint: form.defaultPayoutMint,
  }
  const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]
  const dev = form.devBuyLamports > 0n
  if (dev) ixs.push(...wrapSolIxs(payer, new BN(form.devBuyLamports.toString())).ixs)
  ixs.push(launchCoinIx(params, accts))
  if (dev) ixs.push(closeWsolIx(payer))
  return { baseMint, accts, params, ixs, altAddresses: launchCoinAltAddresses(accts) }
}

/** Rough legacy-size estimate for a Preview (real tx uses an ALT and is smaller). */
export function roughAccountCount(ixs: TransactionInstruction[]): number {
  const keys = new Set<string>()
  for (const ix of ixs) { keys.add(ix.programId.toBase58()); for (const k of ix.keys) keys.add(k.pubkey.toBase58()) }
  return keys.size
}

async function sendAndConfirm(ixs: TransactionInstruction[], payer: PublicKey, extraSigners: Keypair[], alt?: AddressLookupTableAccount, log?: (s: string) => void): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alt ? [alt] : [])
  const tx = new VersionedTransaction(msg)
  if (extraSigners.length) tx.sign(extraSigners) // partial-sign (e.g. the fresh mint) before the wallet adds the payer sig
  const sig = await sendVersioned(tx)
  log?.(`  sent ${sig.slice(0, 8)}… (${tx.serialize().length} B)`)
  await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

/** Full launch: create + extend an ALT (chunked), warm it, then send the launch
 *  tx (mint partial-signs, wallet pays). Each step is a wallet prompt. */
export async function submitLaunch(payer: PublicKey, config: PublicKey, platformWallet: PublicKey, form: LaunchForm, log: (s: string) => void): Promise<{ mint: PublicKey; launchSig: string }> {
  const plan = assembleLaunch(payer, config, platformWallet, form)
  log('Creating address lookup table…')
  const slot = await conn().getSlot('finalized')
  const [createIx, altAddr] = AddressLookupTableProgram.createLookupTable({ authority: payer, payer, recentSlot: slot })
  await sendAndConfirm([createIx], payer, [], undefined, log)
  for (let i = 0; i < plan.altAddresses.length; i += 18) {
    const chunk = plan.altAddresses.slice(i, i + 18)
    log(`Extending ALT (+${chunk.length})…`)
    await sendAndConfirm([AddressLookupTableProgram.extendLookupTable({ payer, authority: payer, lookupTable: altAddr, addresses: chunk })], payer, [], undefined, log)
  }
  // Wait for the ALT to be active for lookups.
  let alt: AddressLookupTableAccount | null = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 400))
    alt = (await conn().getAddressLookupTable(altAddr)).value
    if (alt && alt.state.addresses.length >= plan.altAddresses.length) break
  }
  await new Promise((r) => setTimeout(r, 1200))
  log('Submitting launch_coin…')
  const launchSig = await sendAndConfirm(plan.ixs, payer, [plan.baseMint], alt!, log)
  return { mint: plan.baseMint.publicKey, launchSig }
}
