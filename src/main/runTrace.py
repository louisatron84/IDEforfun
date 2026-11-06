# Forge's run tracer: runs the user's program exactly as `python file.py` /
# `python -m module` would, and about 10 times a second tells Forge (over a
# local socket) which of the project's functions is running and which called
# which. Standard library only. If Forge can't be reached, the program just
# runs. Started as: python -u -c <this> --script FILE args... | --module NAME args...


def _forge_trace():
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

    def send(msg):
        s = conn["sock"]
        if s is None:
            return
        try:
            s.sendall((json.dumps(msg) + "\n").encode("utf-8"))
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

    # ---------- the profile hook: counts caller -> callee ----------
    state = {"calls": {}}

    def profile(frame, event, arg):
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

    # ---------- sending updates ----------
    main_id = threading.main_thread().ident
    last = {"at": None}
    stop = threading.Event()

    def flush():
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
