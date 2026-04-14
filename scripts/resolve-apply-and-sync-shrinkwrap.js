const fs = require("fs");

const registry = process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org";
const maxAgeDays = Number(process.env.MAX_PACKAGE_AGE_DAYS || "14");
const packageJsonFile = process.env.PACKAGE_JSON_FILE || "package.json";
const outFile = process.env.RESOLUTION_FILE || "logs/npm-guard-resolution.json";
const auditFile = process.env.AUDIT_LOG_FILE || "logs/npm-guard-audit.log";
const whitelistFile = process.env.WHITELIST_FILE || "";

// If true, never fallback below the minimum base in ^/~ specs.
// Default false => allow fallback (your desired behavior).
const strictSemver = String(process.env.STRICT_SEMVER || "false").toLowerCase() === "true";

function appendAudit(line) {
  fs.mkdirSync("logs", { recursive: true });
  fs.appendFileSync(auditFile, line + "\n");
}

function readWhitelist(filePath) {
  const allowList = new Map(); // name -> Set(versions)
  if (!filePath) return allowList;

  if (!fs.existsSync(filePath)) {
    appendAudit(`[WHITELIST] file not found: ${filePath} (treat as empty)`);
    return allowList;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);

    // Supported formats:
    // 1) { "allow_list": { "pkg": ["1.0.0"] } }
    // 2) { "allow": ["pkgA", "pkgB"] }  (legacy: allow all versions for those names)
    // 3) ["pkgA", "pkgB"]               (legacy)
    if (json && typeof json === "object" && json.allow_list && typeof json.allow_list === "object") {
      for (const [name, versions] of Object.entries(json.allow_list)) {
        const set = new Set(Array.isArray(versions) ? versions.map(String) : []);
        allowList.set(String(name), set);
      }
      appendAudit(`[WHITELIST] loaded allow_list entries=${allowList.size} from ${filePath}`);
      return allowList;
    }

    // Legacy name-only allowlist: allow all versions
    const legacyArr = Array.isArray(json) ? json : Array.isArray(json.allow) ? json.allow : [];
    for (const name of legacyArr.map(String)) {
      allowList.set(name, new Set(["*"]));
    }
    appendAudit(`[WHITELIST] loaded legacy allow entries=${allowList.size} from ${filePath}`);
    return allowList;
  } catch (e) {
    appendAudit(`[WHITELIST] failed to parse ${filePath}: ${String(e?.message || e)} (treat as empty)`);
    return new Map();
  }
}

function isExactVersion(spec) {
  return /^\d+\.\d+\.\d+$/.test(String(spec).trim());
}

function isAllowedByWhitelist(allowList, name, requestedSpec) {
  const set = allowList.get(name);
  if (!set) return false;

  if (set.has("*")) return true;

  if (!isExactVersion(requestedSpec)) return false;
  return set.has(String(requestedSpec).trim());
}

function daysBetween(a, b) {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${url}`);
  return res.json();
}

// Supports only: exact x.y.z, ^x.y.z, ~x.y.z
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

function allowedBySpecStrict(version, spec) {
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

function allowedBySpecFallback(version, spec) {
  const s = String(spec).trim();

  if (/^\d+\.\d+\.\d+$/.test(s)) return version === s;

  const base = minBaseFromSpec(s);
  if (!base) return false;

  if (s.startsWith("^")) {
    // fallback: same major only (ignore >= base)
    return sameMajor(version, base);
  }

  if (s.startsWith("~")) {
    // fallback: same major.minor only (ignore >= base)
    return sameMajorMinor(version, base);
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

  function pickCandidates(allowedFn) {
    return versions
      .filter((v) => allowedFn(v, spec))
      .filter((v) => times[v])
      .map((v) => ({ v, t: new Date(times[v]) }))
      .filter((x) => x.t <= cutoff)
      .sort((a, b) => cmpVer(a.v, b.v));
  }

  // 1) strict
  let candidates = pickCandidates(allowedBySpecStrict);

  // 2) fallback (only for ^/~, and only when not strictSemver)
  const s = String(spec).trim();
  const canFallback = !strictSemver && (/^[\^~]\d+\.\d+\.\d+$/.test(s));
  if (candidates.length === 0 && canFallback) {
    candidates = pickCandidates(allowedBySpecFallback);
    if (candidates.length > 0) {
      appendAudit(`[FALLBACK] ${pkgName}@${spec} -> using older version within ${s[0] === "^" ? "major" : "major.minor"} due to age gate`);
    }
  }

  if (candidates.length === 0) {
    return {
      requested: String(spec),
      safe: null,
      reason: `no version satisfies age>=${maxAgeDays}d under ${canFallback ? "strict+fallback" : "strict"} rules`,
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

function applySafeVersionsToPkg(pkg, resolution, allowList) {
  function applySection(sectionName) {
    if (!pkg[sectionName]) return;
    for (const [name, spec] of Object.entries(pkg[sectionName])) {
      if (isAllowedByWhitelist(allowList, name, spec)) {
        appendAudit(`[WHITELIST] ${sectionName}.${name}: allowed spec ${spec} -> keep`);
        continue;
      }
      const r = resolution.packages?.[name];
      if (!r || !r.safe) continue;
      pkg[sectionName][name] = r.safe; // pin exact
      appendAudit(`[APPLY] ${sectionName}.${name}: ${spec} -> ${r.safe}`);
    }
  }
  applySection("dependencies");
  applySection("devDependencies");
}

function updateShrinkwrapIfPresent(allowList, pkgJson) {
  const shrinkwrapPath = "npm-shrinkwrap.json";
  if (!fs.existsSync(shrinkwrapPath)) return false;

  const sw = JSON.parse(fs.readFileSync(shrinkwrapPath, "utf8"));
  const pkgs = sw.packages || {};

  const pinned = new Set();
  for (const sectionName of ["dependencies", "devDependencies"]) {
    const section = pkgJson[sectionName] || {};
    for (const [name, spec] of Object.entries(section)) {
      if (!isAllowedByWhitelist(allowList, name, spec) && isExactVersion(spec)) pinned.add(name);
    }
  }

  for (const name of pinned) {
    const safe = pkgJson.dependencies?.[name] || pkgJson.devDependencies?.[name];
    if (!safe) continue;

    const key = `node_modules/${name}`;
    if (pkgs[key] && pkgs[key].version && pkgs[key].version !== safe) {
      appendAudit(`[SHRINKWRAP] ${name}: ${pkgs[key].version} -> ${safe}`);
      pkgs[key].version = safe;
      delete pkgs[key].resolved;
      delete pkgs[key].integrity;
    }
  }

  sw.packages = pkgs;
  fs.writeFileSync(shrinkwrapPath, JSON.stringify(sw, null, 2) + "\n");
  appendAudit("Updated existing npm-shrinkwrap.json (top-level packages pinned; resolved/integrity cleared for refresh).");
  return true;
}

async function main() {
  console.log("[npm-guard] script start");
  console.log("[npm-guard] node:", process.version);
  console.log("[npm-guard] cwd:", process.cwd());
  console.log("[npm-guard] registry:", registry);
  console.log("[npm-guard] maxAgeDays:", maxAgeDays);
  console.log("[npm-guard] packageJsonFile:", packageJsonFile);
  console.log("[npm-guard] whitelistFile:", whitelistFile);
  console.log("[npm-guard] strictSemver:", strictSemver);

  fs.mkdirSync("logs", { recursive: true });
  appendAudit("========== NPM Guard Resolve+Apply+Shrinkwrap (version allow_list + fallback) ==========");

  const allowList = readWhitelist(whitelistFile);

  const pkg = JSON.parse(fs.readFileSync(packageJsonFile, "utf8"));
  console.log("[npm-guard] loaded package.json");

  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});

  const resolution = {
    maxAgeDays,
    registry,
    generatedAt: new Date().toISOString(),
    packages: {},
  };

  for (const [name, spec] of Object.entries(deps)) {
    if (isAllowedByWhitelist(allowList, name, spec)) {
      resolution.packages[name] = { requested: String(spec), safe: null, reason: "allow_list" };
      appendAudit(`[WHITELIST] allowed ${name}@${spec} -> skip resolving`);
      continue;
    }

    try {
      const r = await resolveOne(name, spec);
      resolution.packages[name] = r;

      if (r.safe) {
        appendAudit(`[SAFE] ${name}@${spec} -> ${r.safe} (ageDays=${r.ageDays})`);
      } else {
        appendAudit(`[UNRESOLVED] ${name}@${spec} -> (no safe version) reason=${r.reason}`);
      }
    } catch (e) {
      resolution.packages[name] = { requested: String(spec), safe: null, reason: String(e?.message || e) };
      appendAudit(`[ERROR] ${name}@${spec} -> ${resolution.packages[name].reason}`);
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(resolution, null, 2));
  console.log("[npm-guard] wrote resolution:", outFile);
  appendAudit(`Wrote resolution: ${outFile}`);

  applySafeVersionsToPkg(pkg, resolution, allowList);
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log("[npm-guard] wrote updated package.json");
  appendAudit("Updated package.json with safe versions (runner only).");

  if (fs.existsSync("npm-shrinkwrap.json")) {
    updateShrinkwrapIfPresent(allowList, pkg);
  } else {
    appendAudit("No npm-shrinkwrap.json found: action will generate one after npm install (npm shrinkwrap).");
  }
}

main().catch((err) => {
  console.error("[npm-guard] fatal:", err);
  appendAudit(`[FATAL] ${String(err?.message || err)}`);
  process.exit(1);
});
