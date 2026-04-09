#!/usr/bin/env node

/**
 * NPM Install 供应链安全拦截器
 * 在 npm install 执行前验证包的年龄和白名单状态
 * 
 * 使用方式：
 *   node npm-install-interceptor.js
 * 
 * 环境变量：
 *   NPM_REGISTRY_URL: npm 源地址 (默认: https://registry.npmjs.org)
 *   MAX_PACKAGE_AGE_DAYS: 最大包年龄(天) (默认: 14)
 *   WHITELIST_FILE: 白名单文件路径
 *   RULES_CONFIG_FILE: 规则配置文件路径
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// ============ 配置 ============
const config = {
  registryUrl: process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org',
  maxPackageAgeDays: parseInt(process.env.MAX_PACKAGE_AGE_DAYS) || 14,
  whitelistFile: process.env.WHITELIST_FILE || './config/package-whitelist.json',
  rulesConfigFile: process.env.RULES_CONFIG_FILE || './config/rules.config.json',
  lockFile: process.env.LOCK_FILE || 'package-lock.json',
  packageJsonFile: process.env.PACKAGE_JSON_FILE || 'package.json',
  auditLogFile: process.env.AUDIT_LOG_FILE || './logs/npm-install-audit.log',
  cacheDir: process.env.CACHE_DIR || './.npm-security-cache',
  cacheTTL: parseInt(process.env.CACHE_TTL) || 3600 * 24, // 24小时
};

// ============ 日志系统 ============
class Logger {
  constructor(logFile) {
    this.logFile = logFile;
    this.ensureLogDir();
  }

  ensureLogDir() {
    const dir = path.dirname(this.logFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...data,
    };
    const logLine = JSON.stringify(logEntry);
    console.log(`[${level}] ${message}`, data);
    fs.appendFileSync(this.logFile, logLine + '\n');
  }

  info(msg, data) { this.log('INFO', msg, data); }
  warn(msg, data) { this.log('WARN', msg, data); }
  error(msg, data) { this.log('ERROR', msg, data); }
}

const logger = new Logger(config.auditLogFile);

// ============ 缓存系统 ============
class PackageMetadataCache {
  constructor(cacheDir, ttl) {
    this.cacheDir = cacheDir;
    this.ttl = ttl;
    this.ensureCacheDir();
  }

  ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  getCacheFile(packageName) {
    const hash = Buffer.from(packageName).toString('base64').replace(/[/+=]/g, '_');
    return path.join(this.cacheDir, `${hash}.json`);
  }

  get(packageName) {
    const cacheFile = this.getCacheFile(packageName);
    if (!fs.existsSync(cacheFile)) {
      return null;
    }

    const stat = fs.statSync(cacheFile);
    const ageSeconds = (Date.now() - stat.mtimeMs) / 1000;
    
    if (ageSeconds > this.ttl) {
      fs.unlinkSync(cacheFile);
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    } catch (e) {
      logger.warn('缓存读取失败', { packageName, error: e.message });
      return null;
    }
  }

  set(packageName, data) {
    const cacheFile = this.getCacheFile(packageName);
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
  }
}

const cache = new PackageMetadataCache(config.cacheDir, config.cacheTTL);

// ============ 配置加载 ============
function loadConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    logger.warn(`配置文件不存在: ${filePath}`);
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    logger.error(`配置文件解析失败: ${filePath}`, { error: e.message });
    return {};
  }
}

const whitelist = loadConfig(config.whitelistFile);
const rulesConfig = loadConfig(config.rulesConfigFile);

// ============ NPM 元数据获取 ============
function fetchNpmPackageMetadata(packageName) {
  return new Promise((resolve, reject) => {
    const cacheData = cache.get(packageName);
    if (cacheData) {
      logger.info(`从缓存读取: ${packageName}`);
      resolve(cacheData);
      return;
    }

    const encodedName = encodeURIComponent(packageName);
    const url = `${config.registryUrl}/${encodedName}`;

    https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const metadata = JSON.parse(data);
          cache.set(packageName, metadata);
          resolve(metadata);
        } catch (e) {
          reject(new Error(`NPM 元数据解析失败: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ============ 版本号解析 ============
class VersionParser {
  /**
   * 解析语义化版本范围，返回具体版本号
   * 支持: ^1.2.3, ~1.2.3, >=1.2.3, 1.2.3, latest, next等
   */
  static parseVersionRange(versionSpec, allVersions) {
    if (!allVersions || allVersions.length === 0) {
      return null;
    }

    const versions = allVersions
      .filter(v => this.isValidVersion(v))
      .sort((a, b) => this.compareVersions(b, a)); // 降序

    if (versionSpec === 'latest' || versionSpec === '*') {
      return versions[0];
    }

    if (versionSpec === 'next') {
      return versions.find(v => v.includes('-')) || versions[0];
    }

    // 处理精确版本
    if (/^\d+\.\d+\.\d+/.test(versionSpec)) {
      const exactMatch = versions.find(v => v.startsWith(versionSpec.split(/[~^><=]/).join('')));
      if (exactMatch) return exactMatch;
    }

    // 处理 ^ 版本（兼容小版本）
    if (versionSpec.startsWith('^')) {
      const base = versionSpec.substring(1);
      const [major] = base.split('.');
      return versions.find(v => {
        const vMajor = v.split('.')[0];
        return vMajor === major && this.compareVersions(v, base) >= 0;
      });
    }

    // 处理 ~ 版本（兼容补丁版本）
    if (versionSpec.startsWith('~')) {
      const base = versionSpec.substring(1);
      const [major, minor] = base.split('.');
      return versions.find(v => {
        const [vMajor, vMinor] = v.split('.');
        return vMajor === major && vMinor === minor && this.compareVersions(v, base) >= 0;
      });
    }

    // 处理 >= 版本
    if (versionSpec.startsWith('>=')) {
      const base = versionSpec.substring(2);
      return versions.find(v => this.compareVersions(v, base) >= 0);
    }

    return versions[0];
  }

  static isValidVersion(version) {
    // 移除 v 前缀并验证语义化版本格式
    const cleaned = version.replace(/^v/, '');
    return /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(cleaned);
  }

  static compareVersions(v1, v2) {
    const p1 = v1.replace(/^v/, '').split(/[.-]/);
    const p2 = v2.replace(/^v/, '').split(/[.-]/);
    
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const part1 = parseInt(p1[i]) || 0;
      const part2 = parseInt(p2[i]) || 0;
      if (part1 !== part2) {
        return part1 > part2 ? 1 : -1;
      }
    }
    return 0;
  }
}

// ============ 包年龄验证 ============
async function validatePackageAge(packageName, version, metadata) {
  try {
    const publishTime = metadata.time && metadata.time[version];
    if (!publishTime) {
      logger.warn(`无法获取发布时间: ${packageName}@${version}`);
      return { valid: false, reason: '发布时间未找到' };
    }

    const publishDate = new Date(publishTime);
    const nowDate = new Date();
    const ageMs = nowDate - publishDate;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    const maxAge = rulesConfig.maxPackageAgeDays || config.maxPackageAgeDays;

    logger.info(`包年龄检查: ${packageName}@${version}`, {
      publishTime,
      ageDays: ageDays.toFixed(2),
      maxAge,
    });

    if (ageDays < maxAge) {
      return {
        valid: false,
        reason: `包发布时间不满足要求: ${ageDays.toFixed(2)} 天 < ${maxAge} 天`,
        ageDays: ageDays.toFixed(2),
      };
    }

    return { valid: true };
  } catch (e) {
    logger.error(`年龄验证异常: ${packageName}@${version}`, { error: e.message });
    return { valid: false, reason: `验证异常: ${e.message}` };
  }
}

// ============ 白名单检查 ============
function checkWhitelist(packageName, version) {
  // 特殊处理 @scope 包
  const normalizedName = packageName.startsWith('@') 
    ? packageName 
    : packageName;

  // 检查精确版本白名单
  if (whitelist.approvedVersions && whitelist.approvedVersions[normalizedName]) {
    const approvedVersions = whitelist.approvedVersions[normalizedName];
    if (approvedVersions.includes(version) || approvedVersions.includes('*')) {
      logger.info(`包在版本白名单中: ${packageName}@${version}`);
      return { approved: true, reason: '版本白名单' };
    }
  }

  // 检查全局白名单
  if (whitelist.globalApprovedPackages && whitelist.globalApprovedPackages.includes(normalizedName)) {
    logger.info(`包在全局白名单中: ${packageName}`);
    return { approved: true, reason: '全局白名单' };
  }

  return { approved: false };
}

// ============ 主验证流程 ============
async function validatePackage(packageName, versionSpec) {
  try {
    logger.info(`开始验证包`, { packageName, versionSpec });

    // 步骤1: 检查白名单
    const whitelistCheck = checkWhitelist(packageName, versionSpec);
    if (whitelistCheck.approved) {
      logger.info(`✓ 包通过白名单检查: ${packageName}`, { reason: whitelistCheck.reason });
      return { valid: true, reason: '白名单通过' };
    }

    // 步骤2: 获取NPM元数据
    logger.info(`获取NPM元数据: ${packageName}`);
    const metadata = await fetchNpmPackageMetadata(packageName);

    if (!metadata.versions) {
      logger.error(`无法获取包版本信息: ${packageName}`);
      return { valid: false, reason: '无法获取包版本信息' };
    }

    // 步骤3: 解析具体版本号
    const allVersions = Object.keys(metadata.versions);
    const resolvedVersion = VersionParser.parseVersionRange(versionSpec, allVersions);

    if (!resolvedVersion) {
      logger.error(`无法解析版本: ${packageName}@${versionSpec}`, { availableVersions: allVersions });
      return { valid: false, reason: `无法解析版本: ${versionSpec}` };
    }

    logger.info(`版本解析结果: ${packageName}@${versionSpec} => ${resolvedVersion}`);

    // 步骤4: 验证包年龄
    const ageValidation = await validatePackageAge(packageName, resolvedVersion, metadata);
    if (!ageValidation.valid) {
      logger.error(`✗ 包年龄不满足要求: ${packageName}@${resolvedVersion}`, ageValidation);
      return ageValidation;
    }

    logger.info(`✓ 包通过年龄验证: ${packageName}@${resolvedVersion}`);
    return { valid: true, resolvedVersion };
  } catch (error) {
    logger.error(`包验证异常: ${packageName}`, { error: error.message });
    return { valid: false, reason: `验证异常: ${error.message}` };
  }
}

// ============ 解析 package.json ============
function parsePackageJson(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json 不存在: ${packageJsonPath}`);
  }

  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    throw new Error(`package.json 解析失败: ${e.message}`);
  }
}

// ============ 提取所有依赖 ============
function extractAllDependencies(packageJson) {
  const deps = {};
  
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  
  for (const section of sections) {
    if (packageJson[section]) {
      Object.assign(deps, packageJson[section]);
    }
  }

  return deps;
}

// ============ 主入口 ============
async function main() {
  try {
    logger.info('NPM 供应链安全拦截器启动');
    console.log('\n========== NPM Install 安全检查 ==========\n');

    // 检查必要文件
    if (!fs.existsSync(config.packageJsonFile)) {
      logger.error(`package.json 不存在`);
      console.error('❌ 错误: 无法找到 package.json');
      process.exit(1);
    }

    // 解析 package.json
    const packageJson = parsePackageJson(config.packageJsonFile);
    const dependencies = extractAllDependencies(packageJson);

    if (Object.keys(dependencies).length === 0) {
      logger.info('无依赖包需要验证');
      console.log('✓ 无依赖包需要验证\n');
      process.exit(0);
    }

    console.log(`📦 检测到 ${Object.keys(dependencies).length} 个依赖包\n`);

    // 验证所有依赖
    const results = [];
    let failedCount = 0;

    for (const [packageName, versionSpec] of Object.entries(dependencies)) {
      const result = await validatePackage(packageName, versionSpec);
      results.push({ packageName, versionSpec, ...result });

      if (result.valid) {
        console.log(`✓ ${packageName}@${versionSpec}`);
      } else {
        console.log(`✗ ${packageName}@${versionSpec}`);
        console.log(`  原因: ${result.reason}\n`);
        failedCount++;
      }
    }

    // 生成报告
    console.log('\n========== 检查报告 ==========\n');
    console.log(`总计: ${results.length} 个包`);
    console.log(`通过: ${results.length - failedCount} 个`);
    console.log(`失败: ${failedCount} 个\n`);

    logger.info('检查完成', {
      total: results.length,
      passed: results.length - failedCount,
      failed: failedCount,
    });

    if (failedCount > 0) {
      console.error('❌ 存在不满足安全要求的包，npm install 已被阻止\n');
      logger.error('NPM install 被阻止', { failedCount });
      process.exit(1);
    }

    console.log('✓ 所有包均满足安全要求，可以继续 npm install\n');
    process.exit(0);
  } catch (error) {
    console.error('❌ 致命错误:', error.message);
    logger.error('致命错误', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

main();
