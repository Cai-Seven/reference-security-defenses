const fs = require("fs");

const registry = process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org";
const maxAgeDays = Number(process.env.MAX_PACKAGE_AGE_DAYS || "14");
const packageJsonFile = process.env.PACKAGE_JSON_FILE || "package.json";
const outFile = process.env.RESOLUTION_FILE || "logs/npm-guard-resolution.json";
const auditFile = process.env.AUDIT_LOG_FILE || "logs/npm-guard-audit.log";

function daysBetween(a, b) {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

/**
 * Supports only:
 * - exact "x.y.z"
 * - caret "^x.y.z"
 * - tilde "~x.y.z"
 *
 * If you need >=, ranges, tags, etc., extend allowedBySpec().
 */
function minBaseFromSpec(spec) {
  const s = String(spec).trim();
  if (/^\d+\.\d+\.\d+$/.test(s)) return s;
  if (/^[\^~]\d+\.\d+\.\d+$/.test(s)) return s.slice(1);
  return null;
}

function cmpVer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function sameMajor(a, b) {
  return a.split(".")[0] === b.split(".")[0];
}
function sameMajorMinor(a, b) {
  const aa = a.split(".");
  const bb = b.split(".");
  return aa[0] === bb[0] && aa[1] === bb[1];
}

function allowedBySpec(version, spec) {
  const s = String(spec).trim();

  if (/^\d+\.\d+\.\d+$/.test(s)) return version === s;

  const base = minBaseFromSpec(s);
  if (!base) return false;

  if (s.startsWith("^")) {
    // ^x.y.z => same major and >= base
    if (!sameMajor(version, base)) return false;
    return cmpVer(version, base) >= 0;
  }

  if (s.startsWith("~")) {
    // ~x.y.z => same major.minor and >= base
    if (!sameMajorMinor(version, base)) return false;
    return cmpVer(version, base) >= 0;
  }

  return false;
}

async function resolveOne(pkgName, spec) {
  const encoded = pkgName.startsWith("@") ? pkgName.replace("/", "%2F") : pkgName;
  const meta = await fetchJson(`${registry}/${encoded}`);
  const times = meta.time || {};
  const versions = Object.keys(meta.versions || {});

  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 3600 * 1000);

  const candidates = versions
    .filter((v) => allowedBySpec(v, spec))
    .filter((v) => times[v])
    .map((v) => ({ v, t: new Date(times[v]) }))
    .filter((x) => x.t <= cutoff)
    .sort((a, b) => cmpVer(a.v, b.v));

  if (candidates.length === 0) {
    return {
      requested: String(spec),
      safe: null,
      reason: `no version satisfies spec+age>=${maxAgeDays}d`,
    };
  }

  const chosen = candidates[candidates.length - 1];
  const age = daysBetween(now, chosen.t);

  return {
    requested: String(spec),
    safe: chosen.v,
    publishTime: chosen.t.toISOString(),
    ageDays: Number(age.toFixed(2)),
  };
}

function applySafeVersionsToPkg(pkg, resolution) {
  function applySection(sectionName) {
    if (!pkg[sectionName]) return;
    for (const [name, spec] of Object.entries(pkg[sectionName])) {
      const r = resolution.packages?.[name];
      if (!r || !r.safe) continue;

      pkg[sectionName][name] = r.safe; // exact pin (runner only)
      console.log(`[APPLY] ${sectionName}.${name}: ${spec} -> ${r.safe}`);
    }
  }

  applySection("dependencies");
  applySection("devDependencies");
}

function appendAudit(line) {
  fs.mkdirSync("logs", { recursive: true });
  fs.appendFileSync(auditFile, line + "\n");
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(packageJsonFile, "utf8"));
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

  const resolution = {
    maxAgeDays,
    registry,
    generatedAt: new Date().toISOString(),
    packages: {},
  };

  appendAudit("========== NPM Guard Auto-Resolve Report ==========");

  for (const [name, spec] of Object.entries(deps)) {
    try {
      const r = await resolveOne(name, spec);
      resolution.packages[name] = r;

      if (r.safe) {
        const msg = `[SAFE] ${name}@${spec} -> ${r.safe} (ageDays=${r.ageDays})`;
        console.log(msg);
        appendAudit(msg);
      } else {
        const msg = `[UNRESOLVED] ${name}@${spec} -> (no safe version) reason=${r.reason}`;
        console.log(msg);
        appendAudit(msg);
      }
    } catch (e) {
      const msg = `[ERROR] ${name}@${spec} -> ${String(e?.message || e)}`;
      resolution.packages[name] = { requested: String(spec), safe: null, reason: msg };
      console.log(msg);
      appendAudit(msg);
    }
  }

  fs.mkdirSync("logs", { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(resolution, null, 2));
  console.log(`Wrote resolution: ${outFile}`);
  appendAudit(`Wrote resolution: ${outFile}`);

  applySafeVersionsToPkg(pkg, resolution);
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  appendAudit("Updated package.json with safe versions (runner only).");
  console.log("Updated package.json with safe versions (runner only).");
}

main().catch((err) => {
  console.error(err);
  appendAudit(`[FATAL] ${String(err?.message || err)}`);
  process.exit(1);
});
