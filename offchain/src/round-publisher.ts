import * as fs from 'fs'
import * as path from 'path'
import { RoundPlan, buildRoundFile, RoundFile } from './round-builder'

/**
 * Round-file publication (§7.5c). The keeper publishes each settled round's file
 * to a stable per-round URL; the transparency page fetches it and recomputes the
 * root against the on-chain anchor. Serving from the platform API is sufficient
 * for correctness — the on-chain root makes a tampered file non-reproducible.
 * Availability if H2E disappears is recoverable (any holder's copy still verifies
 * against the root); content-addressed archival is an improvement, not a blocker.
 */
export class RoundStore {
  constructor(private dir: string) { fs.mkdirSync(dir, { recursive: true }) }
  private file(mint: string, epoch: number) { return path.join(this.dir, `round-${mint}-${epoch}.json`) }

  /** Publish a settled round (call after settle_epoch + swaps are on-chain). */
  publish(plan: RoundPlan): RoundFile {
    const file = buildRoundFile(plan)
    fs.writeFileSync(this.file(plan.mint, plan.epochIndex), JSON.stringify(file))
    return file
  }
  get(mint: string, epoch: number): RoundFile | null {
    const p = this.file(mint, epoch)
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as RoundFile) : null
  }
}

/**
 * Minimal HTTP handler for `GET /round?mint=&epoch=`, matching what the
 * transparency page fetches. Wire into any http server; kept framework-free.
 */
export function roundHandler(store: RoundStore) {
  return (reqUrl: string): { status: number; body: string; contentType: string } => {
    const u = new URL(reqUrl, 'http://x')
    if (u.pathname !== '/round') return { status: 404, body: 'not found', contentType: 'text/plain' }
    const mint = u.searchParams.get('mint'), epoch = Number(u.searchParams.get('epoch'))
    if (!mint || Number.isNaN(epoch)) return { status: 400, body: 'mint and epoch required', contentType: 'text/plain' }
    const file = store.get(mint, epoch)
    if (!file) return { status: 404, body: 'round not published', contentType: 'text/plain' }
    return { status: 200, body: JSON.stringify(file), contentType: 'application/json' }
  }
}
