const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(
  path.join(__dirname, "..", "CloudRename.js"),
  "utf8"
);

function rename(nodes, args = {}) {
  const input = nodes.map((node) => ({ ...node }));
  return vm.runInNewContext(`${script}\noperator(proxies)`, {
    proxies: input,
    $arguments: args,
    console: { log() {} },
  }).map((node) => node.name);
}

test("保留等级、线路、IP 属性、用途和倍率，按节点原顺序输出", () => {
  const [name] = rename([{
    name: "FlowerCloud 香港 高级 IEPL 专线 原生 住宅 低延迟 ChatGPT 0.8倍",
    type: "trojan",
  }]);
  assert.equal(
    name,
    "🇭🇰|FlowerCloud|香港01|高级|IEPL|专线|原生|住宅|低延迟|ChatGPT|0.8x"
  );
});

test("详细线路不重复产生泛化标签，SVIP 不拆为 VIP", () => {
  const [name] = rename([{
    name: "香港 CN2 GIA SVIP 旗舰 家宽 双ISP Netflix TikTok x2",
    type: "vless",
  }], { provider: "MyCloud" });
  assert.equal(
    name,
    "🇭🇰|MyCloud|香港01|CN2 GIA|SVIP|旗舰|家宽|双ISP|Netflix|TikTok|2x"
  );
});

test("标准、实验性、备用、隧道等补充描述可单独保留", () => {
  const [name] = rename([{
    name: "Cloud 日本 标准 实验性 隧道 备用 大带宽 高防",
    type: "ss",
  }]);
  assert.equal(
    name,
    "🇯🇵|Cloud|日本01|标准|实验性|隧道|备用|大带宽|高防"
  );
});

test("扩展等级保留各自区别，不合并为泛化标签", () => {
  const [name] = rename([{
    name: "Cloud 香港 尊享 铂金 PRO 实验 内测",
    type: "ss",
  }]);
  assert.equal(
    name,
    "🇭🇰|Cloud|香港01|尊享|铂金|专业|实验|内测"
  );
});

test("数量限制与名称长度限制均优先保留靠后的等级", () => {
  const input = [{
    name: "Cloud 香港 IEPL IPLC BGP 住宅 ChatGPT 低延迟 标准 实验性",
    type: "ss",
  }];
  assert.equal(
    rename(input, { max_tags: 2 })[0],
    "🇭🇰|Cloud|香港01|标准|实验性"
  );
  const [short] = rename(input, { name_len: 37 });
  assert.match(short, /\|标准\|实验性/);
  assert.ok(!short.includes("|SS"));
});

test("保留后置括号中的未收录描述，忽略地区、序号和协议括号", () => {
  const [name] = rename([{
    name: "Cloud 香港【樱花专享】[02](trojan)",
    type: "ss",
  }]);
  assert.equal(name, "🇭🇰|Cloud|香港01|樱花专享");
  assert.equal(
    rename([{ name: "香港【高级】", type: "ss" }])[0],
    "🇭🇰|UNKNOWN|香港01|高级"
  );
  assert.equal(
    rename([{
      name: "【Cloud】 香港【樱花专享】[香港][v2][20ms]",
      type: "ss",
    }])[0],
    "🇭🇰|Cloud|香港01|樱花专享"
  );
});

test("明示等级和线路字段可提取未收录的自定义名称", () => {
  const [name] = rename([{
    name: "Cloud 香港 等级:星耀 线路:樱花加速 IEPL",
    type: "ss",
  }]);
  assert.equal(name, "🇭🇰|Cloud|香港01|星耀|樱花加速|IEPL");
  const [withoutExtra] = rename([{
    name: "Cloud 香港 等级:星耀",
    type: "ss",
  }], { show_extra: 0 });
  assert.equal(withoutExtra, "🇭🇰|Cloud|香港01");
});

test("可按类别关闭标签，也支持自定义标签", () => {
  const [name] = rename([{
    name: "香港 高级 专线 住宅 游戏 极光加速",
    type: "ss",
  }], {
    provider: "MyCloud",
    show_tier: 0,
    show_ip_type: 0,
    custom_tags: "极光加速",
  });
  assert.equal(name, "🇭🇰|MyCloud|香港01|专线|游戏|极光加速");
});

test("自定义复合词优先于内置单词，并在关闭标签时不污染机场名", () => {
  const input = [{ name: "香港 静态住宅 精品线路", type: "ss" }];
  const args = { custom_tags: "静态住宅,精品线路" };
  assert.equal(
    rename(input, args)[0],
    "🇭🇰|UNKNOWN|香港01|静态住宅|精品线路"
  );
  assert.equal(
    rename(input, { ...args, show_line: 0 })[0],
    "🇭🇰|UNKNOWN|香港01"
  );
});

test("仅有地区和描述词时不会误提取机场名", () => {
  const [name] = rename([{
    name: "香港 高级 IEPL 住宅 ChatGPT 2倍",
    type: "trojan",
  }]);
  assert.equal(name, "🇭🇰|UNKNOWN|香港01|高级|IEPL|住宅|ChatGPT|2x");
});

test("描述词重复、贴合地区名及 IP 后缀不会污染机场名", () => {
  const [name] = rename([{
    name: "香港高级高级原生IP住宅IP专线2倍",
    type: "ss",
  }]);
  assert.equal(name, "🇭🇰|UNKNOWN|香港01|高级|原生|住宅|专线|2x");
});

test("长名称保留完整标签与倍率，不截断尾部", () => {
  const [name] = rename([{
    name: "香港 高级 旗舰 标准 精品 实验性 专线 住宅 原生 低延迟 流媒体 3倍",
    type: "trojan",
  }], { provider: "MyCloud", name_len: 44 });
  assert.ok(name.length <= 44);
  assert.match(name, /\|3x$/);
  assert.ok(!name.endsWith("|"));
});

test("suffix 模式优先保留生成的新名称", () => {
  const [name] = rename([{
    name: "这是一个非常非常长的机场节点名称 香港 高级 IEPL 0.8倍",
    type: "ss",
  }], { provider: "Cloud", mode: "suffix", name_len: 40 });
  assert.ok(name.length <= 40);
  assert.match(name, /🇭🇰\|Cloud\|香港01\|高级\|IEPL\|0\.8x$/);
});

test("支持倍率元数据、旧参数别名、透传模式", () => {
  const input = [{ name: "香港 高级 专线", type: "ss", _multiplier: 1.5 }];
  assert.equal(
    rename(input, { provider: "Cloud", max_line_tags: 1 })[0],
    "🇭🇰|Cloud|香港01|高级|1.5x"
  );
  assert.equal(rename(input, { mode: "off" })[0], input[0].name);
});

test("不再输出协议、传输或 TLS，旧 show_proto 参数也不起作用", () => {
  const [name] = rename([{
    name: "Cloud 香港 TROJAN",
    type: "trojan",
    network: "ws",
    tls: true,
  }], { show_proto: 1 });
  assert.equal(name, "🇭🇰|Cloud|香港01");
});
