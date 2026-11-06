# Reads every Python file of a project with the `ast` module and prints what the
# IDE's project graph needs as JSON: modules, imports, classes and functions with
# the calls and names they use, web routes (Flask, FastAPI), outgoing HTTP calls
# (requests, httpx, aiohttp) and environment variables.
#
# Run as:  python - <project folder>   (this script on stdin, JSON on stdout)
# Only reads files; never imports or runs the project's code.
import ast
import json
import os
import sys

SKIP_DIRS = {
    '.git', '.hg', '.svn', '__pycache__', 'node_modules', '.venv', 'venv', 'env', '.env',
    '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', 'build', 'dist',
    'site-packages', '.ideforfun', '.idea', '.vscode', '.eggs',
}
MAX_FILES = 3000
MAX_BYTES = 2_000_000
HTTP_LIBS = {'requests', 'httpx', 'aiohttp'}
HTTP_METHODS = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request', 'stream'}
ROUTE_METHODS = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route', 'api_route', 'websocket'}


def dotted(node):
    """'a.b.c' for a Name/Attribute chain, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return '.'.join(reversed(parts))
    if isinstance(node, ast.Call):  # e.g. requests.Session().get -> "requests.Session().get"
        inner = dotted(node.func)
        if inner:
            parts.append(inner + '()')
            return '.'.join(reversed(parts))
    return None


def const_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):  # f"https://api.x.com/{id}" -> "https://api.x.com/{…}"
        out = []
        for v in node.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                out.append(v.value)
            else:
                out.append('{…}')
        return ''.join(out)
    return None


class FileScan(ast.NodeVisitor):
    def __init__(self):
        self.imports = []
        self.defs = []
        self.routes = []
        self.http = []
        self.env = []
        self.all_names = None
        self.stack = []  # enclosing defs (dicts)
        self.module_def = {'name': '<module>', 'qual': '<module>', 'kind': 'module', 'line': 1, 'endLine': 1, 'calls': [], 'refs': set(), 'decorators': []}
        self.http_aliases = {}  # local name -> library ('requests', 'httpx', 'aiohttp')

    @property
    def current(self):
        return self.stack[-1] if self.stack else self.module_def

    def current_qual(self):
        return self.stack[-1]['qual'] if self.stack else None

    # ---- imports ----
    def visit_Import(self, node):
        for a in node.names:
            self.imports.append({'module': a.name, 'names': [], 'alias': a.asname, 'level': 0, 'line': node.lineno})
            top = a.name.split('.')[0]
            if top in HTTP_LIBS:
                self.http_aliases[a.asname or top] = top

    def visit_ImportFrom(self, node):
        names = [a.name for a in node.names]
        self.imports.append({'module': node.module or '', 'names': names, 'alias': None, 'level': node.level or 0, 'line': node.lineno})
        if (node.module or '').split('.')[0] in HTTP_LIBS:
            for a in node.names:
                self.http_aliases[a.asname or a.name] = (node.module or '').split('.')[0]

    # ---- definitions ----
    def _def(self, node, kind):
        parent = self.stack[-1] if self.stack else None
        if kind == 'function' and parent is not None and parent['kind'] == 'class':
            kind = 'method'
        qual = f"{parent['qual']}.{node.name}" if parent else node.name
        d = {
            'name': node.name, 'qual': qual, 'kind': kind, 'line': node.lineno,
            'endLine': getattr(node, 'end_lineno', node.lineno) or node.lineno,
            'calls': [], 'refs': set(),
            'decorators': [x for x in (dotted(dec.func if isinstance(dec, ast.Call) else dec) for dec in node.decorator_list) if x],
        }
        if kind == 'class':
            d['bases'] = [b for b in (dotted(x) for x in node.bases) if b]
        self.defs.append(d)
        for dec in node.decorator_list:
            self.visit(dec)
            self._route(dec, qual, node.lineno)
        self.stack.append(d)
        for child in node.body:
            self.visit(child)
        self.stack.pop()
        # Defaults and annotations belong to the enclosing scope.
        if kind != 'class':
            for x in node.args.defaults + node.args.kw_defaults:
                if x is not None:
                    self.visit(x)
        else:
            for b in node.bases:
                self.visit(b)

    def visit_FunctionDef(self, node):
        self._def(node, 'function')

    def visit_AsyncFunctionDef(self, node):
        self._def(node, 'function')

    def visit_ClassDef(self, node):
        self._def(node, 'class')

    # ---- web routes: @app.get("/x"), @router.post(...), @app.route("/x", methods=[...]) ----
    def _route(self, dec, qual, line):
        if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
            return
        method = dec.func.attr
        if method not in ROUTE_METHODS or not dec.args:
            return
        path = const_str(dec.args[0])
        if path is None or not path.startswith('/'):
            return
        if method in ('route', 'api_route'):
            methods = ['GET']
            for kw in dec.keywords:
                if kw.arg == 'methods' and isinstance(kw.value, (ast.List, ast.Tuple, ast.Set)):
                    methods = [m.upper() for m in (const_str(e) for e in kw.value.elts) if m]
            framework = 'flask' if method == 'route' else 'fastapi'
        else:
            methods = [method.upper()]
            framework = 'fastapi'
        self.routes.append({'methods': methods, 'path': path, 'func': qual, 'line': line, 'framework': framework, 'owner': dotted(dec.func.value)})

    # ---- calls, names, HTTP, environment ----
    def visit_Call(self, node):
        name = dotted(node.func)
        if name:
            self.current['calls'].append({'name': name, 'line': node.lineno})
            self._http(node, name)
            self._env_call(node, name)
        self.generic_visit(node)

    def _http(self, node, name):
        parts = name.split('.')
        lib = self.http_aliases.get(parts[0])
        method = parts[-1].lower()
        if lib is None:
            # Session objects: requests.Session().get / httpx.Client().post
            if len(parts) >= 2 and parts[0] in HTTP_LIBS:
                lib = parts[0]
            else:
                return
        if method not in HTTP_METHODS or len(parts) < 2:
            # from requests import get -> get(...)
            if len(parts) == 1 and lib and parts[0] in HTTP_METHODS:
                method = parts[0]
            else:
                return
        url = const_str(node.args[0]) if node.args else None
        if method == 'request' and len(node.args) >= 2:
            m = const_str(node.args[0])
            url = const_str(node.args[1])
            method = (m or 'request').lower()
        for kw in node.keywords:
            if kw.arg == 'url':
                url = const_str(kw.value)
        self.http.append({'library': lib, 'method': method.upper(), 'url': url, 'line': node.lineno, 'func': self.current_qual()})

    def _env_call(self, node, name):
        # os.getenv("X"), os.environ.get("X"), environ.get("X"), getenv("X")
        if name in ('os.getenv', 'getenv', 'os.environ.get', 'environ.get', 'os.environ.setdefault', 'environ.setdefault') and node.args:
            key = const_str(node.args[0])
            if key:
                self.env.append({'name': key, 'line': node.lineno, 'func': self.current_qual(), 'default': len(node.args) > 1})

    def visit_Subscript(self, node):
        # os.environ["X"]
        base = dotted(node.value)
        if base in ('os.environ', 'environ'):
            key = const_str(node.slice if not isinstance(node.slice, ast.Index) else node.slice.value)  # ast.Index: Python < 3.9
            if key:
                self.env.append({'name': key, 'line': node.lineno, 'func': self.current_qual(), 'default': False})
        self.generic_visit(node)

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.current['refs'].add(node.id)

    def visit_Attribute(self, node):
        if isinstance(node.ctx, ast.Load):
            self.current['refs'].add(node.attr)
        self.generic_visit(node)

    def _client_alias(self, name_node, value):
        """c = requests.Session() / httpx.Client(...): calls on c are HTTP calls of that library."""
        if isinstance(name_node, ast.Name) and isinstance(value, ast.Call):
            created = dotted(value.func)
            if created:
                lib = self.http_aliases.get(created.split('.')[0])
                if lib and created.split('.')[-1][:1].isupper():
                    self.http_aliases[name_node.id] = lib

    def visit_Assign(self, node):
        # __all__ = ["a", "b"]: names the module exports.
        if any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets) and isinstance(node.value, (ast.List, ast.Tuple)):
            self.all_names = [s for s in (const_str(e) for e in node.value.elts) if s]
        for t in node.targets:
            self._client_alias(t, node.value)
        self.generic_visit(node)

    def visit_With(self, node):
        for item in node.items:
            if item.optional_vars is not None:
                self._client_alias(item.optional_vars, item.context_expr)
        self.generic_visit(node)

    visit_AsyncWith = visit_With


def module_name(rel):
    parts = rel[:-3].split('/')
    is_package = parts[-1] == '__init__'
    if is_package:
        parts = parts[:-1]
    return '.'.join(parts), is_package


def scan_file(root, rel):
    path = os.path.join(root, *rel.split('/'))
    mod, is_package = module_name(rel)
    entry = {'path': rel, 'module': mod, 'isPackage': is_package, 'imports': [], 'defs': [], 'routes': [], 'http': [], 'env': [], 'lines': 0}
    try:
        if os.path.getsize(path) > MAX_BYTES:
            entry['error'] = 'too large to analyse'
            return entry
        with open(path, 'rb') as f:
            source = f.read()
        entry['lines'] = source.count(b'\n') + 1
        tree = ast.parse(source, filename=rel)
    except SyntaxError as e:
        entry['error'] = f'SyntaxError: {e.msg} (line {e.lineno})'
        return entry
    except Exception as e:  # unreadable file, encoding problems...
        entry['error'] = f'{type(e).__name__}: {e}'
        return entry
    s = FileScan()
    s.module_def['endLine'] = entry['lines']
    s.visit(tree)
    defs = [s.module_def] + s.defs
    for d in defs:
        d['refs'] = sorted(d['refs'])
    entry.update(imports=s.imports, defs=defs, routes=s.routes, http=s.http, env=s.env)
    if s.all_names is not None:
        entry['all'] = s.all_names
    entry['main'] = any(
        isinstance(n, ast.If) and isinstance(n.test, ast.Compare) and dotted(n.test.left) == '__name__'
        for n in tree.body
    )
    return entry


def main():
    root = os.path.abspath(sys.argv[1])
    files = []
    truncated = False
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith('.') and not os.path.exists(os.path.join(dirpath, d, 'pyvenv.cfg')))
        for name in sorted(filenames):
            if name.endswith('.py'):
                rel = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, '/')
                files.append(rel)
        if len(files) > MAX_FILES:
            truncated = True
            files = files[:MAX_FILES]
            break
    out = {'root': root, 'python': sys.version.split()[0], 'truncated': truncated, 'files': [scan_file(root, rel) for rel in files]}
    sys.stdout.write(json.dumps(out))


if __name__ == '__main__':
    main()
