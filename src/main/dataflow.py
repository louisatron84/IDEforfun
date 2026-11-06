# Forge's data-flow reader: the source of one Python file on stdin, a function's
# qualified name as the argument (or nothing: just list the functions). Prints
# JSON: the function's parameters and its body as steps, each with the names it
# sets and the names it uses (so Forge can draw which step's data goes where),
# and the call it makes, if any. Only reads the code; never runs it.
import ast
import json
import sys


def text_of(source, node, limit=160):
    seg = ast.get_source_segment(source, node) or ''
    seg = ' '.join(seg.split())
    return seg if len(seg) <= limit else seg[:limit - 1] + '…'


def dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    return None


def loads(node):
    """Names read in an expression or statement (not those bound inside comprehensions, lambdas or nested defs)."""
    found = []
    bound = set()

    def walk(n):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            return
        if isinstance(n, ast.Lambda):
            for a in n.args.args:
                bound.add(a.arg)
        if isinstance(n, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            for gen in n.generators:
                for t in ast.walk(gen.target):
                    if isinstance(t, ast.Name):
                        bound.add(t.id)
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in found:
            found.append(n.id)
        for child in ast.iter_child_nodes(n):
            walk(child)

    walk(node)
    return [x for x in found if x not in bound]


def names_in_target(t):
    out = []
    for n in ast.walk(t):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
            out.append(n.id)
    return out


def call_info(source, value):
    if isinstance(value, ast.Await):
        value = value.value
    if not isinstance(value, ast.Call):
        return None
    name = dotted(value.func)
    if not name:
        return None
    args = [{'kw': None, 'text': text_of(source, a, 80), 'names': loads(a)} for a in value.args]
    args += [{'kw': k.arg, 'text': text_of(source, k.value, 80), 'names': loads(k.value)} for k in value.keywords]
    return {'name': name, 'args': args}


def step_of(source, st):
    s = {'line': st.lineno, 'endLine': getattr(st, 'end_lineno', st.lineno), 'code': text_of(source, st), 'targets': [], 'uses': [], 'call': None}
    if isinstance(st, ast.Assign):
        s['kind'] = 'assign'
        for t in st.targets:
            s['targets'] += names_in_target(t)
        s['uses'] = loads(st.value)
        s['call'] = call_info(source, st.value)
    elif isinstance(st, ast.AnnAssign):
        s['kind'] = 'assign'
        s['targets'] = names_in_target(st.target)
        s['uses'] = loads(st.value) if st.value is not None else []
        s['call'] = call_info(source, st.value) if st.value is not None else None
    elif isinstance(st, ast.AugAssign):
        s['kind'] = 'assign'
        s['targets'] = names_in_target(st.target)
        s['uses'] = [n for n in names_in_target(st.target)] + [n for n in loads(st.value) if n not in names_in_target(st.target)]
        s['call'] = call_info(source, st.value)
    elif isinstance(st, ast.Expr):
        s['kind'] = 'call' if isinstance(st.value, (ast.Call, ast.Await)) else 'other'
        s['uses'] = loads(st.value)
        s['call'] = call_info(source, st.value)
    elif isinstance(st, ast.Return):
        s['kind'] = 'return'
        s['uses'] = loads(st.value) if st.value is not None else []
        s['call'] = call_info(source, st.value) if st.value is not None else None
    elif isinstance(st, (ast.For, ast.AsyncFor)):
        s['kind'] = 'for'
        s['code'] = 'for %s in %s' % (text_of(source, st.target, 40), text_of(source, st.iter, 80))
        s['targets'] = names_in_target(st.target)
        s['uses'] = loads(st.iter)
        s['loop'] = {'targets': names_in_target(st.target), 'over': text_of(source, st.iter, 80)}
        s['body'] = [step_of(source, b) for b in st.body]
    elif isinstance(st, (ast.If, ast.While)):
        s['kind'] = 'if' if isinstance(st, ast.If) else 'while'
        s['code'] = '%s %s' % (s['kind'], text_of(source, st.test, 80))
        s['uses'] = loads(st.test)
        s['body'] = [step_of(source, b) for b in st.body] + [step_of(source, b) for b in st.orelse]
    elif isinstance(st, (ast.With, ast.AsyncWith)):
        s['kind'] = 'with'
        s['code'] = 'with ' + ', '.join(text_of(source, i.context_expr, 60) for i in st.items)
        for item in st.items:
            s['uses'] += [n for n in loads(item.context_expr) if n not in s['uses']]
            if item.optional_vars is not None:
                s['targets'] += names_in_target(item.optional_vars)
        s['body'] = [step_of(source, b) for b in st.body]
    elif isinstance(st, ast.Try):
        s['kind'] = 'try'
        s['code'] = 'try'
        s['body'] = [step_of(source, b) for b in st.body + st.orelse + st.finalbody] + [step_of(source, b) for h in st.handlers for b in h.body]
    elif isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        s['kind'] = 'def'
        s['code'] = ('class ' if isinstance(st, ast.ClassDef) else 'def ') + st.name
        s['targets'] = [st.name]
    else:
        s['kind'] = 'other'
        s['uses'] = loads(st)
    return s


def functions(tree):
    out = []

    def walk(body, prefix):
        for n in body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
                out.append({'qual': prefix + n.name, 'line': n.lineno, 'endLine': getattr(n, 'end_lineno', n.lineno)})
                walk(n.body, prefix + n.name + '.')
            elif isinstance(n, ast.ClassDef):
                walk(n.body, prefix + n.name + '.')

    walk(tree.body, '')
    return out


def find(tree, qual):
    body = tree.body
    node = None
    for part in qual.split('.'):
        node = next((n for n in body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == part), None)
        if node is None:
            return None
        body = node.body
    return node if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else None


def main():
    source = sys.stdin.read()
    qual = sys.argv[1] if len(sys.argv) > 1 else ''
    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        print(json.dumps({'error': 'SyntaxError: %s (line %s)' % (e.msg, e.lineno)}))
        return
    out = {'functions': functions(tree)}
    if qual:
        fn = find(tree, qual)
        if fn is None:
            out['error'] = 'No function %s in this file.' % qual
        else:
            a = fn.args
            params = []
            positional = a.posonlyargs + a.args
            defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
            for arg, d in zip(positional, defaults):
                params.append({'name': arg.arg, 'annotation': text_of(source, arg.annotation, 60) if arg.annotation else None, 'default': text_of(source, d, 60) if d is not None else None})
            for arg, d in zip(a.kwonlyargs, a.kw_defaults):
                params.append({'name': arg.arg, 'annotation': text_of(source, arg.annotation, 60) if arg.annotation else None, 'default': text_of(source, d, 60) if d is not None else None})
            body = fn.body
            doc = ast.get_docstring(fn)
            if doc and body and isinstance(body[0], ast.Expr):
                body = body[1:]
            out.update({
                'func': qual, 'line': fn.lineno, 'endLine': getattr(fn, 'end_lineno', fn.lineno),
                'params': params, 'returns': text_of(source, fn.returns, 60) if fn.returns else None,
                'doc': (doc or '').strip().split('\n')[0], 'steps': [step_of(source, st) for st in body],
            })
    sys.stdout.write(json.dumps(out))


main()
