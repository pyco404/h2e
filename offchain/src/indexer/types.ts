import { BalanceEvent } from '../aged-balance'

/** One SPL transfer leg: a signed balance delta for a wallet on a mint. */
export interface TransferLeg { mint: string; wallet: string; delta: bigint }

/** All transfer legs of a single transaction. Intra-tx legs for the same
 *  (wallet, mint) are netted by the indexer into one post-balance event. */
export interface TxTransfers { txSig: string; slot: number; ts: number; txIndex: number; legs: TransferLeg[] }

/** A tracked coin, discovered by watching CoinConfig creations (§7.5b). */
export interface CoinRecord { mint: string; dbcPool: string; launchTs: number; defaultPayoutMint: string; createdSlot: number }

/** A persisted balance point: the wallet's post-tx balance on a mint. */
export interface StoredBalance extends BalanceEvent { mint: string; wallet: string }

export { BalanceEvent }
