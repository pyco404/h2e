import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Asset catalog (§7.5b). Display metadata — name, symbol, logo, category, and the
 * market-hours warning for stocks — keyed to allowlisted mints. It is DESCRIPTIVE
 * ONLY: which mints are permitted is on-chain (`PlatformAllowlist`), never here.
 * `forAllowlist` proves that by taking the on-chain set as the authority and
 * reporting allowlisted mints that have no catalog entry (shown by address).
 */
export type AssetCategory = 'standard' | 'stock' | 'stable'
export interface CatalogEntry { mint: string; name: string; symbol: string; logoUri: string; category: AssetCategory }

export class AssetCatalog {
  private entries = new Map<string, CatalogEntry>()
  put(e: CatalogEntry) { this.entries.set(e.mint, e) }
  get(mint: string): CatalogEntry | undefined { return this.entries.get(mint) }

  /** Market-hours warning applies to stocks (§7.3): routes thin when markets close. */
  marketHoursWarning(mint: string): boolean { return this.entries.get(mint)?.category === 'stock' }

  /**
   * Annotate the ON-CHAIN allowlist (the authority). Returns display entries for
   * mints that have catalog data and the addresses of allowlisted mints that do
   * not — those are still permitted, just shown by address. A catalog entry for a
   * mint NOT in the allowlist is ignored: the catalog can never widen permission.
   */
  forAllowlist(allowlist: Set<string>): { entries: CatalogEntry[]; missing: string[] } {
    const entries: CatalogEntry[] = []
    const missing: string[] = []
    for (const mint of [...allowlist].sort()) {
      const e = this.entries.get(mint)
      if (e) entries.push(e); else missing.push(mint)
    }
    return { entries, missing }
  }
}

/**
 * Metadata pipeline (§7.5b). Accepts an image, hosts it, produces the metadata
 * JSON `launch_coin` needs, and returns the URI. Without this a normal user
 * cannot launch. The interface abstracts the host so production swaps in
 * S3/IPFS/Arweave; the local impl is content-addressed and used in tests.
 */
export interface MetadataInput { name: string; symbol: string; description?: string; imageBytes: Buffer; imageExt: string }
export interface MetadataResult { uri: string; imageUri: string }
export interface MetadataHost { put(input: MetadataInput): Promise<MetadataResult> }

/** Content-addressed local host: writes image + metadata JSON under `dir`, served
 *  from `baseUrl`. Content addressing makes re-uploads idempotent and tamper-evident. */
export class LocalMetadataHost implements MetadataHost {
  constructor(private dir: string, private baseUrl: string) { fs.mkdirSync(dir, { recursive: true }) }
  async put(input: MetadataInput): Promise<MetadataResult> {
    const imgHash = createHash('sha256').update(input.imageBytes).digest('hex').slice(0, 32)
    const imgName = `${imgHash}.${input.imageExt.replace(/^\./, '')}`
    fs.writeFileSync(path.join(this.dir, imgName), input.imageBytes)
    const imageUri = `${this.baseUrl}/${imgName}`
    const metadata = { name: input.name, symbol: input.symbol, description: input.description ?? '', image: imageUri }
    const metaBytes = Buffer.from(JSON.stringify(metadata, null, 2))
    const metaHash = createHash('sha256').update(metaBytes).digest('hex').slice(0, 32)
    const metaName = `${metaHash}.json`
    fs.writeFileSync(path.join(this.dir, metaName), metaBytes)
    return { uri: `${this.baseUrl}/${metaName}`, imageUri }
  }
}
