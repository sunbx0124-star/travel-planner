/**
 * 记账解析器 —— 从文本中提取消费记录并自动分类
 */
const { classifyItem } = require("./categoryConfig");

const AMOUNT_RE = /([：:]?\s*)(\d+\.?\d*)\s*元/;

function parseExpenses(text) {
  // 保护 "物品名，金额元" 格式中的逗号不被当成分隔符
  text = text.replace(/[，,]\s*(\d+\.?\d*\s*元)/g, ":::$1");

  const entries = text.split(/[，,、\n;；]/);
  const results = [];

  for (let entry of entries) {
    entry = entry.replace(":::", "，").trim();
    if (!entry) continue;

    const match = entry.match(AMOUNT_RE);
    if (!match) {
      console.log(`  [跳过] 无法识别金额: ${entry}`);
      continue;
    }

    const amount = parseFloat(match[2]);
    let item = entry.substring(0, match.index).trim();
    item = item.replace(/[：:]\s*$/, "");
    item = item.replace(/[，,]\s*$/, "");

    if (!item) {
      console.log(`  [跳过] 物品名为空: ${entry}`);
      continue;
    }

    const category = classifyItem(item);
    results.push({ item, amount, category });
  }

  return results;
}

module.exports = { parseExpenses };
