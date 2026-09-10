import { Connection } from '@solana/web3.js'

// The RPC endpoint. Defaults to a local validator (the only target that works
// offline); overridable via ?rpc= or localStorage so the same build points at
// devnet when egress is available. No mainnet default on a scaffold.
const DEFAULT_RPC = 'http://127.0.0.1:8899'

export function rpcUrl(): string {
  const q = new URLSearchParams(location.search).get('rpc')
  if (q) { try { localStorage.setItem('h2e.rpc', q) } catch {} return q }
  try { return localStorage.getItem('h2e.rpc') || DEFAULT_RPC } catch { return DEFAULT_RPC }
}

let _conn: Connection | null = null
export function conn(): Connection {
  if (!_conn) _conn = new Connection(rpcUrl(), 'confirmed')
  return _conn
}
export function resetConn() { _conn = null }
