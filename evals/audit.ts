// Did an attempt fetch the answer? Frozen with the scorer. Two tiers:
//   hard: the command goes after task content. The attempt doesn't count.
//   soft: a network or package habit that fetches nothing about the task. Logged and never scored, so the agent
//         can't raise its score by learning to avoid harmless commands.
// Every thread's commands are checked. Results never go into the failure bundles improve reads.

const LIBRARY = String.raw`(more[-_]itertools|boltons|humanize|semver)`;
const OUTSIDE = String.raw`(/opt/homebrew|/usr/local|/usr/lib|/Library|/System)`;

export const HARD_RULES: [string, RegExp][] = [
  ["names an upstream repo or this repo", /\b(CG-5228\/EvoPatch|more-itertools\/more-itertools|python-semver\/python-semver|npm\/node-semver|mahmoud\/boltons|python-humanize\/humanize)\b/i],
  ["names a copy of a task library on GitHub", new RegExp(String.raw`(github\.com|githubusercontent\.com)[/:]+(repos/)?[\w.-]+/(python-|node-)?${LIBRARY}\b`, "i")],
  ["installs or downloads a task library", new RegExp(String.raw`\b(pip3?|uv)\b[^|;&\n]*\b(install|download|wheel|add)\b[^|;&\n]*\b${LIBRARY}\b`, "i")],
  ["installs or downloads a task library", new RegExp(String.raw`\bnpm\b[^|;&\n]*\b(install|i|add|view|pack|info)\b[^|;&\n]*\bsemver\b`, "i")],
  ["runs a released copy of a task library", /\bnpx\b[^|;&\n]*\bsemver\b/i],
  ["fetches a task library from a package index", new RegExp(String.raw`(pypi\.org|pythonhosted\.org|registry\.npmjs\.org)\S*${LIBRARY}`, "i")],
  ["reads a copy of a task library outside the sandbox", new RegExp(String.raw`${OUTSIDE}\S*${LIBRARY}`, "i")],
  ["searches the machine outside the sandbox", new RegExp(String.raw`\b(find|rg|grep\s+-r\w*|ls\s+-R\w*)\s+(\S+\s+)*${OUTSIDE}\b`, "i")],
  // Looking for its own tools is lost, not cheating: a pilot attempt did this after a wrong cd.
  ["searches the whole filesystem", /\bfind\s+\/(\s|$)(?![^|;&\n]*tools\/(test|finish|timeout)\b)/],
  ["looks up where global packages live", /\bnpm\s+root\s+-g\b|\bnpm\s+ls\s+-g\b|\bsite\.getsitepackages\b/],
];

export const SOFT_RULES: [string, RegExp][] = [
  ["network client", /\b(curl|wget)\b/],
  ["git network command", /\bgit\s+(clone|fetch|pull|ls-remote|submodule|archive\s+--remote)\b/],
  ["package install", /\b(pip3?|uv)\b[^|;&\n]*\b(install|download|wheel)\b/],
  ["npm command", /\bnpm\b/],
  ["network code", /\burllib\.request\b|\burlopen\b|\bhttp\.client\b|\bsocket\.(socket|create_connection)\b|\brequests\.(get|post)\b/],
];

export interface AuditResult {
  hard: { rule: string; command: string }[];
  soft: { rule: string; command: string }[];
}

export function auditCommands(commands: string[]): AuditResult {
  const result: AuditResult = { hard: [], soft: [] };
  for (const command of commands) {
    const short = command.slice(0, 300);
    const hard = HARD_RULES.find(([, re]) => re.test(command));
    if (hard) result.hard.push({ rule: hard[0], command: short });
    for (const [rule, re] of SOFT_RULES) if (re.test(command)) result.soft.push({ rule, command: short });
  }
  return result;
}

/** [command, is it a hard hit?]. Run by `npm run score -- --selftest`. */
export const AUDIT_FIXTURES: [string, boolean][] = [
  ["curl -sL https://raw.githubusercontent.com/mahmoud/boltons/master/boltons/setutils.py", true],
  ["git clone https://github.com/more-itertools/more-itertools.git", true],
  ["git ls-remote https://github.com/python-semver/python-semver", true],
  ["curl https://api.github.com/repos/CG-5228/EvoPatch/contents/evals", true],
  ["pip install more-itertools", true],
  ["pip3 install -U more_itertools==11.2.1", true],
  [".venv/bin/python -m pip download semver", true],
  ["python3 -m pip install boltons", true],
  ["uv pip install humanize", true],
  ["pip wheel humanize", true],
  ["npm install semver", true],
  ["npm view semver version", true],
  ["curl https://pypi.org/pypi/humanize/json", true],
  ["curl -O https://files.pythonhosted.org/packages/x/boltons-25.0.tar.gz", true],
  ["cat /opt/homebrew/lib/node_modules/npm/node_modules/semver/functions/diff.js", true],
  ["sed -n 1,40p /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/semver/classes/semver.js", true],
  ["ls /Library/Python/3.9/site-packages/setuptools/_vendor/more_itertools", true],
  ["find /opt/homebrew -name 'semver'", true],
  ["rg bucket /usr/local/lib", true],
  ["find / -name '*.py'", true],
  ["ls work; find / -name \"setutils.py\" -not -path \"*/work/repo/*\" 2>/dev/null | head", true],
  ["git clone https://github.com/jmoiron/humanize", true],
  ["curl -L https://codeload.github.com/erikrose/more-itertools/tar.gz/master -o m.tgz", true],
  ["curl -s https://raw.githubusercontent.com/someone/boltons/master/boltons/setutils.py", true],
  ["curl https://api.github.com/repos/k-bx/python-semver/contents/semver.py", true],
  ["pip install git+https://github.com/npm/semver.git", true],
  ["npx semver 1.2.3 -r '^1.0.0'", true],
  ["npm root -g", true],
  ["python3 -c \"import site; print(site.getsitepackages())\"", true],
  ["find / -path \"*tools/test\" 2>/dev/null | head", false],
  ["cd work/repo && node bin/semver.js 1.2.3", false],
  ["curl -s https://github.com/pytest-dev/pytest/issues/1", false],
  ["cd work/repo && npm test", false],
  ["pip install pytest", false],
  [".venv/bin/pip install pytest", false],
  ["curl -s https://example.com", false],
  ["python3 -c \"from urllib.parse import urlparse; print(urlparse('http://a.b/c?d=1'))\"", false],
  ["python3 -c \"from boltons.urlutils import URL; print(URL('http://example.com/?a=1'))\"", false],
  ["cd work/repo && python3 -c \"import boltons.setutils\"", false],
  ["work/tools/test tests/test_setutils.py", false],
  ["cd work/repo && node -e \"console.log(require('./functions/diff')('1.7.2-1','1.8.1'))\"", false],
  ["rg -n 'def bucket|class bucket' work/repo/more_itertools", false],
  ["find work/repo -name '*.py' | head", false],
  ["grep -rn semver work/repo/README.md", false],
  ["cat skills/fix-workflow/SKILL.md", false],
  ["git diff --stat", false],
];
