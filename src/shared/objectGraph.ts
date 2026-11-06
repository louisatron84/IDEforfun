/**
 * Object relationships while debugging: a Python helper, evaluated in the
 * paused frame through the debugger, walks the objects the local variables
 * point to (attributes, list / dict items; a few levels, capped) and returns
 * them as JSON; here that becomes boxes and arrows (shared objects appear once).
 */
export const OBJECT_HELPER = String.raw`
def forge_objects(ns, max_nodes=40, max_items=8, max_depth=3):
    import json, types
    prim = (int, float, complex, bool, str, bytes, type(None))
    skip = (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType, type)
    nodes = {}
    edges = []

    def short(v):
        try:
            r = repr(v)
        except Exception:
            r = "<%s>" % type(v).__name__
        return r if len(r) <= 40 else r[:39] + "…"

    def visit(obj, depth):
        key = id(obj)
        if key in nodes:
            return key
        if len(nodes) >= max_nodes:
            return None
        node = {"id": str(key), "type": type(obj).__name__, "fields": [], "more": 0}
        nodes[key] = node
        children = []
        if isinstance(obj, dict):
            items = list(obj.items())
            node["len"] = len(items)
            children = [(k if isinstance(k, str) else short(k), v) for k, v in items[:max_items]]
            node["more"] = max(0, len(items) - max_items)
        elif isinstance(obj, (list, tuple, set, frozenset)):
            items = list(obj)
            node["len"] = len(items)
            ordered = isinstance(obj, (list, tuple))
            children = [("[%d]" % i if ordered else "·", v) for i, v in enumerate(items[:max_items])]
            node["more"] = max(0, len(items) - max_items)
        else:
            attrs = getattr(obj, "__dict__", None)
            if isinstance(attrs, dict):
                pairs = list(attrs.items())
            else:
                slots = getattr(type(obj), "__slots__", ())
                slots = (slots,) if isinstance(slots, str) else slots
                pairs = [(s, getattr(obj, s)) for s in slots if hasattr(obj, s)]
            children = pairs[:16]
            node["more"] = max(0, len(pairs) - 16)
            if not pairs:
                node["fields"].append(["", short(obj)])
        for name, value in children:
            if isinstance(value, prim) or isinstance(value, skip) or depth >= max_depth:
                node["fields"].append([str(name), short(value)])
                continue
            target = visit(value, depth + 1)
            if target is None:
                node["fields"].append([str(name), short(value)])
            else:
                edges.append([str(key), str(target), str(name)])
        return key

    roots = []
    for name, value in list(ns.items()):
        if name.startswith("__") or isinstance(value, prim) or isinstance(value, skip):
            continue
        key = visit(value, 0)
        if key is not None:
            roots.append([name, str(key)])
    return json.dumps({"roots": roots, "nodes": list(nodes.values()), "edges": edges}, ensure_ascii=True)
`

/** The expression to evaluate in a paused frame (its locals are the starting points). */
export function objectGraphExpression(): string {
  return `(lambda g, L: (exec(${JSON.stringify(OBJECT_HELPER)}, g), g['forge_objects'](L))[1])({}, locals())`
}

/** A Python string as the debugger shows it ('...' with escapes), back to its text. Plain text is returned as is. */
export function unreprString(s: string): string {
  const t = s.trim()
  const q = t[0]
  if ((q !== "'" && q !== '"') || t[t.length - 1] !== q || t.length < 2) return t
  const body = t.slice(1, -1)
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e: string) => {
    if (e[0] === 'x' || e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16))
    return ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[e] ?? e
  })
}

export interface ObjNode {
  id: string
  type: string
  fields: [string, string][]
  more: number
  len?: number
}
export interface ObjGraph {
  roots: [string, string][]
  nodes: ObjNode[]
  edges: [string, string, string][]
}

export function parseObjectGraph(result: string): ObjGraph | null {
  let raw: unknown
  try {
    raw = JSON.parse(unreprString(result))
  } catch {
    return null
  }
  const r = raw as Partial<ObjGraph>
  if (!r || !Array.isArray(r.roots) || !Array.isArray(r.nodes) || !Array.isArray(r.edges)) return null
  const str = (v: unknown) => typeof v === 'string'
  const nodes = r.nodes.filter((n): n is ObjNode => !!n && str(n.id) && str(n.type) && Array.isArray(n.fields))
    .map((n) => ({ id: n.id, type: n.type, fields: n.fields.filter((f) => Array.isArray(f) && str(f[0]) && str(f[1])), more: typeof n.more === 'number' ? n.more : 0, ...(typeof n.len === 'number' ? { len: n.len } : {}) }))
  const ids = new Set(nodes.map((n) => n.id))
  return {
    roots: r.roots.filter((x): x is [string, string] => Array.isArray(x) && str(x[0]) && ids.has(x[1])),
    nodes,
    edges: r.edges.filter((e): e is [string, string, string] => Array.isArray(e) && ids.has(e[0]) && ids.has(e[1]) && str(e[2]))
  }
}
