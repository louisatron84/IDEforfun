# Big session: the rest of Tier 5, plus Tier 3 and Tier 4 leftovers

Branch: `big-session` (from `unreachable-code`). One commit per feature; tick docs/CHECKLIST.md in the same commit.
Rules: no subagents; no in-app/e2e runs unless asked (unit tests, typecheck, build are fine).
Patch CRLF files with Python scripts written via the Write tool (Bash heredocs eat backslashes).

## Decisions (asked 2026-11-06)
- Network: both graph sparks (green ok / red failed) and a Network panel (list, filter, details, timeline, compare runs).
- Pipeline blocks: pandas (the project needs pandas installed).
- Floating windows: real OS windows (BrowserWindow per floated panel).
- Semantic highlighting: switch the bundled server from pyright to basedpyright.
- Skipped: "Later: AI-assisted API docs" and "Someday: step-back timeline".

## Order
1. 5.2 Network: tracer hooks (http.client, requests via urllib3/http.client, httpx, aiohttp, raw sockets), events over the trace socket, Network panel, graph sparks, compare runs.
2. 5.5 Execution: live call graph and position while debugging (DAP stack), variable values on nodes, change history, recursion tree, object relationships, compare states.
3. 5.3 API: OpenAPI import (endpoint functions, dataclass models, auth), client module + imports, detect edits to generated code.
4. 5.4 Data flow: trace values between functions (types, shapes), inputs/outputs, origins, pipeline graph, DataFrame shapes/columns/preview, block library, user blocks, for-each, export.
5. Tier 3: basedpyright semantic tokens.
6. Tier 4: information density, animated transitions, context-aware tools, visual navigation, floating windows.

## Ledger
- unreachable code (5.1): done, df2f7a7
- 5.2 network: done, bf934e6
- 5.5 debug on graph: 3811058; recursion + replay: next commit
