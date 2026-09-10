import { PublicKey } from '@solana/web3.js'
import { conn } from './rpc'
import {
  pdas, decodeGlobalConfig, decodeCoinConfig, decodePlatformAllowlist,
  allCoinConfigs, epochsForMint, bucketsForEpoch, payoutVaultBalance, platformAllowlistMints,
} from '../../h2e/client'
import { deriveMintMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { assetLabel as catLabel } from './catalog'

// Read-only chain access. Every decode goes through client/index.ts — this file
// never parses account bytes itself.

export async function loadGlobal(): Promise<any | null> {
  const info = await conn().getAccountInfo(pdas.global())
  return info ? decodeGlobalConfig(info.data) : null
}

export async function loadPlatformAllowlist(): Promise<PublicKey[] | null> {
  const info = await conn().getAccountInfo(pdas.platformAllowlist())
  if (!info) return null
  const dec = decodePlatformAllowlist(info.data)
  return (dec.mints as any[]).map((m) => new PublicKey(m))
}

export async function loadCoin(mint: PublicKey): Promise<any | null> {
  const info = await conn().getAccountInfo(pdas.coinConfig(mint))
  return info ? decodeCoinConfig(info.data) : null
}

// ---- real on-chain reads (Task 3.0), no indexer required ----
/** Every launched coin — real coin discovery via getProgramAccounts(CoinConfig). */
export async function loadCoins(): Promise<any[]> { return allCoinConfigs(conn()) }
/** Payout history: every settled EpochState for a coin, ascending. */
export async function loadEpochs(mint: PublicKey): Promise<any[]> { return epochsForMint(conn(), mint) }
/** Per-asset buckets for one round (amount_in, amount_out, cursor, complete). */
export async function loadBuckets(mint: PublicKey, epochIndex: number): Promise<any[]> {
  return bucketsForEpoch(conn(), pdas.epochState(mint, epochIndex))
}
/** Fees accrued for the current unsettled round = PayoutAuthority WSOL ATA balance. */
export async function loadFeesAccrued(mint: PublicKey): Promise<bigint> { return payoutVaultBalance(conn(), mint) }
export async function loadAllowlistMints(): Promise<PublicKey[]> { return platformAllowlistMints(conn()) }

/** Best-effort token name/symbol from the Metaplex metadata account (not H2E
 *  program data). Returns null for coins without metadata (e.g. demo fixtures). */
export async function loadTokenMeta(mint: PublicKey): Promise<{ name: string; symbol: string } | null> {
  try {
    const info = await conn().getAccountInfo(deriveMintMetadata(mint))
    if (!info) return null
    const d = info.data as Buffer
    let o = 1 + 32 + 32 // key + update_authority + mint
    const readStr = () => { const len = d.readUInt32LE(o); o += 4; const s = d.slice(o, o + len).toString('utf8').replace(/\0+$/, '').trim(); o += len; return s }
    const name = readStr(); const symbol = readStr()
    return name || symbol ? { name, symbol } : null
  } catch { return null }
}

/** Catalog symbol for a mint, or '' if uncatalogued (callers fall back to the
 *  address). Descriptive only — never a permission signal. */
export function mintLabel(mint: PublicKey): string {
  const l = catLabel(mint)
  // catLabel returns a short address when uncatalogued; treat that as "no label"
  return l.includes('…') ? '' : l
}
