/**
 * 提示词构建（同步接口与异步 worker 共用，避免两处漂移）
 */
const fs = require('fs');
const path = require('path');

const promptTemplate = fs.readFileSync(path.join(__dirname, '..', 'tarot_prompt.md'), 'utf-8');

function spreadTypeOf(cards) {
  if (cards.length === 1) return 'single';
  if (cards.length === 3) return 'three';
  if (cards.length === 10) return 'celtic';
  return 'single';
}

function buildPrompt(question, cards) {
  const cardsInfo = cards.map((c) => {
    const name = c.nameZh || c.name;
    const dir = c.reversed ? '（逆位）' : '（正位）';
    return name + dir;
  }).join('、');

  const count = cards.length;
  let positionHint = '';
  if (count === 1) {
    positionHint = `牌阵：[单牌启示]；牌面：[${cardsInfo}]`;
  } else if (count === 3) {
    positionHint = `牌阵：[三张牌时间流（过去-现在-未来）]；牌面：[${cardsInfo}]`;
  } else if (count === 10) {
    positionHint = `牌阵：[凯尔特十字大牌阵]；牌面：[${cardsInfo}]`;
  }

  const userMessage = `问卜者的问题：${question}\n\n${positionHint}`;
  return [
    { role: 'system', content: promptTemplate },
    { role: 'user', content: userMessage },
  ];
}

module.exports = { buildPrompt, spreadTypeOf };
