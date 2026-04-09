#!/usr/bin/env node

/**
 * 版本号范围解析和验证工具
 * 用于测试和调试版本解析逻辑
 */

const fs = require('fs');

class SemanticVersionParser {
  /**
   * 比较两个版本号
   * @returns -1 (v1 < v2), 0 (v1 == v2), 1 (v1 > v2)
   */
  static compareVersions(v1, v2) {
    const normalize = (v) => v.replace(/^v/, '').split(/[.-]/);
    const parts1 = normalize(v1);
    const parts2 = normalize(v2);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const n1 = parseInt(parts1[i]) || 0;
      const n2 = parseInt(parts2[i]) || 0;
      if (n1 < n2) return -1;
      if (n1 > n2) return 1;
    }
    return 0;
  }

  /**
   * 从版本数组中选择符合条件的最高版本
   */
  static resolveVersion(versionSpec, availableVersions) {
    const validVersions = availableVersions
      .filter(v => /^\d+\.\d+\.\d+/.test(v.replace(/^v/, '')))
      .sort((a, b) => this.compareVersions(b, a));

    if (versionSpec === 'latest' || versionSpec === '*') {
      return validVersions[0];
    }

    if (versionSpec === 'next') {
      return validVersions.find(v => v.includes('-')) || validVersions[0];
    }

    // 精确版本
    if (/^\d+\.\d+\.\d+/.test(versionSpec)) {
      return validVersions.find(v => 
        v.replace(/^v/, '').startsWith(versionSpec)
      );
    }

    // ^ - 允许改变小版本和补丁版本
    if (versionSpec.startsWith('^')) {
      const base = versionSpec.substring(1).replace(/^v/, '');
      const baseMajor = base.split('.')[0];
      return validVersions.find(v => {
        const vClean = v.replace(/^v/, '');
        const vMajor = vClean.split('.')[0];
        return vMajor === baseMajor && this.compareVersions(vClean, base) >= 0;
      });
    }

    // ~ - 允许改变补丁版本
    if (versionSpec.startsWith('~')) {
      const base = versionSpec.substring(1).replace(/^v/, '');
      const [baseMajor, baseMinor] = base.split('.');
      return validVersions.find(v => {
        const vClean = v.replace(/^v/, '');
        const [vMajor, vMinor] = vClean.split('.');
        return vMajor === baseMajor && 
               vMinor === baseMinor && 
               this.compareVersions(vClean, base) >= 0;
      });
    }

    // >= 版本号
    if (versionSpec.startsWith('>=')) {
      const base = versionSpec.substring(2).replace(/^v/, '');
      return validVersions.find(v => 
        this.compareVersions(v.replace(/^v/, ''), base) >= 0
      );
    }

    return validVersions[0];
  }
}

// 测试用例
const testCases = [
  {
    spec: '^1.2.3',
    available: ['1.2.3', '1.3.0', '1.5.2', '2.0.0', '2.1.0'],
    expected: '1.5.2',
  },
  {
    spec: '~2.1.0',
    available: ['2.1.0', '2.1.5', '2.2.0', '3.0.0'],
    expected: '2.1.5',
  },
  {
    spec: '>=1.0.0',
    available: ['0.9.0', '1.0.0', '1.2.0', '2.0.0'],
    expected: '2.0.0',
  },
  {
    spec: 'latest',
    available: ['1.0.0', '1.5.0', '2.0.0'],
    expected: '2.0.0',
  },
];

console.log('版本解析测试:\n');

testCases.forEach(({ spec, available, expected }) => {
  const resolved = SemanticVersionParser.resolveVersion(spec, available);
  const passed = resolved === expected;
  const status = passed ? '✓' : '✗';
  console.log(`${status} ${spec}`);
  console.log(`  可用版本: ${available.join(', ')}`);
  console.log(`  解析结果: ${resolved}`);
  console.log(`  期望结果: ${expected}`);
  console.log();
});
