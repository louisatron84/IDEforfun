# Reads every Python file of a project with the `ast` module and prints what the
# IDE's project graph needs as JSON: modules, imports, classes and functions with
# the calls and names they use, web routes (Flask, FastAPI), outgoing HTTP calls
# (requests, httpx, aiohttp), environment variables and code that can never run.
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
    'site-packages', '.ideforfun', '.forge', '.idea', '.vscode', '.eggs',
}
MAX_FILES = 3000
MAX_BYTES = 2_000_000
HTTP_LIBS = {'requests', 'httpx', 'aiohttp'}
URLLIB_CALLS = {'urllib.request.urlopen', 'request.urlopen', 'urlopen'}
import re as _re
BASE_URL_NAME = _re.compile(r'^(BASE|API|ROOT|SERVER)_?(URL|ADDRESS|ENDPOINT)$|^BASE$', _re.I)
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
        self.base_url = None  # a module-level BASE_URL = "https://..."
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
        else:
            # The signature and first docstring line: pipeline blocks are made from these.
            d['params'] = signature(node)
            d['returns'] = unparse(node.returns)
            doc = ast.get_docstring(node)
            d['doc'] = doc.strip().split('\n')[0][:200] if doc else ''
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
        if name in URLLIB_CALLS:
            # urllib.request.urlopen(url_or_request): the method is usually only known at run time.
            url = const_str(node.args[0]) if node.args else None
            method = 'HTTP'
            for kw in node.keywords:
                if kw.arg == 'method' and const_str(kw.value):
                    method = const_str(kw.value).upper()
            self.http.append({'library': 'urllib', 'method': method, 'url': url, 'line': node.lineno, 'func': self.current_qual()})
            return
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

    def _base_url(self, node):
        """BASE_URL = "https://..." or os.environ.get("X_BASE_URL", "https://...") at the top of a module."""
        if self.current is not self.module_def:
            return
        if not any(isinstance(t, ast.Name) and BASE_URL_NAME.search(t.id) for t in node.targets):
            return
        value = node.value
        url = const_str(value)
        if url is None and isinstance(value, ast.Call) and dotted(value.func) in ('os.getenv', 'getenv', 'os.environ.get', 'environ.get') and len(value.args) >= 2:
            url = const_str(value.args[1])
        if url and url.lower().startswith(('http://', 'https://')):
            self.base_url = url

    def visit_Assign(self, node):
        self._base_url(node)
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


# ---------- code that can never run ----------

STOP_REASONS = ((ast.Return, 'return'), (ast.Raise, 'raise'), (ast.Break, 'break'), (ast.Continue, 'continue'))


def bool_const(test):
    """True or False when a condition is written as a constant, else None."""
    if isinstance(test, ast.Constant) and type(test.value) is bool:
        return test.value
    return None


def block_stops(stmts):
    """Why this block never carries on to the statement after it, or None if it might."""
    for st in stmts:
        reason = stmt_stops(st)
        if reason:
            return reason
    return None


def stmt_stops(st):
    for kind, reason in STOP_REASONS:
        if isinstance(st, kind):
            return reason
    if isinstance(st, ast.If) and st.orelse and block_stops(st.body) and block_stops(st.orelse):
        return 'branches'
    if isinstance(st, ast.Try) or type(st).__name__ == 'TryStar':
        if st.finalbody and block_stops(st.finalbody):
            return block_stops(st.finalbody)
        # Only if no handler can fall through. (A `with` is never counted: its
        # context manager may swallow an exception.)
        if (block_stops(st.body) or block_stops(st.orelse)) and all(block_stops(h.body) for h in st.handlers):
            return 'branches'
    return None


def find_unreachable(tree):
    """Runs of statements that can never run, with the function they're in."""
    found = []

    def note(stmts, func, reason):
        found.append({'line': stmts[0].lineno, 'endLine': stmts[-1].end_lineno, 'func': func, 'reason': reason})

    def block(stmts, func):
        for i, st in enumerate(stmts):
            visit(st, func)
            reason = stmt_stops(st)
            if reason and i + 1 < len(stmts):
                note(stmts[i + 1:], func, reason)
                return

    def visit(st, func):
        if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            block(st.body, st.name if func is None else func + '.' + st.name)
            return
        if isinstance(st, (ast.If, ast.While)):
            value = bool_const(st.test)
            if value is False:
                note(st.body, func, 'constant')
                if st.orelse:
                    block(st.orelse, func)
                return
            if value is True and isinstance(st, ast.If) and st.orelse:
                block(st.body, func)
                note(st.orelse, func, 'constant')
                return
        for field in ('body', 'orelse', 'finalbody'):
            sub = getattr(st, field, None)
            if isinstance(sub, list) and sub and isinstance(sub[0], ast.stmt):
                block(sub, func)
        for handler in getattr(st, 'handlers', None) or []:
            block(handler.body, func)
        for case in getattr(st, 'cases', None) or []:
            block(case.body, func)

    block(tree.body, None)
    return sorted(found, key=lambda u: u['line'])


def unparse(node):
    """Source text of an annotation or default (None if absent or the Python is too old to say)."""
    if node is None or not hasattr(ast, 'unparse'):
        return None
    try:
        text = ast.unparse(node)
    except Exception:
        return None
    return text if len(text) <= 80 else text[:79] + '…'


def signature(fn):
    a = fn.args
    positional = a.posonlyargs + a.args if hasattr(a, 'posonlyargs') else a.args
    defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
    out = [{'name': p.arg, 'annotation': unparse(p.annotation), 'default': unparse(d)} for p, d in zip(positional, defaults)]
    if a.vararg is not None:
        out.append({'name': '*' + a.vararg.arg, 'annotation': unparse(a.vararg.annotation), 'default': None})
    out += [{'name': p.arg, 'annotation': unparse(p.annotation), 'default': unparse(d)} for p, d in zip(a.kwonlyargs, a.kw_defaults)]
    if a.kwarg is not None:
        out.append({'name': '**' + a.kwarg.arg, 'annotation': unparse(a.kwarg.annotation), 'default': None})
    return out[:16]


def fnv_utf16(text):
    """FNV-1a over UTF-16 code units (like Forge's blockHash in TypeScript)."""
    import struct
    data = text.encode('utf-16-le')
    h = 0x811c9dc5
    for (unit,) in struct.iter_unpack('<H', data):
        h ^= unit
        h = (h * 0x01000193) & 0xffffffff
    return '%08x' % h


def generated_mark(source):
    """A client Forge generated (first line `# forge:openapi <slug> <hash>`): which, and whether it was edited since."""
    if not source.startswith(b'# forge:openapi '):
        return None
    try:
        text = source.decode('utf-8').replace('\r\n', '\n')
    except UnicodeDecodeError:
        return None
    first, _, rest = text.partition('\n')
    parts = first.split()
    if len(parts) != 4:
        return None
    return {'kind': 'openapi', 'slug': parts[2], 'edited': fnv_utf16(rest) != parts[3]}


def module_name(rel):
    parts = rel[:-3].split('/')
    is_package = parts[-1] == '__init__'
    if is_package:
        parts = parts[:-1]
    return '.'.join(parts), is_package


# ---------- databases: ORM models, CREATE TABLE in SQL strings, connections ----------
# For the Database explorer. Models: SQLAlchemy (Column / mapped_column),
# SQLModel (table=True), Django and Peewee (models.Model, ...Field()). A
# SQLite file the code connects to (a literal path inside the project) is
# opened read-only to list its real tables; nothing in it is read but the schema.
DB_CONNECT = {
    'sqlite3.connect': ('sqlite', 'sqlite3'), 'aiosqlite.connect': ('sqlite', 'aiosqlite'),
    'create_engine': (None, 'sqlalchemy'), 'sqlalchemy.create_engine': (None, 'sqlalchemy'), 'sa.create_engine': (None, 'sqlalchemy'),
    'create_async_engine': (None, 'sqlalchemy'),
    'psycopg2.connect': ('postgres', 'psycopg2'), 'psycopg.connect': ('postgres', 'psycopg'),
    'asyncpg.connect': ('postgres', 'asyncpg'), 'asyncpg.create_pool': ('postgres', 'asyncpg'),
    'pymysql.connect': ('mysql', 'pymysql'), 'mysql.connector.connect': ('mysql', 'mysql-connector'), 'MySQLdb.connect': ('mysql', 'MySQLdb'),
    'pymongo.MongoClient': ('mongo', 'pymongo'), 'MongoClient': ('mongo', 'pymongo'), 'AsyncIOMotorClient': ('mongo', 'motor'),
    'redis.Redis': ('redis', 'redis'), 'redis.StrictRedis': ('redis', 'redis'), 'redis.from_url': ('redis', 'redis'),
    'SqliteDatabase': ('sqlite', 'peewee'), 'peewee.SqliteDatabase': ('sqlite', 'peewee'),
    'PostgresqlDatabase': ('postgres', 'peewee'), 'MySQLDatabase': ('mysql', 'peewee'),
}
FK_FIELDS = {'ForeignKey', 'OneToOneField', 'ForeignKeyField'}
MANY_FIELDS = {'ManyToManyField'}
CREATE_TABLE = _re.compile(r'create\s+table\s+(?:if\s+not\s+exists\s+)?[`"\[]?([\w.]+)[`"\]]?\s*\(', _re.I)
REFERENCES = _re.compile(r'references\s+[`"\[]?(\w+)[`"\]]?', _re.I)


def last_name(name):
    return (name or '').rsplit('.', 1)[-1]


def mask_secret(url):
    """postgresql://user:password@host -> postgresql://user:***@host"""
    return _re.sub(r'(//[^:/@\s]+:)[^@/\s]*@', r'\1***@', url)


def kw(call, name):
    for k in call.keywords:
        if k.arg == name:
            return k.value
    return None


def kw_true(call, name):
    v = kw(call, name)
    return isinstance(v, ast.Constant) and v.value is True


def class_ref(node):
    """The class a relationship points at: User, "User", "app.User", list["User"], Mapped[Optional["User"]]."""
    if node is None:
        return None
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        names = _re.findall(r'[A-Za-z_][\w.]*', node.value)
        names = [n for n in names if n not in ('Mapped', 'List', 'list', 'Optional', 'Set', 'set', 'None')]
        return last_name(names[-1]) if names else None
    if isinstance(node, (ast.Name, ast.Attribute)):
        return last_name(dotted(node))
    if isinstance(node, ast.Subscript):
        return class_ref(node.slice)
    if isinstance(node, ast.BinOp):  # "User" | None
        return class_ref(node.left)
    if isinstance(node, ast.Tuple) and node.elts:
        return class_ref(node.elts[0])
    return None


def mapped_type(ann):
    """Mapped[int] -> 'int', Mapped[Optional[str]] -> 'str'."""
    if isinstance(ann, ast.Subscript) and last_name(dotted(ann.value)) == 'Mapped':
        inner = ann.slice
        if isinstance(inner, ast.Subscript) and last_name(dotted(inner.value)) == 'Optional':
            inner = inner.slice
        return unparse(inner)
    return unparse(ann) if ann is not None else ''


def snake(name):
    return _re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def model_of(cls, orm='django'):
    """A ClassDef as a database model, or None if it isn't one."""
    bases = [dotted(b) or '' for b in cls.bases]
    sqlmodel = any(k.arg == 'table' and isinstance(k.value, ast.Constant) and k.value.value is True for k in cls.keywords)
    django_like = any(last_name(b) == 'Model' for b in bases)
    table = None
    framework = 'sqlmodel' if sqlmodel else None
    columns, rels = [], []
    explicit_pk = False
    for st in cls.body:
        if isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name):
            name, value, ann = st.targets[0].id, st.value, None
        elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name):
            name, value, ann = st.target.id, st.value, st.annotation
        else:
            continue
        if name == '__tablename__':
            table = const_str(value)
            continue
        fn = last_name(dotted(value.func)) if isinstance(value, ast.Call) else ''
        if fn in ('Column', 'mapped_column'):
            framework = framework or 'sqlalchemy'
            c = {'name': name, 'type': '', 'line': st.lineno}
            args = list(value.args)
            if args and isinstance(args[0], ast.Constant) and isinstance(args[0].value, str):
                c['name'] = args.pop(0).value
            for a in args:
                if isinstance(a, ast.Call) and last_name(dotted(a.func)) == 'ForeignKey':
                    target = const_str(a.args[0]) if a.args else None
                    if target:
                        c['fk'] = target.split('.')[0] if '.' in target else target
                elif not c['type']:
                    c['type'] = unparse(a)
            if not c['type'] and ann is not None:
                c['type'] = mapped_type(ann)
            if kw_true(value, 'primary_key'):
                c['pk'] = True
            if kw_true(value, 'unique'):
                c['unique'] = True
            columns.append(c)
        elif fn in ('relationship', 'Relationship'):
            to = class_ref(value.args[0]) if value.args else class_ref(ann)
            if to:
                rels.append({'name': name, 'to': to, 'kind': 'relationship', 'line': st.lineno})
        elif fn in FK_FIELDS and (django_like or framework):
            framework = framework or ('peewee' if fn == 'ForeignKeyField' else orm)
            to = class_ref(value.args[0]) if value.args else class_ref(kw(value, 'to') or kw(value, 'model'))
            c = {'name': name + '_id', 'type': 'ForeignKey', 'line': st.lineno}
            if to and to != 'self':
                c['fkModel'] = to
            elif to == 'self':
                c['fkModel'] = cls.name
            if fn == 'OneToOneField' or kw_true(value, 'unique'):
                c['unique'] = True
            columns.append(c)
        elif fn in MANY_FIELDS and django_like:
            framework = framework or orm
            to = class_ref(value.args[0]) if value.args else None
            if to:
                rels.append({'name': name, 'to': cls.name if to == 'self' else to, 'kind': 'many', 'line': st.lineno})
        elif fn.endswith('Field') and fn != 'Field' and django_like:
            framework = framework or orm
            c = {'name': name, 'type': fn[:-5] or fn, 'line': st.lineno}
            if kw_true(value, 'primary_key'):
                c['pk'] = True
            if kw_true(value, 'unique'):
                c['unique'] = True
            columns.append(c)
        elif sqlmodel and ann is not None and fn in ('Field', ''):
            c = {'name': name, 'type': unparse(ann), 'line': st.lineno}
            if isinstance(value, ast.Call):
                if kw_true(value, 'primary_key'):
                    c['pk'] = True
                fk = const_str(kw(value, 'foreign_key'))
                if fk:
                    c['fk'] = fk.split('.')[0]
                if kw_true(value, 'unique'):
                    c['unique'] = True
            columns.append(c)
        if columns and columns[-1].get('pk'):
            explicit_pk = True
    if not framework and table is None:
        return None
    if not columns and not rels and table is None:
        return None
    if framework in ('django', 'peewee') and not explicit_pk:
        columns.insert(0, {'name': 'id', 'type': 'AutoField', 'pk': True, 'implicit': True, 'line': cls.lineno})
    if table is None:
        table = snake(cls.name) if framework == 'sqlalchemy' else cls.name.lower()
    return {'name': cls.name, 'table': table, 'framework': framework or 'sqlalchemy', 'line': cls.lineno, 'columns': columns, 'rels': rels}


def split_top(body):
    """Split a CREATE TABLE body at the commas outside brackets."""
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append(''.join(cur))
    return [p.strip() for p in parts if p.strip()]


def sql_tables(text, line):
    """The CREATE TABLE statements in a string of SQL."""
    out = []
    for m in CREATE_TABLE.finditer(text):
        start = m.end()
        depth, end = 1, None
        for i in range(start, len(text)):
            if text[i] == '(':
                depth += 1
            elif text[i] == ')':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        if end is None:
            continue
        cols = []
        for part in split_top(text[start:end]):
            low = part.lower()
            words = part.split()
            if low.startswith('primary key'):
                for name in _re.findall(r'\w+', part[part.index('(') + 1:] if '(' in part else ''):
                    for c in cols:
                        if c['name'] == name:
                            c['pk'] = True
                continue
            if low.startswith('foreign key'):
                inside = _re.search(r'\(([^)]*)\)', part)
                ref = REFERENCES.search(part)
                if inside and ref:
                    for name in _re.findall(r'\w+', inside.group(1)):
                        for c in cols:
                            if c['name'] == name:
                                c['fk'] = ref.group(1)
                continue
            if low.startswith(('constraint', 'unique', 'check', 'index', 'key ')):
                continue
            c = {'name': words[0].strip('`"[]'), 'type': words[1] if len(words) > 1 and words[1].upper() not in ('PRIMARY', 'NOT', 'REFERENCES', 'UNIQUE', 'DEFAULT') else ''}
            if 'primary key' in low:
                c['pk'] = True
            if _re.search(r'\bunique\b', low):
                c['unique'] = True
            ref = REFERENCES.search(part)
            if ref:
                c['fk'] = ref.group(1)
            cols.append(c)
        out.append({'name': m.group(1).split('.')[-1], 'line': line, 'columns': cols})
    return out


def sqlite_schema(root, rel_dir, target):
    """The real tables of a SQLite file in the project the code opens (read-only), or None."""
    if not target or target == ':memory:' or '{' in target:
        return None
    for base in (root, os.path.join(root, rel_dir)):
        path = os.path.realpath(os.path.join(base, target))
        if not os.path.normcase(path).startswith(os.path.normcase(os.path.join(os.path.realpath(root), ''))) or not os.path.isfile(path):
            continue
        rel = os.path.relpath(path, os.path.realpath(root)).replace(os.sep, '/')
        try:
            import sqlite3
            from urllib.request import pathname2url
            con = sqlite3.connect('file:' + pathname2url(path) + '?mode=ro', uri=True, timeout=1)
            try:
                tables = []
                names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()[:200]]
                for name in names:
                    q = name.replace('"', '""')
                    cols = []
                    for info in con.execute('PRAGMA table_info("%s")' % q):  # cid, name, type, notnull, default, pk
                        c = {'name': info[1], 'type': info[2] or ''}
                        if info[5]:
                            c['pk'] = True
                        cols.append(c)
                    for fk in con.execute('PRAGMA foreign_key_list("%s")' % q):
                        for c in cols:
                            if c['name'] == fk[3]:
                                c['fk'] = fk[2]
                    tables.append({'name': name, 'columns': cols})
                return {'file': rel, 'tables': tables}
            finally:
                con.close()
        except Exception as e:
            return {'file': rel, 'error': f'{type(e).__name__}: {e}'}
    return None


def scan_db(tree, root, rel):
    """Models, CREATE TABLE statements and connections in one file (None if it has none)."""
    models, tables, conns = [], [], []
    rel_dir = os.path.dirname(rel)
    orm = 'peewee' if any(
        (isinstance(n, ast.Import) and any(a.name.split('.')[0] == 'peewee' for a in n.names))
        or (isinstance(n, ast.ImportFrom) and (n.module or '').split('.')[0] == 'peewee')
        for n in ast.walk(tree)) else 'django'

    def visit(node, func):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                m = model_of(child, orm)
                if m:
                    models.append(m)
                visit(child, func if func else None)
                continue
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                visit(child, f'{func}.{child.name}' if func else child.name)
                continue
            if isinstance(child, ast.Constant) and isinstance(child.value, str) and 'create' in child.value.lower():
                tables.extend(sql_tables(child.value, child.lineno))
            if isinstance(child, ast.Call):
                name = dotted(child.func)
                hit = DB_CONNECT.get(name or '')
                if hit:
                    kind, library = hit
                    arg = child.args[0] if child.args else (kw(child, 'database') or kw(child, 'url') or kw(child, 'dsn') or kw(child, 'host'))
                    target = const_str(arg) if arg is not None else None
                    if target is not None:
                        target = mask_secret(target)
                    if kind is None:
                        low = (target or '').lower()
                        kind = 'sqlite' if low.startswith('sqlite') else 'postgres' if low.startswith('postgres') else 'mysql' if low.startswith('mysql') else 'sql'
                    c = {'kind': kind, 'library': library, 'target': target, 'func': func, 'line': child.lineno}
                    if kind == 'sqlite' and target:
                        path = target.split(':///', 1)[1] if ':///' in target else target
                        schema = sqlite_schema(root, rel_dir, path.split('?')[0])
                        if schema:
                            c['schema'] = schema
                    conns.append(c)
            visit(child, func)

    visit(tree, None)
    if not (models or tables or conns):
        return None
    return {'models': models, 'tables': tables, 'connections': conns}


def scan_file(root, rel, text=None):
    """One file; `text` (from the editor, unsaved) is used instead of what's on disk when given."""
    path = os.path.join(root, *rel.split('/'))
    mod, is_package = module_name(rel)
    entry = {'path': rel, 'module': mod, 'isPackage': is_package, 'imports': [], 'defs': [], 'routes': [], 'http': [], 'env': [], 'lines': 0}
    try:
        if text is not None:
            source = text.encode('utf-8')
        elif os.path.getsize(path) > MAX_BYTES:
            entry['error'] = 'too large to analyse'
            return entry
        else:
            with open(path, 'rb') as f:
                source = f.read()
        if len(source) > MAX_BYTES:
            entry['error'] = 'too large to analyse'
            return entry
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
    # Calls whose address is built at run time from the module's BASE_URL go to that host.
    if s.base_url:
        for h in s.http:
            if h['url'] is None:
                h['url'] = s.base_url
    generated = generated_mark(source)
    if generated:
        entry['generated'] = generated
    defs = [s.module_def] + s.defs
    for d in defs:
        d['refs'] = sorted(d['refs'])
    entry.update(imports=s.imports, defs=defs, routes=s.routes, http=s.http, env=s.env)
    entry['unreachable'] = find_unreachable(tree)
    db = scan_db(tree, root, rel)
    if db:
        entry['db'] = db
    if s.all_names is not None:
        entry['all'] = s.all_names
    entry['main'] = any(
        isinstance(n, ast.If) and isinstance(n.test, ast.Compare) and dotted(n.test.left) == '__name__'
        for n in tree.body
    )
    return entry


def main():
    root = os.path.abspath(sys.argv[1])
    # Unsaved editor text: a JSON file of {relative path: text}, used instead of the files on disk.
    overrides = {}
    if len(sys.argv) >= 4 and sys.argv[2] == '--overrides':
        with open(sys.argv[3], encoding='utf-8') as f:
            overrides = json.load(f)
    # Just these files (the ones being edited): print a list of their results.
    if len(sys.argv) >= 5 and sys.argv[4] == '--only':
        sys.stdout.write(json.dumps([scan_file(root, rel, overrides.get(rel)) for rel in sys.argv[5:]]))
        return
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
    out = {'root': root, 'python': sys.version.split()[0], 'truncated': truncated, 'files': [scan_file(root, rel, overrides.get(rel)) for rel in files]}
    sys.stdout.write(json.dumps(out))


if __name__ == '__main__':
    main()
