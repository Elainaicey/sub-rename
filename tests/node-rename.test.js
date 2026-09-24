const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
  path.join(__dirname, "..", "NodeRename.js"),
  "utf8"
);

function evaluate(expression) {
  return vm.runInNewContext(`${script}\n${expression}`);
}

test("suffix 模式在长原名下仍保留完整出口标签", () => {
  const name = evaluate(
    'applyMode("很长的机场节点名称".repeat(8), "🇺🇸|Cloud|AMAZON|数据中心|原生", "suffix", 45)'
  );
  assert.ok(name.length <= 45);
  assert.ok(name.endsWith("🇺🇸|Cloud|AMAZON|数据中心|原生"));
});

test("suffix 重复执行不会重复追加出口标签", () => {
  const name = evaluate(
    'applyMode("旧名 🇺🇸|Cloud|AMAZON", "🇺🇸|Cloud|AMAZON", "suffix", 40)'
  );
  assert.equal(name, "旧名 🇺🇸|Cloud|AMAZON");
});

test("默认 prefix 输出不变，裁剪不会留下半个国旗字符", () => {
  assert.equal(
    evaluate('applyMode("旧名", "🇺🇸|Cloud|AMAZON", "prefix", 40)'),
    "🇺🇸|Cloud|AMAZON"
  );
  const name = evaluate('truncateText("A".repeat(39) + "🇺🇸", 40)');
  assert.equal(name, "A".repeat(39));
});

test("IPinfo 国家优先级保持不变", () => {
  assert.equal(evaluate('chooseGeoCC("ipinfo", "US", "NL", "CN")'), "US");
  assert.equal(evaluate('chooseGeoCC("ipapi", "US", "NL", "CN")'), "NL");
});
