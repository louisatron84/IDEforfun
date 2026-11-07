# Forge's run tracer: runs the user's program exactly as `python file.py` /
# `python -m module` would, and about 10 times a second tells Forge (over a
# local socket) which of the project's functions is running and which called
# which. Standard library only. If Forge can't be reached, the program just
# runs. Started as: python -u -c <this> --script FILE args... | --module NAME args...


def _forge_trace():
    import errno
    import json
    import os
    import runpy
    import socket
    import sys
    import threading
    import time

    mode, target, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    root_abs = os.path.abspath(os.environ.pop("FORGE_TRACE_ROOT", os.getcwd()))
    root_cmp = os.path.normcase(root_abs).rstrip("\\/") + os.sep
    port = int(os.environ.pop("FORGE_TRACE_PORT", "0") or 0)
    token = os.environ.pop("FORGE_TRACE_TOKEN", "")
    skip_dirs = {".venv", "venv", "env", "site-packages", "dist-packages", "node_modules", ".forge", "__pycache__"}

    # ---------- talking to Forge ----------
    conn = {"sock": None}
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=2)
        s.settimeout(5)
        conn["sock"] = s
    except (OSError, ValueError):
        pass

    send_lock = threading.Lock()

    def send(msg):
        s = conn["sock"]
        if s is None:
            return
        data = (json.dumps(msg) + "\n").encode("utf-8")
        with send_lock:
            try:
                s.sendall(data)
            except OSError:
                conn["sock"] = None

    send({"t": "hello", "token": token})

    # ---------- which code is the project's ----------
    ids = {}

    def ident(code):
        try:
            return ids[code]
        except KeyError:
            pass
        found = None
        fn = code.co_filename
        if fn and not fn.startswith("<"):
            path = os.path.abspath(fn)
            if os.path.normcase(path).startswith(root_cmp):
                parts = path[len(root_cmp):].replace("\\", "/").split("/")
                if not any(p in skip_dirs for p in parts[:-1]) and parts[-1].endswith((".py", ".pyw")):
                    parts[-1] = parts[-1].rsplit(".", 1)[0]
                    if parts[-1] == "__init__":
                        parts.pop()
                    module = ".".join(parts)
                    name = code.co_name
                    if name == "<module>":
                        found = "module:" + module
                    elif not name.startswith("<"):
                        qual = getattr(code, "co_qualname", name)
                        if "<locals>" not in qual:
                            found = module + ":" + qual
        ids[code] = found
        return found

    def project_frame(frame, limit=64):
        while frame is not None and limit > 0:
            found = ident(frame.f_code)
            if found is not None:
                return found
            frame = frame.f_back
            limit -= 1
        return None

    # ---------- the profile hook: counts caller -> callee, and records recursion ----------
    state = {"calls": {}}
    # Recursion trees: each thread's stack of project calls is followed; when a
    # function calls itself (directly or further down), the calls of it form a
    # tree: arguments in, value returned. Capped per tree and per run.
    stacks = {}
    trees = {}
    tree_dirty = set()
    tree_seq = [0]
    MAX_TREE = 300
    MAX_TREES = 5

    def short(v, n=24):
        try:
            r = repr(v)
        except Exception:
            r = "<%s>" % type(v).__name__
        return r if len(r) <= n else r[:n - 1] + "\u2026"

    def args_of(frame):
        code = frame.f_code
        names = code.co_varnames[:code.co_argcount + code.co_kwonlyargcount]
        local = frame.f_locals
        return ", ".join(short(local.get(name)) for name in names[:4] if name not in ("self", "cls"))

    # ---------- data: what values look like (summaries) ----------
    # For one function chosen in Forge (FORGE_TRACE_DATA = "module:qual"): what
    # each line of its first call produced. For every project function: what
    # went in and what came out, for its first two calls. Values are summarised
    # here (type, size, a few rows; DataFrames: shape, columns, first rows).
    data_target = os.environ.pop("FORGE_TRACE_DATA", "")
    IO_CALLS = 2
    MAX_IO_FUNCS = 300
    io_records = {}
    io_dirty = set()

    def summarise(v, rows=5):
        t = type(v)
        name = t.__qualname__ if t.__module__ == "builtins" else "%s.%s" % (t.__module__.split(".")[0], t.__qualname__)
        s = {"type": name}
        try:
            if hasattr(v, "columns") and hasattr(v, "dtypes") and hasattr(v, "shape") and hasattr(v, "head"):
                s["kind"] = "dataframe"
                s["shape"] = [int(x) for x in v.shape]
                s["columns"] = [[str(c), str(dt)] for c, dt in list(v.dtypes.items())[:60]]
                head = v.head(rows)
                s["index"] = [short(i, 20) for i in list(head.index)]
                s["rows"] = [[short(x, 40) for x in r] for r in head.itertuples(index=False, name=None)]
            elif hasattr(v, "dtype") and hasattr(v, "shape") and hasattr(v, "head") and hasattr(v, "items"):
                s["kind"] = "series"
                s["shape"] = [int(x) for x in v.shape]
                s["dtype"] = str(v.dtype)
                s["name"] = short(getattr(v, "name", None), 30)
                s["rows"] = [[short(i, 20), short(x, 40)] for i, x in list(v.head(rows).items())]
            elif isinstance(v, (list, tuple, set, frozenset)):
                items = list(v)
                s["kind"] = "sequence"
                s["len"] = len(items)
                if items and all(isinstance(x, dict) for x in items[:rows]):
                    cols = []
                    for d in items[:rows]:
                        for k in d:
                            if k not in cols and len(cols) < 20:
                                cols.append(k)
                    s["columns"] = [[str(c), ""] for c in cols]
                    s["rows"] = [[short(d.get(c), 40) for c in cols] for d in items[:rows]]
                else:
                    s["sample"] = [short(x, 60) for x in items[:rows]]
            elif isinstance(v, dict):
                s["kind"] = "mapping"
                s["len"] = len(v)
                s["sample"] = [[short(k, 30), short(x, 60)] for k, x in list(v.items())[:rows]]
            else:
                s["kind"] = "value"
                s["repr"] = short(v, 120)
        except Exception:
            s["kind"] = "value"
            s["repr"] = short(v, 120)
        return s

    def inputs_of(frame):
        code = frame.f_code
        n = code.co_argcount + code.co_kwonlyargcount
        if code.co_flags & 0x04:
            n += 1
        if code.co_flags & 0x08:
            n += 1
        local = frame.f_locals
        return {name: summarise(local[name]) for name in code.co_varnames[:n] if name not in ("self", "cls") and name in local}

    def io_start(to, frame):
        rec = io_records.get(to)
        if rec is None:
            if len(io_records) >= MAX_IO_FUNCS:
                return None
            rec = io_records[to] = {"func": to, "calls": [], "total": 0}
        rec["total"] += 1
        if len(rec["calls"]) >= IO_CALLS:
            return None
        call = {"in": inputs_of(frame), "out": None}
        rec["calls"].append(call)
        io_dirty.add(to)
        return call

    def io_end(to, call, value):
        call["out"] = summarise(value)
        io_dirty.add(to)

    def send_io():
        for key in list(io_dirty):
            io_dirty.discard(key)
            send({"t": "io", "io": io_records[key]})

    # The watched function: a line-by-line trace of its first call.
    data_state = {"done": False, "prev_line": None, "seen": {}, "sent": 0, "per": {}}

    def data_line(frame, event, arg):
        st = data_state
        if st["done"]:
            return None
        if event in ("line", "return"):
            line = st["prev_line"]
            if line is not None and st["sent"] < 400:
                seen = st["seen"]
                for name, value in list(frame.f_locals.items()):
                    if seen.get(name) is value:
                        continue
                    seen[name] = value
                    key = (line, name)
                    n = st["per"].get(key, 0) + 1
                    st["per"][key] = n
                    if n > 3:  # the same line in a loop: the first few times are enough
                        continue
                    st["sent"] += 1
                    send({"t": "data", "func": data_target, "line": line, "var": name, "n": n, "summary": summarise(value)})
            st["prev_line"] = frame.f_lineno
            if event == "return":
                send({"t": "data", "func": data_target, "line": line, "var": "(returned)", "n": 1, "summary": summarise(arg)})
                st["done"] = True
                sys.settrace(None)
                return None
        return data_line

    def data_call(frame, event, arg):
        if event == "call" and not data_state["done"] and ident(frame.f_code) == data_target:
            # Values set before the first line (the arguments) count as already seen.
            data_state["seen"] = dict(frame.f_locals)
            return data_line
        return None

    def profile(frame, event, arg):
        if event == "return":
            stack = stacks.get(threading.get_ident())
            if stack and stack[-1][1] is frame:
                entry = stack.pop()
                if entry[4] is not None:
                    io_end(entry[0], entry[4], arg)
                if entry[2] is not None:
                    tree = trees[entry[3]]
                    tree["nodes"][entry[2]][2] = short(arg, 40)
                    tree_dirty.add(entry[3])
            return
        if event != "call":
            return
        to = ident(frame.f_code)
        if to is None:
            return
        caller = project_frame(frame.f_back)
        if caller is not None and caller != to:
            calls = state["calls"]
            key = (caller, to)
            calls[key] = calls.get(key, 0) + 1
        stack = stacks.setdefault(threading.get_ident(), [])
        entry = [to, frame, None, None, io_start(to, frame)]  # id, frame, node in its tree, tree key, inputs/output record
        for i in range(len(stack) - 1, max(-1, len(stack) - 200), -1):
            outer = stack[i]
            if outer[0] != to:
                continue
            if outer[3] is None:
                if len(trees) >= MAX_TREES:
                    break
                tree_seq[0] += 1
                key = "%s#%d" % (to, tree_seq[0])
                trees[key] = {"key": key, "func": to, "nodes": [[-1, args_of(outer[1]), None]], "total": 1}
                outer[2], outer[3] = 0, key
            tree = trees[outer[3]]
            tree["total"] += 1
            # Past the cap (or under a call past it), calls are counted but not drawn.
            entry[3] = outer[3]
            if outer[2] is not None and len(tree["nodes"]) < MAX_TREE:
                tree["nodes"].append([outer[2], args_of(frame), None])
                entry[2] = len(tree["nodes"]) - 1
            tree_dirty.add(outer[3])
            break
        stack.append(entry)

    def send_trees():
        for key in list(tree_dirty):
            tree_dirty.discard(key)
            send({"t": "rec", "tree": trees[key]})

    # ---------- network: every request and connection the program makes ----------
    # Hooks http.client (which urllib and requests/urllib3 use), httpx, aiohttp
    # and plain socket connections. Secrets (auth headers, keys in addresses or
    # bodies) are masked here, before anything leaves the program.
    import contextvars
    import re as _re

    net_lock = threading.Lock()
    net_dirty = {}
    net_count = [0]
    run_start = time.monotonic()
    in_http = contextvars.ContextVar("forge_in_http", default=False)
    ip_names = {}
    BODY_MAX = 4096
    MAX_RECORDS = 2000
    SECRET = _re.compile(r"auth|token|secret|passw|pwd|api[-_]?key|apikey|cookie|session|signature|^sig$|^key$|credential", _re.I)
    MASK = "••••"

    def mask_url(url):
        if not url or "?" not in url:
            return url
        base, _, rest = url.partition("?")
        query, hash_, frag = rest.partition("#")
        parts = []
        for piece in query.split("&"):
            name, eq, _value = piece.partition("=")
            parts.append(name + "=" + MASK if eq and SECRET.search(name) else piece)
        return base + "?" + "&".join(parts) + hash_ + frag

    def mask_headers(pairs):
        out = []
        for k, v in pairs:
            k = k.decode("latin-1") if isinstance(k, bytes) else str(k)
            v = v.decode("latin-1", "replace") if isinstance(v, bytes) else str(v)
            out.append([k, MASK if SECRET.search(k) else v[:500]])
        return out[:80]

    def mask_body(data, content_type=""):
        if data is None:
            return None
        if isinstance(data, (bytes, bytearray, memoryview)):
            raw = bytes(data[:BODY_MAX * 2])
            text = raw.decode("utf-8", "replace") if raw[:BODY_MAX].count(b"\0") == 0 else "(%d bytes of binary data)" % len(data)
        elif isinstance(data, str):
            text = data[:BODY_MAX * 2]
        else:
            return None
        stripped = text.lstrip()
        if stripped[:1] in "{[":
            try:
                def clean(v):
                    if isinstance(v, dict):
                        return {k: (MASK if isinstance(k, str) and SECRET.search(k) else clean(x)) for k, x in v.items()}
                    if isinstance(v, list):
                        return [clean(x) for x in v]
                    return v
                parsed = json.loads(text)
                cleaned = clean(parsed)
                if cleaned != parsed:  # only reformat when something was hidden
                    text = json.dumps(cleaned, ensure_ascii=False)
            except ValueError:
                pass
        elif "=" in text and "\n" not in text[:200] and "form" in (content_type or "form"):
            text = mask_url("?" + text)[1:]
        return text[:BODY_MAX]

    def new_record(kind, lib, method, url, host):
        frame = sys._getframe(2)
        with net_lock:
            net_count[0] += 1
            n = net_count[0]
        rec = {
            "id": n, "kind": kind, "lib": lib, "method": method, "url": mask_url(url), "host": host,
            "status": None, "error": None, "start": round((time.monotonic() - run_start) * 1000, 1), "ms": None,
            "func": project_frame(frame, 128), "reqHeaders": [], "respHeaders": [], "reqBody": None, "respBody": None, "size": None,
        }
        rec["_t0"] = time.monotonic()
        return rec

    def touch(rec):
        if rec["id"] > MAX_RECORDS:
            return
        with net_lock:
            net_dirty[rec["id"]] = rec

    def finish_rec(rec, status=None, error=None):
        rec["ms"] = round((time.monotonic() - rec["_t0"]) * 1000, 1)
        if status is not None:
            rec["status"] = int(status)
        if error is not None:
            rec["error"] = (type(error).__name__ + ": " + str(error))[:300]
        touch(rec)

    def which_lib(default):
        f = sys._getframe(2)
        seen = default
        while f is not None:
            name = f.f_globals.get("__name__", "")
            if name.startswith("requests"):
                return "requests"
            if name.startswith("urllib3"):
                seen = "urllib3"
            elif name.startswith("urllib.request") and seen == default:
                seen = "urllib"
            f = f.f_back
        return seen

    def send_net():
        with net_lock:
            recs = list(net_dirty.values())
            net_dirty.clear()
        for rec in recs:
            send({"t": "net", "r": {k: v for k, v in rec.items() if not k.startswith("_")}})

    # --- http.client (urllib, urllib3, requests) ---
    import http.client as _hc

    _put = _hc.HTTPConnection.putrequest
    _puth = _hc.HTTPConnection.putheader
    _endh = _hc.HTTPConnection.endheaders
    _getr = _hc.HTTPConnection.getresponse
    _rread = _hc.HTTPResponse.read
    _rreadinto = _hc.HTTPResponse.readinto

    def putrequest(self, method, url, *a, **kw):
        https = getattr(self, "default_port", 80) == 443
        host = self.host
        port = self.port
        shown = host if port in (None, 80, 443) else "%s:%s" % (host, port)
        full = url if "://" in url else ("https" if https else "http") + "://" + shown + url
        rec = new_record("http", which_lib("http.client"), method, full, host)
        self._forge_rec = rec
        touch(rec)
        token = in_http.set(True)
        try:
            return _put(self, method, url, *a, **kw)
        finally:
            in_http.reset(token)

    def putheader(self, header, *values):
        rec = getattr(self, "_forge_rec", None)
        if rec is not None:
            rec["reqHeaders"].extend(mask_headers([(header, b", ".join(v if isinstance(v, bytes) else str(v).encode("latin-1", "replace") for v in values))]))
        return _puth(self, header, *values)

    def endheaders(self, message_body=None, **kw):
        rec = getattr(self, "_forge_rec", None)
        if rec is not None and message_body is not None:
            ctype = next((v for k, v in rec["reqHeaders"] if k.lower() == "content-type"), "")
            rec["reqBody"] = mask_body(message_body, ctype)
        token = in_http.set(True)
        try:
            return _endh(self, message_body, **kw)
        except BaseException as e:
            if rec is not None:
                finish_rec(rec, error=e)
                self._forge_rec = None
            raise
        finally:
            in_http.reset(token)

    def getresponse(self, *a, **kw):
        rec = getattr(self, "_forge_rec", None)
        try:
            resp = _getr(self, *a, **kw)
        except BaseException as e:
            if rec is not None:
                finish_rec(rec, error=e)
                self._forge_rec = None
            raise
        if rec is not None:
            self._forge_rec = None
            rec["respHeaders"] = mask_headers(resp.getheaders())
            length = resp.getheader("content-length")
            if length and length.isdigit():
                rec["size"] = int(length)
            resp._forge_rec = rec
            resp._forge_buf = bytearray()
            finish_rec(rec, status=resp.status)
        return resp

    def keep_body(resp, data):
        rec = getattr(resp, "_forge_rec", None)
        if rec is None or not data:
            return
        buf = resp._forge_buf
        if len(buf) < BODY_MAX:
            buf.extend(bytes(data[:BODY_MAX - len(buf)]))
            ctype = resp.getheader("content-type") or ""
            rec["respBody"] = mask_body(bytes(buf), ctype)
            touch(rec)

    def rread(self, amt=None):
        # read() may call readinto() itself: only the outermost call keeps the bytes.
        outer = not getattr(self, "_forge_reading", False)
        self._forge_reading = True
        try:
            data = _rread(self, amt)
        finally:
            if outer:
                self._forge_reading = False
        if outer:
            keep_body(self, data)
        return data

    def rreadinto(self, b):
        n = _rreadinto(self, b)
        if n and not getattr(self, "_forge_reading", False):
            keep_body(self, memoryview(b)[:n])
        return n

    # --- httpx and aiohttp: patched when the program imports them ---
    def patch_httpx(mod):
        Client = getattr(mod, "Client", None)
        AsyncClient = getattr(mod, "AsyncClient", None)

        def start(request):
            url = str(request.url)
            rec = new_record("http", "httpx", request.method, url, request.url.host)
            rec["reqHeaders"] = mask_headers(request.headers.raw)
            try:
                rec["reqBody"] = mask_body(request.content, request.headers.get("content-type", ""))
            except Exception:
                pass
            touch(rec)
            return rec

        def done(rec, resp):
            rec["respHeaders"] = mask_headers(resp.headers.raw)
            try:
                rec["respBody"] = mask_body(resp.content, resp.headers.get("content-type", ""))
                rec["size"] = len(resp.content)
            except Exception:
                pass
            finish_rec(rec, status=resp.status_code)

        if Client is not None:
            _send = Client.send

            def send_sync(self, request, *a, **kw):
                rec = start(request)
                token = in_http.set(True)
                try:
                    resp = _send(self, request, *a, **kw)
                except BaseException as e:
                    finish_rec(rec, error=e)
                    raise
                finally:
                    in_http.reset(token)
                done(rec, resp)
                return resp
            Client.send = send_sync
        if AsyncClient is not None:
            _asend = AsyncClient.send

            async def send_async(self, request, *a, **kw):
                rec = start(request)
                token = in_http.set(True)
                try:
                    resp = await _asend(self, request, *a, **kw)
                except BaseException as e:
                    finish_rec(rec, error=e)
                    raise
                finally:
                    in_http.reset(token)
                done(rec, resp)
                return resp
            AsyncClient.send = send_async

    def patch_aiohttp(mod):
        Session = getattr(mod, "ClientSession", None)
        Response = getattr(mod, "ClientResponse", None)
        if Session is None or not hasattr(Session, "_request"):
            return
        _req = Session._request

        async def request(self, method, str_or_url, *a, **kw):
            url = str(str_or_url)
            host = url.split("://", 1)[-1].split("/", 1)[0].split("@")[-1].split(":")[0]
            rec = new_record("http", "aiohttp", str(method).upper(), url, host)
            if kw.get("headers"):
                try:
                    rec["reqHeaders"] = mask_headers(dict(kw["headers"]).items())
                except Exception:
                    pass
            body = kw.get("json")
            rec["reqBody"] = mask_body(json.dumps(body) if body is not None else kw.get("data") if isinstance(kw.get("data"), (str, bytes)) else None)
            touch(rec)
            token = in_http.set(True)
            try:
                resp = await _req(self, method, str_or_url, *a, **kw)
            except BaseException as e:
                finish_rec(rec, error=e)
                raise
            finally:
                in_http.reset(token)
            rec["respHeaders"] = mask_headers(resp.raw_headers)
            resp._forge_rec = rec
            finish_rec(rec, status=resp.status)
            return resp
        Session._request = request

        if Response is not None and hasattr(Response, "read"):
            _read = Response.read

            async def read(self):
                data = await _read(self)
                rec = getattr(self, "_forge_rec", None)
                if rec is not None and data:
                    rec["respBody"] = mask_body(data, self.headers.get("content-type", ""))
                    rec["size"] = len(data)
                    touch(rec)
                return data
            Response.read = read

    import importlib.abc
    import importlib.machinery

    to_patch = {"httpx": patch_httpx, "aiohttp": patch_aiohttp}

    class PatchOnImport(importlib.abc.MetaPathFinder):
        def find_spec(self, name, path, target=None):
            if name not in to_patch:
                return None
            spec = importlib.machinery.PathFinder.find_spec(name, path)
            if spec is None or spec.loader is None or not hasattr(spec.loader, "exec_module"):
                return spec
            loader = spec.loader
            real_exec = loader.exec_module

            def exec_module(module):
                real_exec(module)
                try:
                    to_patch[name](module)
                except Exception:
                    pass  # an unexpected version: just don't watch it
            loader.exec_module = exec_module
            return spec

    # --- plain sockets (databases, websockets, anything else) ---
    _real_getaddrinfo = socket.getaddrinfo
    _connect = socket.socket.connect
    _connect_ex = socket.socket.connect_ex

    def getaddrinfo(host, *a, **kw):
        result = _real_getaddrinfo(host, *a, **kw)
        if isinstance(host, str):
            for info in result[:8]:
                try:
                    ip_names[info[4][0]] = host
                except (IndexError, TypeError):
                    pass
        return result

    def note_connect(sock, address, error=None):
        if in_http.get() or sock.family not in (socket.AF_INET, getattr(socket, "AF_INET6", -1)):
            return
        try:
            ip, port = address[0], address[1]
        except (TypeError, IndexError):
            return
        # Web ports are covered by the HTTP hooks above (libraries often connect before the request starts).
        if port in (80, 443) or (ip in ("127.0.0.1", "::1") and port == conn_port):
            return
        # socketpair() (asyncio's wake-up pipe on Windows) connects to itself: not the program's traffic.
        f = sys._getframe(2)
        for _ in range(6):
            if f is None:
                break
            if f.f_code.co_name == "socketpair" and f.f_globals.get("__name__") == "socket":
                return
            f = f.f_back
        host = ip_names.get(ip, ip)
        rec = new_record("socket", "socket", "CONNECT", "%s:%s" % (host, port), host)
        finish_rec(rec, error=error)

    def connect(self, address):
        try:
            result = _connect(self, address)
        except BlockingIOError:
            note_connect(self, address)
            raise
        except OSError as e:
            note_connect(self, address, e)
            raise
        note_connect(self, address)
        return result

    def connect_ex(self, address):
        code = _connect_ex(self, address)
        pending = (0, errno.EINPROGRESS, getattr(errno, "WSAEWOULDBLOCK", 10035), errno.EWOULDBLOCK)
        note_connect(self, address, None if code in pending else OSError(code, os.strerror(code)))
        return code

    conn_port = port

    def install_net_hooks():
        _hc.HTTPConnection.putrequest = putrequest
        _hc.HTTPConnection.putheader = putheader
        _hc.HTTPConnection.endheaders = endheaders
        _hc.HTTPConnection.getresponse = getresponse
        _hc.HTTPResponse.read = rread
        _hc.HTTPResponse.readinto = rreadinto
        socket.getaddrinfo = getaddrinfo
        socket.socket.connect = connect
        socket.socket.connect_ex = connect_ex
        sys.meta_path.insert(0, PatchOnImport())
        for name, fn in to_patch.items():
            if name in sys.modules:
                try:
                    fn(sys.modules[name])
                except Exception:
                    pass

    # ---------- sending updates ----------
    main_id = threading.main_thread().ident
    last = {"at": None}
    stop = threading.Event()

    def flush():
        send_net()
        send_trees()
        send_io()
        calls, state["calls"] = state["calls"], {}
        frame = sys._current_frames().get(main_id)
        at = project_frame(frame, 256)
        if not calls and at == last["at"]:
            return
        last["at"] = at
        busiest = sorted(calls.items(), key=lambda kv: -kv[1])[:200]
        send({"t": "tick", "at": at, "calls": [[a, b, n] for (a, b), n in busiest]})

    def loop():
        while not stop.wait(0.1):
            flush()

    finished = {"done": False}

    def finish():
        if finished["done"]:
            return
        finished["done"] = True
        sys.setprofile(None)
        threading.setprofile(None)
        if data_target:
            sys.settrace(None)
        stop.set()
        flush()
        send({"t": "end"})
        s = conn["sock"]
        if s is not None:
            try:
                s.close()
            except OSError:
                pass
            conn["sock"] = None

    def is_user_file(fn):
        return bool(fn) and not fn.startswith("<") and os.path.normcase(os.path.abspath(fn)).startswith(root_cmp) and "runpy" not in fn

    if conn["sock"] is not None:
        threading.Thread(target=loop, name="forge-trace", daemon=True).start()
        install_net_hooks()
        if data_target:
            sys.settrace(data_call)
        threading.setprofile(profile)
        sys.setprofile(profile)

    # ---------- running the program as Python would ----------
    try:
        if mode == "--module":
            sys.argv = [target] + args
            sys.path[0] = os.getcwd()
            runpy.run_module(target, run_name="__main__", alter_sys=True)
        else:
            path = os.path.abspath(target)
            sys.argv = [target] + args
            sys.path[0] = os.path.dirname(path)
            runpy.run_path(path, run_name="__main__")
    except SystemExit:
        finish()
        raise
    except BaseException as exc:
        finish()
        # The traceback starts at the user's code: Forge's and runpy's frames are left out.
        tb = exc.__traceback__
        while tb is not None and not is_user_file(tb.tb_frame.f_code.co_filename):
            tb = tb.tb_next
        exc.__traceback__ = tb
        sys.excepthook(type(exc), exc, tb)
        sys.exit(130 if isinstance(exc, KeyboardInterrupt) else 1)
    finally:
        finish()


_forge_trace()
