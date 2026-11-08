/**
 * Project templates (File → New Project from Template…): Forge's own, and
 * yours (Save Project as Template…, kept in Forge's settings folder).
 *
 * A template is a set of text files. In their paths and contents,
 * {{name}} becomes the project's name as typed, {{module}} a Python name
 * made from it ("My Tool" → my_tool) and {{title}} a heading ("My Tool").
 */

export interface TemplateFile {
  /** Relative, with / separators. */
  path: string
  content: string
}

export interface ProjectTemplate {
  id: string
  name: string
  detail: string
  files: TemplateFile[]
  /** The file to open once the project is created. */
  open?: string
  /** Yours (saved from a project), not Forge's. */
  user?: boolean
}

/** A Python identifier from a project name: "My Tool!" → "my_tool", "2048 game" → "game_2048". */
export function moduleName(name: string): string {
  const words = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return 'project'
  if (/^[0-9]/.test(words[0])) words.push(words.shift()!)
  const id = words.join('_')
  return /^[0-9]/.test(id) ? `p_${id}` : id
}

export function titleOf(name: string): string {
  return name.trim().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Why a project name won't do, or null. */
export function projectNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Type a name for the project.'
  if (/[\\/:*?"<>|]/.test(n)) return 'A project name can\'t contain \\ / : * ? " < > |'
  if (n === '.' || n === '..' || n.endsWith('.')) return 'That name can\'t be used for a folder.'
  if (n.length > 80) return 'That name is too long.'
  return null
}

/** The template's files for a project called `name`. */
export function renderTemplate(t: ProjectTemplate, name: string): TemplateFile[] {
  const vars: Record<string, string> = { name: name.trim(), module: moduleName(name), title: titleOf(name) }
  const fill = (s: string) => s.replace(/\{\{(name|module|title)\}\}/g, (_, k: string) => vars[k])
  return t.files.map((f) => ({ path: fill(f.path), content: fill(f.content) }))
}

/** A relative path a template may write: no absolute paths, no "..", nothing odd. */
export function safeTemplatePath(path: string): boolean {
  if (!path || path.length > 240 || /^[\\/]|^[a-zA-Z]:/.test(path) || path.includes('\0')) return false
  return path.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..')
}

const GITIGNORE = ['__pycache__/', '*.pyc', '.venv/', 'venv/', '.env', '.pytest_cache/', 'dist/', 'build/', '*.egg-info/', ''].join('\n')

const runFile = (configs: { name: string; file?: string; module?: string; args?: string[] }[]) =>
  JSON.stringify({ configurations: configs.map((c) => ({ args: [], env: {}, ...c })), tasks: [] }, null, 2) + '\n'

const readme = (intro: string, run: string[]) => ['# {{title}}', '', intro, '', '## Run it', '', ...run, ''].join('\n')

const lines = (...l: string[]) => l.join('\n') + '\n'

export const BUILTIN_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'script',
    name: 'Script',
    detail: 'One Python file to start from',
    open: 'main.py',
    files: [
      { path: 'main.py', content: lines(
        '"""{{title}}."""',
        '',
        '',
        'def main() -> None:',
        '    print("Hello from {{name}}!")',
        '',
        '',
        'if __name__ == "__main__":',
        '    main()'
      ) },
      { path: 'README.md', content: readme('A Python script.', ['Open `main.py` and press F5 (or Ctrl+F5 to run without debugging).']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  },
  {
    id: 'cli',
    name: 'Command-line tool',
    detail: 'Arguments with argparse, and tests',
    open: '{{module}}.py',
    files: [
      { path: '{{module}}.py', content: lines(
        '"""{{title}}: a command-line tool."""',
        'import argparse',
        '',
        '',
        'def greet(name: str, shout: bool = False) -> str:',
        '    text = f"Hello, {name}!"',
        '    return text.upper() if shout else text',
        '',
        '',
        'def main(argv: list[str] | None = None) -> int:',
        '    parser = argparse.ArgumentParser(description="{{title}}")',
        '    parser.add_argument("name", help="who to greet")',
        '    parser.add_argument("--shout", action="store_true", help="say it loudly")',
        '    args = parser.parse_args(argv)',
        '    print(greet(args.name, args.shout))',
        '    return 0',
        '',
        '',
        'if __name__ == "__main__":',
        '    raise SystemExit(main())'
      ) },
      { path: 'tests/test_{{module}}.py', content: lines(
        'import sys',
        'from pathlib import Path',
        '',
        'sys.path.insert(0, str(Path(__file__).resolve().parent.parent))',
        '',
        'from {{module}} import greet, main  # noqa: E402',
        '',
        '',
        'def test_greet():',
        '    assert greet("Ada") == "Hello, Ada!"',
        '',
        '',
        'def test_shout():',
        '    assert greet("Ada", shout=True) == "HELLO, ADA!"',
        '',
        '',
        'def test_main(capsys):',
        '    assert main(["Ada"]) == 0',
        '    assert capsys.readouterr().out == "Hello, Ada!\\n"'
      ) },
      { path: 'requirements.txt', content: lines('pytest') },
      { path: '.forge/run.json', content: runFile([{ name: '{{module}} Ada', file: '{{module}}.py', args: ['Ada'] }]) },
      { path: 'README.md', content: readme('A command-line tool.', ['Choose the "{{module}} Ada" run configuration and press F5, or in the terminal:', '', '    python {{module}}.py Ada --shout', '', 'Tests: open the Tests panel and run them all (they use pytest).']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  },
  {
    id: 'fastapi',
    name: 'Web API (FastAPI)',
    detail: 'A small JSON API with routes and tests',
    open: 'app/main.py',
    files: [
      { path: 'app/__init__.py', content: '' },
      { path: 'app/main.py', content: lines(
        '"""{{title}}: a web API."""',
        'from fastapi import FastAPI, HTTPException',
        'from pydantic import BaseModel',
        '',
        'app = FastAPI(title="{{title}}")',
        '',
        '',
        'class Item(BaseModel):',
        '    name: str',
        '    price: float',
        '',
        '',
        'ITEMS: dict[int, Item] = {1: Item(name="Teapot", price=12.5)}',
        '',
        '',
        '@app.get("/")',
        'def home() -> dict[str, str]:',
        '    return {"message": "Hello from {{name}}"}',
        '',
        '',
        '@app.get("/items/{item_id}")',
        'def get_item(item_id: int) -> Item:',
        '    if item_id not in ITEMS:',
        '        raise HTTPException(status_code=404, detail="No such item")',
        '    return ITEMS[item_id]',
        '',
        '',
        '@app.post("/items")',
        'def add_item(item: Item) -> dict[str, int]:',
        '    item_id = max(ITEMS, default=0) + 1',
        '    ITEMS[item_id] = item',
        '    return {"id": item_id}'
      ) },
      { path: 'tests/test_main.py', content: lines(
        'from fastapi.testclient import TestClient',
        '',
        'from app.main import app',
        '',
        'client = TestClient(app)',
        '',
        '',
        'def test_home():',
        '    assert client.get("/").json() == {"message": "Hello from {{name}}"}',
        '',
        '',
        'def test_missing_item():',
        '    assert client.get("/items/999").status_code == 404'
      ) },
      { path: 'requirements.txt', content: lines('fastapi', 'uvicorn', 'httpx', 'pytest') },
      { path: '.forge/run.json', content: runFile([{ name: 'Web server', module: 'uvicorn', args: ['app.main:app', '--reload'] }]) },
      { path: 'README.md', content: readme('A web API made with FastAPI.', ['Choose the "Web server" run configuration and press F5, then open http://127.0.0.1:8000/docs to try the API.']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  },
  {
    id: 'flask',
    name: 'Web app (Flask)',
    detail: 'Pages from templates, and a form',
    open: 'app.py',
    files: [
      { path: 'app.py', content: lines(
        '"""{{title}}: a web app."""',
        'from flask import Flask, render_template, request',
        '',
        'app = Flask(__name__)',
        'NOTES: list[str] = []',
        '',
        '',
        '@app.route("/", methods=["GET", "POST"])',
        'def index():',
        '    if request.method == "POST" and request.form.get("note"):',
        '        NOTES.append(request.form["note"])',
        '    return render_template("index.html", notes=NOTES)',
        '',
        '',
        'if __name__ == "__main__":',
        '    app.run(debug=True)'
      ) },
      { path: 'templates/index.html', content: lines(
        '<!doctype html>',
        '<html lang="en">',
        '<head><meta charset="utf-8"><title>{{title}}</title></head>',
        '<body>',
        '  <h1>{{title}}</h1>',
        '  <form method="post"><input name="note" placeholder="Write a note"> <button>Add</button></form>',
        '  <ul>{% for note in notes %}<li>{{ note }}</li>{% endfor %}</ul>',
        '</body>',
        '</html>'
      ) },
      { path: 'requirements.txt', content: lines('flask') },
      { path: 'README.md', content: readme('A web app made with Flask.', ['Open `app.py` and press F5, then open http://127.0.0.1:5000.']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  },
  {
    id: 'data',
    name: 'Data analysis',
    detail: 'Read a CSV with pandas, summarise it, save the result',
    open: 'analysis.py',
    files: [
      { path: 'analysis.py', content: lines(
        '"""{{title}}: a data analysis."""',
        'from pathlib import Path',
        '',
        'import pandas as pd',
        '',
        'DATA = Path(__file__).parent / "data"',
        '',
        '',
        'def load() -> pd.DataFrame:',
        '    return pd.read_csv(DATA / "sales.csv", parse_dates=["date"])',
        '',
        '',
        'def by_product(sales: pd.DataFrame) -> pd.DataFrame:',
        '    sales = sales.assign(total=sales["quantity"] * sales["price"])',
        '    return sales.groupby("product", as_index=False)["total"].sum().sort_values("total", ascending=False)',
        '',
        '',
        'def main() -> None:',
        '    summary = by_product(load())',
        '    print(summary.to_string(index=False))',
        '    summary.to_csv(DATA / "summary.csv", index=False)',
        '',
        '',
        'if __name__ == "__main__":',
        '    main()'
      ) },
      { path: 'data/sales.csv', content: lines(
        'date,product,quantity,price',
        '2026-01-03,Teapot,2,12.50',
        '2026-01-04,Mug,6,4.00',
        '2026-01-04,Teapot,1,12.50',
        '2026-01-07,Kettle,1,30.00',
        '2026-01-09,Mug,3,4.00'
      ) },
      { path: 'requirements.txt', content: lines('pandas') },
      { path: 'README.md', content: readme('A data analysis with pandas. Open the Pipeline panel on `by_product` to see the data at each step.', ['Open `analysis.py` and press F5. It writes `data/summary.csv`.']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  },
  {
    id: 'tkinter',
    name: 'Desktop app (Tkinter)',
    detail: 'A window with a button, no packages to install',
    open: 'app.py',
    files: [
      { path: 'app.py', content: lines(
        '"""{{title}}: a desktop app."""',
        'import tkinter as tk',
        '',
        '',
        'class App(tk.Tk):',
        '    def __init__(self) -> None:',
        '        super().__init__()',
        '        self.title("{{title}}")',
        '        self.count = 0',
        '        self.label = tk.Label(self, text="Clicked 0 times", padx=40, pady=20)',
        '        self.label.pack()',
        '        tk.Button(self, text="Click me", command=self.clicked).pack(pady=(0, 20))',
        '',
        '    def clicked(self) -> None:',
        '        self.count += 1',
        '        self.label.config(text=f"Clicked {self.count} times")',
        '',
        '',
        'if __name__ == "__main__":',
        '    App().mainloop()'
      ) },
      { path: 'README.md', content: readme('A desktop app made with Tkinter (part of Python).', ['Open `app.py` and press F5.']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  },
  {
    id: 'package',
    name: 'Package with tests',
    detail: 'A pyproject.toml package in src/, with pytest',
    open: 'src/{{module}}/core.py',
    files: [
      { path: 'pyproject.toml', content: lines(
        '[build-system]',
        'requires = ["setuptools>=68"]',
        'build-backend = "setuptools.build_meta"',
        '',
        '[project]',
        'name = "{{module}}"',
        'version = "0.1.0"',
        'description = "{{title}}"',
        'requires-python = ">=3.10"',
        '',
        '[project.optional-dependencies]',
        'test = ["pytest"]',
        '',
        '[tool.pytest.ini_options]',
        'testpaths = ["tests"]'
      ) },
      { path: 'src/{{module}}/__init__.py', content: lines('"""{{title}}."""', 'from .core import add', '', '__all__ = ["add"]') },
      { path: 'src/{{module}}/core.py', content: lines(
        'def add(a: float, b: float) -> float:',
        '    """Add two numbers."""',
        '    return a + b'
      ) },
      { path: 'tests/test_core.py', content: lines(
        'from {{module}} import add',
        '',
        '',
        'def test_add():',
        '    assert add(2, 3) == 5'
      ) },
      { path: 'requirements.txt', content: lines('-e .[test]') },
      { path: 'README.md', content: readme('A Python package.', ['Install it into the project\'s .venv (Forge offers to), then run the tests from the Tests panel.']) },
      { path: '.gitignore', content: GITIGNORE }
    ]
  }
]
