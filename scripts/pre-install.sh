#!/bin/bash

###############################################################################
# NPM Install 前置拦截脚本
# 在执行 npm install 前运行包安全验证
#
# 使用方式：
#   ./scripts/pre-install.sh
#   或在 package.json 中配置：
#   "scripts": {
#     "preinstall": "./scripts/pre-install.sh"
#   }
###############################################################################

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========== NPM Security Pre-Install Check ==========${NC}\n"

# 检查 Node.js 版本
NODE_VERSION=$(node -v)
echo -e "${BLUE}ℹ Node.js 版本: ${NODE_VERSION}${NC}"

# 检查必要文件
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ 错误: package.json 不存在${NC}"
    exit 1
fi

if [ ! -f "scripts/npm-install-interceptor.js" ]; then
    echo -e "${RED}❌ 错误: npm-install-interceptor.js 不存在${NC}"
    exit 1
fi

# 设置环境变量
export NPM_REGISTRY_URL="${NPM_REGISTRY_URL:-https://registry.npmjs.org}"
export MAX_PACKAGE_AGE_DAYS="${MAX_PACKAGE_AGE_DAYS:-14}"
export WHITELIST_FILE="${WHITELIST_FILE:-./config/package-whitelist.json}"
export RULES_CONFIG_FILE="${RULES_CONFIG_FILE:-./config/rules.config.json}"
export AUDIT_LOG_FILE="${AUDIT_LOG_FILE:-./logs/npm-install-audit.log}"
export CACHE_DIR="${CACHE_DIR:-./.npm-security-cache}"

# 输出配置
echo -e "${BLUE}配置信息:${NC}"
echo -e "  Registry: ${NPM_REGISTRY_URL}"
echo -e "  Max Age: ${MAX_PACKAGE_AGE_DAYS} 天"
echo -e "  Whitelist: ${WHITELIST_FILE}"
echo -e "  Rules: ${RULES_CONFIG_FILE}\n"

# 运行验证
echo -e "${BLUE}运行安全检查...${NC}\n"

if node scripts/npm-install-interceptor.js; then
    echo -e "\n${GREEN}✓ 安全检查通过${NC}"
    exit 0
else
    echo -e "\n${RED}✗ 安全检查失败${NC}"
    exit 1
fi
