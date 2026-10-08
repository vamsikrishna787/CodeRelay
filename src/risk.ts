export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RiskDecision = 'allow' | 'review' | 'block';

export interface Finding {
  rule: string;
  score: number;
  message: string;
}

export interface Assessment {
  score: number;
  level: RiskLevel;
  decision: RiskDecision;
  findings: Finding[];
}

export interface Thresholds {
  review: number;
  block: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { review: 50, block: 80 };

export function levelFor(score: number): RiskLevel {
  if (score >= 80) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Peak score plus a small bump for each additional meaningful finding. */
export function combine(findings: Finding[], t: Thresholds = DEFAULT_THRESHOLDS): Assessment {
  const peak = findings.reduce((m, f) => Math.max(m, f.score), 0);
  const score = Math.min(100, peak + Math.max(0, findings.filter((f) => f.score >= 25).length - 1) * 5);
  const decision: RiskDecision = score >= t.block ? 'block' : score >= t.review ? 'review' : 'allow';
  return { score, level: levelFor(score), decision, findings };
}

const COMMAND_RULES: Array<[RegExp, number, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\*|\$HOME|[a-z]:\\?)(\s|$)/i, 100, 'recursive force delete of root/home'],
  [/\b(mkfs|diskpart)\b|\bformat\s+[a-z]:|\bdd\s+if=/i, 95, 'disk formatting / raw disk write'],
  [/\brm\s+-[a-z]*r|\brm\s+-[a-z]*f[a-z]*r/i, 70, 'recursive delete'],
  [/Remove-Item\b[^\n]*-Recurse|\b(rd|rmdir)\s+\/s\b|\bdel\s+\/[sq]/i, 70, 'recursive delete (Windows)'],
  [/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, 85, 'destructive SQL'],
  [/\bdelete\s+from\s+\w+\s*(;|$|")/i, 70, 'SQL DELETE without WHERE'],
  [/(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)[^\n|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python|node)\b/i, 90, 'runs a script downloaded from the internet'],
  [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|--force-with-lease)/i, 75, 'force push rewrites remote history'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear))/i, 60, 'discards git work'],
  [/\bgit\s+push\b(?![^\n]*(\s--force\b|\s-f\b|--force-with-lease))/i, 35, 'pushes to a remote'],
  [/\b(npm|yarn|pnpm)\s+publish\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(delete|apply)\b|\bhelm\s+(install|upgrade|uninstall)\b|\b(az|aws|gcloud)\s+\S+\s+(delete|remove|destroy)/i, 75, 'deploys / publishes / mutates infrastructure'],
  [/\b(shutdown|reboot|halt|Stop-Computer|Restart-Computer)\b/i, 85, 'host power operation'],
  [/\bchmod\s+(-R\s+)?777\b|\bchown\s+-R\b|\bicacls\b[^\n]*\/grant\s+everyone/i, 55, 'opens up file permissions'],
  [/\bsudo\b|\brunas\b/i, 45, 'runs with elevated privileges'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add)\b[^\n]*\s-g\b|\bpip\s+install\b(?![^\n]*-r\b)/i, 30, 'installs packages'],
  [/\b(curl|wget|scp|rsync|ftp|nc|ncat|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b|https?:\/\//i, 30, 'reaches the network'],
  [/(^|[\s"'/\\])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|\.aws[\\/]credentials|\.npmrc|\.netrc|\.ssh[\\/])/i, 60, 'touches a credentials file'],
];

/** Risk of running a shell command. */
export function assessCommand(command: string, t: Thresholds = DEFAULT_THRESHOLDS): Assessment {
  const findings: Finding[] = [];
  for (const [re, score, message] of COMMAND_RULES) {
    if (re.test(command)) findings.push({ rule: 'command', score, message });
  }
  // Only the strongest destructive match matters; keep distinct lower signals.
  findings.sort((a, b) => b.score - a.score);
  return combine(dedupe(findings), t);
}

const SECRET_RULES: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub token'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/, 'API secret key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, 'private key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'hard-coded credential'],
];

const CODE_RULES: Array<[RegExp, number, string]> = [
  [/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/, 70, 'disables TLS certificate verification'],
  [/\beval\s*\(|new\s+Function\s*\(/, 45, 'dynamic code execution (eval)'],
  [/child_process[^\n]*\bexec(Sync)?\s*\(\s*[`'"][^`'"]*\$\{|subprocess\.[a-z_]+\([^)]*shell\s*=\s*True/, 60, 'shell command built from variables (injection risk)'],
  [/\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*['"`]\s*\+\s*\w|\b(SELECT|INSERT|UPDATE|DELETE)\b[^;\n]*\$\{/i, 55, 'SQL built by string concatenation (injection risk)'],
  [/\.innerHTML\s*=|dangerouslySetInnerHTML/, 35, 'raw HTML injection (XSS risk)'],
  [/Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]|cors\(\s*\)/, 30, 'allows any origin (CORS *)'],
  [/\bMath\.random\(\)[^\n]*(token|secret|password|key)/i, 40, 'insecure randomness for secrets'],
];

const SENSITIVE_FILE = /(^|[\\/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|.*\.pem|.*\.key|\.npmrc|\.netrc|credentials(\.json)?)$/i;

/** Risk findings for one changed file's contents. */
export function scanFile(file: string, content: string): Finding[] {
  const findings: Finding[] = [];
  if (SENSITIVE_FILE.test(file) && !/\.example$|\.sample$|\.template$/i.test(file)) {
    findings.push({ rule: 'sensitive-file', score: 65, message: `${file} is a credentials/secret file` });
  }
  const lines = content.split('\n');
  const test = (re: RegExp) => lines.findIndex((l) => re.test(l));
  for (const [re, label] of SECRET_RULES) {
    const i = test(re);
    if (i >= 0) findings.push({ rule: 'secret', score: 90, message: `possible ${label} in ${file}:${i + 1}` });
  }
  for (const [re, score, label] of CODE_RULES) {
    const i = test(re);
    if (i >= 0) findings.push({ rule: 'code', score, message: `${label} in ${file}:${i + 1}` });
  }
  return findings;
}

/** Risk from the size of a change (big unreviewed diffs are risky). */
export function changeSizeFinding(linesChanged: number): Finding | undefined {
  if (linesChanged > 1000) return { rule: 'change-size', score: 45, message: `very large change (${linesChanged} lines)` };
  if (linesChanged > 400) return { rule: 'change-size', score: 25, message: `large change (${linesChanged} lines)` };
  return undefined;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => (seen.has(f.message) ? false : (seen.add(f.message), true)));
}
