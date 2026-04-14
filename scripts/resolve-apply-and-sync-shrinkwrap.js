const fs = require("fs");

const configPath = process.env.NPM_GUARD_CONFIG_FILE || ".guard/config/npm-guard.config.json";
const packageJsonFile = process.env.PACKAGE_JSON_FILE || "package.json";
const outFile = process.env.RESOLUTION_FILE || "logs/npm-guard-resolution.json";
const auditFile = process.env.AUDIT_LOG_FILE || "logs/npm-guard-audit.log";

function appendAudit(line) {
  fs.mkdirSync("logs", { recursive: true });
  fs.appendFileSync(auditFile, line + "\n");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isExactVersion(spec) {
  return /^\d+\.\d+\.\d+$/.test(String(spec).trim());
}

function isStableSemver(v) {
  // Stable release: no pre-release suffix (e.g. "-canary", "-rc", "-beta")
  return /^\d+\.\d+\.\d+$/.test(String(v).trim());
}

function daysBetween(a, b) {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

function minBaseFromSpec(spec) {
  const s = String(spec).trim();
  if (isExactVersion(s)) return s;
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

function allowedBySpecStrict(version, spec) {
  const s = String(spec).trim();

  if (isExactVersion(s)) return version === s;

  const base = minBaseFromSpec(s);
  if (!base) return false;

  if (s.startsWith("^")) {
    if (!sameMajor(version, base)) return false;
    return cmpVer(version, base) >= 0;
  }

  if (s.startsWith("~")) {
    if (!sameMajorMinor(version, base)) return false;
    return cmpVer(version, base) >= 0;
  }

  return false;
}

function isAllowedByWhitelist(allowList, name, requestedSpec) {
  const set = allowList[name];
  if (!set) return false;

  if (set === "*" || (Array.isArray(set) && set.includes("*"))) return true;

  if (!isExactVersion(requestedSpec)) return false;
  return Array.isArray(set) && set.includes(String(requestedSpec).trim());
}

async function resolveOne(meta, pkgName, spec) {
  const { registryUrl, maxAgeDays, allowCrossMajorFallback, fallbackOnlyStable } = meta;

  const encoded = pkgName.startsWith("@") ? pkgName.replace("/", "%2F") : pkgName;
  const info = await fetchJson(`${registryUrl}/${encoded}`);
  const times = info.time || {};
  const versions = Object.keys(info.versions || {});

  const now = new Date();
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 3600 * 1000);

  function candidatesByFilter(fn) {
    return versions
      .filter((v) => fn(v))
      .filter((v) => times[v])
      .map((v) => ({ v, t: new Date(times[v]) }))
      .filter((x) => x.t <= cutoff)
      .sort((a, b) => cmpVer(a.v, b.v));
  }

  let candidates = candidatesByFilter((v) => allowedBySpecStrict(v, spec));

  if (candidates.length === 0 && allowCrossMajorFallback) {
    candidates = candidatesByFilter((v) => (fallbackOnlyStable ? isStableSemver(v) : true));
  }

  if (candidates.length === 0) {
    return { requested: String(spec), safe: null, reason: `no version satisfies age>=${maxAgeDays}d` };
  }

  const chosen = candidates[candidates.length - 1];
  const age = daysBetween(now, chosen.t);

  return {
    requested: String(spec),
    safe: chosen.v,
    publishTime: chosen.t.toISOString(),
    ageDays: Number(age.toFixed(2)),
    fallback: !allowedBySpecStrict(chosen.v, spec),
  };
}

function applySafeVersionsToPkg(pkg, resolution, allowList) {
  for (const sectionName of ["dependencies", "devDependencies"]) {
    const section = pkg[sectionName];
    if (!section) continue;

    for (const [name, spec] of Object.entries(section)) {
      if (isAllowedByWhitelist(allowList, name, spec)) {
        appendAudit(`[WHITELIST] ${sectionName}.${name}: keep ${spec}`);
        continue;
      }
      const r = resolution.packages?.[name];
      if (!r || !r.safe) continue;
      section[name] = r.safe;
      appendAudit(`[APPLY] ${sectionName}.${name}: ${spec} -> ${r.safe}${r.fallback ? " [FALLBACK]" : ""}`);
    }
  }
}

function updateShrinkwrapIfPresent(pkgJson) {
  const shrinkwrapPath = "npm-shrinkwrap.json";
  if (!fs.existsSync(shrinkwrapPath)) return;

  const sw = readJson(shrinkwrapPath);
  const pkgs = sw.packages || {};

  for (const sectionName of ["dependencies", "devDependencies"]) {
    const section = pkgJson[sectionName] || {};
    for (const [name, spec] of Object.entries(section)) {
      if (!isExactVersion(spec)) continue;

      const key = `node_modules/${name}`;
      if (pkgs[key] && pkgs[key].version && pkgs[key].version !== spec) {
        pkgs[key].version = spec;
        delete pkgs[key].resolved;
        delete pkgs[key].integrity;
        appendAudit(`[SHRINKWRAP] ${name}: -> ${spec}`);
      }
    }
  }

  sw.packages = pkgs;
  fs.writeFileSync(shrinkwrapPath, JSON.stringify(sw, null, 2) + "\n");
}

async function main() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = readJson(configPath);
  const meta = {
    registryUrl: config.registry_url || "https://registry.npmjs.org",
    maxAgeDays: Number(config.max_age_days || 14),
    allowCrossMajorFallback: config.allow_cross_major_fallback !== false,
    fallbackOnlyStable: config.fallback_only_stable !== false,
    allowList: config.allow_list || {},
  };

  fs.mkdirSync("logs", { recursive: true });

  const pkg = readJson(packageJsonFile);
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

  const resolution = {
    maxAgeDays: meta.maxAgeDays,
    registry: meta.registryUrl,
    generatedAt: new Date().toISOString(),
    packages: {},
  };

  for (const [name, spec] of Object.entries(deps)) {
    if (isAllowedByWhitelist(meta.allowList, name, spec)) {
      resolution.packages[name] = { requested: String(spec), safe: null, reason: "allow_list" };
      continue;
    }
    resolution.packages[name] = await resolveOne(meta, name, spec);
  }

  fs.writeFileSync(outFile, JSON.stringify(resolution, null, 2));
  applySafeVersionsToPkg(pkg, resolution, meta.allowList);
  fs.writeFileSync(packageJsonFile, JSON.stringify(pkg, null, 2) + "\n");

  updateShrinkwrapIfPresent(pkg);
}

main().catch((err) => {
  console.error(err);
  appendAudit(`[FATAL] ${String(err?.message || err)}`);
  process.exit(1);
});
