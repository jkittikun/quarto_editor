/** Candidate Python interpreters, in priority order (shared logic for detection, unit-tested). */
export interface PythonCandidate {
  path: string;
  label: string;
  source: "project" | "env" | "conda" | "pyenv" | "system" | "custom";
}

export interface CandidateInputs {
  root: string;
  home: string;
  env: Record<string, string | undefined>;
  /** Directory listing helper: names of entries in `dir` (empty if missing). */
  list: (dir: string) => string[];
  /** Whether a file exists. */
  exists: (path: string) => boolean;
  /** Lines of ~/.conda/environments.txt (empty if missing). */
  condaEnvs: string[];
  windows?: boolean;
}

export function pythonCandidates(i: CandidateInputs): PythonCandidate[] {
  const bin = i.windows ? "Scripts/python.exe" : "bin/python";
  const out: PythonCandidate[] = [];
  const add = (path: string, label: string, source: PythonCandidate["source"]) => {
    if (path && !out.some((c) => c.path === path)) out.push({ path, label, source });
  };
  // 1. virtual environments inside the project
  for (const name of [".venv", "venv", "env", ".env"]) {
    const p = `${i.root}/${name}/${bin}`;
    if (i.exists(p)) add(p, name, "project");
  }
  for (const name of i.list(i.root)) {
    if (i.exists(`${i.root}/${name}/pyvenv.cfg`) && i.exists(`${i.root}/${name}/${bin}`)) add(`${i.root}/${name}/${bin}`, name, "project");
  }
  // 2. explicit configuration
  for (const v of ["FOLIO_PYTHON", "QUARTO_PYTHON"]) {
    const p = i.env[v];
    if (p) add(p, v, "env");
  }
  // 3. conda
  const condaRoots = ["miniconda3", "anaconda3", "miniforge3", "mambaforge"].map((d) => `${i.home}/${d}`);
  const condaDirs = new Set<string>(i.condaEnvs.map((l) => l.trim()).filter(Boolean));
  for (const r of condaRoots) {
    if (i.exists(`${r}/${bin}`)) condaDirs.add(r);
    for (const e of i.list(`${r}/envs`)) condaDirs.add(`${r}/envs/${e}`);
  }
  for (const d of condaDirs) {
    if (!i.exists(`${d}/${bin}`)) continue;
    const name = condaRoots.includes(d) ? "base" : d.split("/").pop()!;
    add(`${d}/${bin}`, `conda: ${name}`, "conda");
  }
  // 4. pyenv
  for (const v of i.list(`${i.home}/.pyenv/versions`)) {
    const p = `${i.home}/.pyenv/versions/${v}/${bin}`;
    if (i.exists(p)) add(p, `pyenv ${v}`, "pyenv");
  }
  // 5. system
  for (const p of ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]) {
    if (i.exists(p)) add(p, p.startsWith("/opt/homebrew") ? "Homebrew" : "system", "system");
  }
  add("python3", "python3 on PATH", "system");
  return out;
}

/** Python snippet printing "<version> <ready>" where ready means the kernel packages import. */
export const PROBE =
  "import sys,importlib.util as u;print(sys.version.split()[0], all(u.find_spec(m) is not None for m in ('jupyter_client','ipykernel')))";

export function parseProbe(out: string): { version: string; ready: boolean } | null {
  const m = /^(\d+\.\d+\.\d+\S*)\s+(True|False)\s*$/m.exec(out);
  return m ? { version: m[1], ready: m[2] === "True" } : null;
}
