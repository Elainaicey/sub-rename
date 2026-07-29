# sub-rename

用于 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 的高性能节点重命名脚本集合。

本仓库提供两种不同策略：

| 脚本 | 适用场景 | 数据来源 | 特点 |
| --- | --- | --- | --- |
| [NodeRename.js](./NodeRename.js) | 需要识别真实落地出口、ASN、IP 类型和原生/广播 | IPinfo、ipapi.is、Cloudflare Trace、RIPE | 信息更完整，支持缓存、批量查询和并发探测 |
| [CloudRename.js](./CloudRename.js) | 只根据节点名称和元数据快速整理节点 | 本地规则，无外部请求 | 运行快、零网络依赖，支持大量地区和线路标签 |

当前版本：`NodeRename v1.0.1`、`CloudRename v1.0.0`。

## NodeRename

`NodeRename.js` 会经节点探测真实出口，默认使用 IPinfo 判断出口国家，并通过 ipapi.is、RIPE 补充 ASN 商家、IP 类型及原生/广播标签。各地理来源独立缓存，后续元数据查询不会覆盖 IPinfo 的国家结果。

默认输出格式：

```text
国旗|订阅/商家|ASN 商家|IP 类型|原生/广播
```

推荐参数：

```text
#concurrency=6&probe_source=auto&geo_source=ipinfo&native_source=auto&node_ttl=6&ttl=72&stale_ttl=168&mode=prefix&dedupe=1&debug=0
```

常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `concurrency` | `6` | 节点探测并发数，建议设置为 4～8 |
| `probe_source` | `auto` | IPinfo 优先，失败时依次回退 ipapi.is、Cloudflare Trace |
| `geo_source` | `ipinfo` | 国家优先级；可选 `ipinfo`、`ipapi`、`cf`、`consensus` |
| `ipinfo_timeout` | `4500` | IPinfo 查询超时，单位为毫秒 |
| `ipinfo_token` | 空 | 可选 Token；填写后默认使用不限量的 IPinfo Lite |
| `ipinfo_api` | `auto` | 有 Token 使用 Lite，无 Token 使用 Legacy；也可手动指定 |
| `native_source` | `auto` | ASN 国家优先，缺失时使用 RIPE |
| `node_ttl` | `6` | 节点出口缓存时间，单位为小时 |
| `ttl` | `72` | IP/ASN 完整元数据缓存时间，单位为小时 |
| `stale_ttl` | `168` | 查询失败时允许使用旧缓存的最长时间 |
| `mode` | `prefix` | `prefix` 覆盖、`suffix` 追加、`off` 不处理 |
| `provider` | 自动识别 | 手动指定订阅或商家名称 |
| `show_proto` | `0` | 是否显示协议、传输及安全层 |
| `show_ip` | `0` | 是否显示真实出口 IP |
| `separator` | `|` | 输出字段分隔符 |
| `name_len` | `95` | 节点名称最大长度 |
| `dedupe` | `1` | 为重名节点追加 `#2`、`#3` |
| `debug` | `0` | 输出耗时、缓存和失败原因 |

完整参数说明位于 [NodeRename.js](./NodeRename.js) 文件开头。

### NodeRename 注意事项

- 脚本会向第三方 IP 信息服务发送出口 IP；介意外部查询时请使用 `CloudRename.js`。
- 无 Token 时使用 IPinfo Legacy，每日限制 1,000 次且同一出口共享额度；推荐申请免费 Token，脚本会自动切换到不限量的 IPinfo Lite。
- `ipinfo_token` 和 ipapi.is 的 `key` 都应私下配置，不要提交到公开仓库。
- 如仍显式使用旧参数 `geo_source=ipapi`，ipapi.is 的国家结果仍会优先；升级后请改成 `geo_source=ipinfo` 或删除该参数。
- “原生/广播”是出口国家与 ASN/RIR 注册国家的经验比较，不等同于运营商的正式原生 IP 认证。
- 节点出口探测依赖 Sub-Store 的 HTTP META 能力，默认地址为 `127.0.0.1:9876`。
- IPinfo 地理与 ASN 数据由 [IPinfo](https://ipinfo.io) 提供。

## CloudRename

`CloudRename.js` 不请求任何外部 API，只根据节点名称、国旗、国家代码和节点元数据识别地区，同时提取线路、倍率和协议标签。

默认输出格式：

```text
国旗|机场名|地区序号|线路标签|倍率|协议
```

输出示例：

```text
🇭🇰|XSUS|香港01|0.8x|ANYTLS
🇭🇰|FlowerCloud|香港01|实验性|IEPL|专线|TROJAN
```

推荐参数：

```text
#drop_info=1&mode=prefix&show_proto=1&show_line=1&show_rate=1&dedupe=1&keep_unknown=1&use_metadata=1
```

常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `drop_info` | `1` | 过滤流量、到期、官网和通知类伪节点 |
| `mode` | `prefix` | `prefix` 覆盖、`suffix` 追加、`off` 不处理 |
| `provider` | 自动识别 | 手动指定机场名称 |
| `keep_unknown` | `1` | 是否保留无法识别地区的节点 |
| `use_metadata` | `1` | 名称未命中时读取节点国家/地区元数据 |
| `show_flag` | `1` | 是否显示国旗 |
| `show_provider` | `1` | 是否显示机场名称 |
| `show_region` | `1` | 是否显示地区名称 |
| `show_seq` | `1` | 是否在地区名称后显示序号 |
| `show_line` | `1` | 是否显示 IEPL、IPLC、CN2 GIA 等线路标签 |
| `show_rate` | `1` | 是否显示节点倍率 |
| `show_proto` | `1` | 是否显示协议、传输及 TLS/REALITY |
| `max_line_tags` | `4` | 单个节点最多保留的线路标签数量 |
| `seq_width` | `2` | 地区序号最小宽度，范围为 1～4 |
| `separator` | `|` | 输出字段分隔符 |
| `name_len` | `95` | 节点名称最大长度，范围为 32～256 |
| `dedupe` | `1` | 为重名节点追加 `#2`、`#3` |
| `debug` | `0` | 输出耗时、过滤及识别统计 |

完整参数说明位于 [CloudRename.js](./CloudRename.js) 文件开头。

## 使用方法

1. 在 Sub-Store 中新建脚本或脚本操作。
2. 复制所需 `.js` 文件的内容，或填写对应脚本的公开 Raw 地址。
3. 根据需要在脚本链接末尾追加参数，例如：

```text
CloudRename.js#provider=MyCloud&show_rate=1&show_proto=1
```

4. 将脚本添加到订阅或节点操作流程并运行。

不同 Sub-Store 前端版本的入口名称可能略有差异，但脚本参数保持一致。

## 本地检查

本项目是无依赖的 JavaScript 脚本集合，可使用 Node.js 进行基础语法检查：

```bash
node --check NodeRename.js
node --check CloudRename.js
```

实际出口探测和 Sub-Store 元数据行为仍需在对应的 Sub-Store 运行环境中验证。

## 安全建议

- 不要把订阅地址、API Key、HTTP META 认证信息或其他凭据提交到仓库。
- 发布前检查脚本参数中是否包含个人信息。
- 如果仓库设为私有，Sub-Store 通常无法直接访问未经认证的 GitHub Raw 链接。
