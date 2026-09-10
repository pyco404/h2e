// Tiny DOM helpers — no framework (React/wallet-adapter aren't installable offline).
export type Attrs = Record<string, any>

export function h(tag: string, attrs: Attrs = {}, children: (Node | string | null | undefined)[] = []): HTMLElement {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') e.className = v
    else if (k === 'html') e.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'value') (e as HTMLInputElement).value = v
    else e.setAttribute(k, String(v))
  }
  for (const c of children) if (c != null) e.append(c as any)
  return e
}
export const txt = (s: string) => document.createTextNode(s)
export function mount(root: HTMLElement, ...nodes: (Node | null)[]) { root.replaceChildren(...nodes.filter(Boolean) as Node[]) }

/** A money amount — always marigold, per the semantic-colour rule. */
export const amt = (s: string) => h('span', { class: 'amt' }, [s])
/** A choice the holder/creator makes — always ultramarine. */
export const choice = (s: string) => h('span', { class: 'choice' }, [s])

/** Honest empty state: what will appear here, and why it isn't there yet. */
export function empty(what: string, why: string): HTMLElement {
  return h('div', { class: 'empty' }, [h('strong', {}, [what]), h('span', { class: 'why' }, [why])])
}

export function short(addr: string, n = 4): string { return addr.length <= n * 2 + 1 ? addr : `${addr.slice(0, n)}…${addr.slice(-n)}` }

export function stat(label: string, valueNode: Node | string): HTMLElement {
  return h('div', { class: 'stat' }, [h('dt', {}, [label]), h('dd', {}, [typeof valueNode === 'string' ? txt(valueNode) : valueNode])])
}
