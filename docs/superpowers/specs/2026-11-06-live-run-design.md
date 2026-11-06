# Live run feedback ("where it's at")

Date: 2026-11-06 · Status: draft for review
Follows: `2026-11-06-forge-design.md` ("Later: live run feedback"). Roadmap: Tier 4 "Live run feedback on the graph", start of 5.5 "Show current execution position on the graph".

## Intent

While your program runs, the Graph shows **where it's at**: the function running right now glows, and a spark travels along the line each time one function calls another. It is **just visual feedback to watch** (user's words: "just watch, it's just cool visual feedback"). No pausing, no inspecting, no controls.

The user also sees it being useful for **workflows** later (the block library idea: watching data move from step to step). The design keeps the tracer general (function calls in, positions out) so a workflow view can reuse it; nothing workflow-specific is built now.

## Goals

- Pressing **▶ Run** with the Graph in view shows the run live, in both views:
  - **Calls view:** the running function's node glows; sparks travel along call edges as calls happen.
  - **Modules view:** the module holding the running function glows; sparks travel along the import edge between the caller's module and the callee's module.
- **API boxes join in:** when a box's generated function runs, the box glows and its wire is live (the same look as during a Test call).
- **Molten:** heat glow and sparks. **Plain:** a highlight and a moving dot, no glow. **Reduced motion:** highlight only, nothing moves.
- When the program ends, the glow fades out over about a second and the graph returns to normal.
- Programs keep working exactly as before: same output, input, exit codes, and the tracer never shows up in tracebacks or output.

## Non-goals

- Pausing, stepping, clicking to inspect, variable values (that is the debugger; 5.5 later).
- Tracing Debug sessions or Tests (debugpy and pytest have their own tracing; they are left alone).
- Network request list / inspector (5.2): the tracer is built so it could carry requests later, but nothing is shown now.
- Recording or replaying a run.

## Anti-goals

- Making normal runs slower when nobody is watching. (Tracing only happens when the Graph is in view when Run starts, see below.)
- A graph that flickers or turns into noise on busy programs.

## How it works (builder's calls, marked)

- **Only the project's own code is traced** (files under the project folder, not `.venv`/`site-packages`/the standard library). *(My call: keeps it fast and readable.)*
- **When:** a run is traced when the **Graph panel is visible at the moment Run starts** (e.g. in the Connect task) and the setting **"Show runs on the graph"** (Settings, default on) is on. Runs started from other tasks are not traced, so they pay nothing. *(My call.)*
- **The tracer** is a small Python script Forge bundles and starts the program through (like `projectScan.py`): it installs a profile hook for project files only, then runs the user's script or module exactly as Python would (`runpy`, same `sys.argv`, same `__main__`). Works on the Python versions the scan supports.
- **Channel:** the tracer talks to Forge over a local socket (127.0.0.1, a port Forge opens per run), never through stdout/stderr, so program output is untouched. If the socket can't be opened the program still runs, untraced.
- **Rate:** the tracer sends a small update about **10 times a second**: the function at the top of the project call stack right now, and how many times each caller→callee pair was called since the last update. *(My call: with thousands of calls a second you can't see each one anyway; a busy line gets more sparks / a brighter trail, capped.)*
- **Ids** match the Graph's: `module:qualname` for functions, `module` for modules, so the window just looks them up. Calls to functions the Graph doesn't show are ignored.
- **Threads:** all threads are traced; the "where it's at" glow follows the main thread. *(My call.)*

## What the user sees, precisely

- **Glow:** the current node (or box) glows; the previous one fades over ~0.6 s, so a fast program shows a short trail.
- **Sparks:** each update, up to ~12 sparks are started on the edges with calls, busiest first; a spark takes ~0.5 s to travel the edge.
- **Off-screen:** the view does not move on its own (it is a watch view; panning stays the user's).
- **Status:** the Graph's status line shows `● Running (traced)` while a traced run is going.

## Constraints

- Same rules as the rest of Forge: hand-written SVG, colours from theme tokens, gradients only on the guard's allow-list (or SVG gradients as the live wire already does), reduced motion respected.
- No new dependencies (Python side: standard library only).
- Unit tests for the pure parts (tracer message parsing, update → glow/spark plan, id mapping) and a test that runs the real tracer on a small script and checks the updates; the user's rule stands: no in-app runs unless they ask.

## Left to the builder

- Exact animation timings and glow sizes within the numbers above.
- Profile hook choice (`sys.setprofile` vs `sys.monitoring` on 3.12+).
- How the update message is encoded (JSON lines is fine).
