#!/bin/bash
# 太原攻略地图 + 微信网关 - CloudBase 部署脚本
# 用法: bash deploy.sh           (全部部署)
#       bash deploy.sh hosting   (仅静态托管)
#       bash deploy.sh function  (仅云函数)

set -e

TARGET="${1:-all}"

if [ "$TARGET" = "all" ] || [ "$TARGET" = "hosting" ]; then
  echo "=== 静态托管部署 ==="
  rm -rf .deploy
  mkdir -p .deploy

  cp index.html manifest.json sw.js .deploy/

  if [ -d "images" ]; then
    cp -r images .deploy/
  fi

  PATH="/d/Node.js:$PATH" tcb hosting deploy .deploy -e travel-d6gc9rtii6d0f6a87

  rm -rf .deploy
  echo "静态托管部署完成"
  echo ""
fi

if [ "$TARGET" = "all" ] || [ "$TARGET" = "function" ]; then
  echo "=== 云函数部署 ==="
  cd cloudfunctions/wechat-gateway
  PATH="/d/Node.js:$PATH" npm install --omit=dev 2>/dev/null
  cd ../..
  PATH="/d/Node.js:$PATH" tcb fn deploy wechat-gateway --dir cloudfunctions/wechat-gateway --force
  echo "云函数部署完成"
  echo ""
fi

echo "=== 部署完成 ==="
echo "静态托管: https://travel-d6gc9rtii6d0f6a87-1439099044.tcloudbaseapp.com"
echo ""
echo "微信公众号 - 开发者配置:"
echo "  URL:   https://travel-d6gc9rtii6d0f6a87-1439099044.ap-shanghai.app.tcloudbase.com/wechat"
echo "  Token: travel_planner_2026"
