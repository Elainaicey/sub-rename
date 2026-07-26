/**
 * @Sub-Store-Page
 *
 * NodeRename v1.0.0
 * 高性能落地出口检测与节点重命名脚本
 *
 * 默认输出：
 * 国旗|订阅/商家|ASN 商家|IP 类型|原生/广播
 *
 * 默认策略：
 * 1. 经节点访问 ipapi.is 自查真实出口，并直接复用返回的国家、ASN 和 IP 类型。
 * 2. ipapi.is 自查失败时才访问 Cloudflare Trace，减少正常路径的请求数和等待时间。
 * 3. 相同节点配置只探测一次；相同出口 IP 的元数据自动合并、去重和批量查询。
 * 4. 分离“节点配置 -> 出口”和“出口 IP -> 元数据”缓存，修改命名参数不会复用错误标签。
 * 5. 默认使用 ASN 国家快速推测原生/广播；只有缺少 ASN 国家时才请求 RIPE。
 *
 * 推荐参数：
 * #concurrency=6&probe_source=auto&geo_source=ipapi&native_source=auto&node_ttl=6&ttl=72&stale_ttl=168&mode=prefix&dedupe=1&debug=0
 *
 * 探测与性能：
 * concurrency=6       节点并发数，建议 4~8
 * probe_source=auto   auto=ipapi 优先、失败回退 CF；ipapi=仅 ipapi；
 *                     cf=仅 CF；dual=并行双检并优先 ipapi
 * trace_timeout=4000  Cloudflare 单地址超时（毫秒）
 * api_timeout=5500    ipapi.is 超时（毫秒）
 * start_delay=800     HTTP META 启动等待（毫秒）
 * batch_concurrency=2 ipapi.is 批量请求并发数
 *
 * 缓存：
 * node_ttl=6          节点出口缓存（小时）
 * ttl=72              IP/ASN 元数据缓存（小时）
 * partial_ttl=1       不完整元数据缓存（小时）
 * stale_ttl=168       查询失败时可使用旧缓存的最长时间（小时）
 * force=0             仅强制重测节点出口，不浪费仍有效的 IP 元数据缓存
 * force_api=0         同时强制刷新 IP/ASN 元数据
 *
 * 数据源：
 * geo_source=ipapi    ipapi=ipapi.is 国家优先；cf=Cloudflare 国家优先
 * api_via=auto        auto/direct=后台批量及精确查询；proxy=精确查询经节点
 * key=xxx             ipapi.is API Key，可选；不要写入公开脚本
 * native_check=1      是否显示原生/广播
 * native_source=auto  auto=ASN 国家优先、RIPE 兜底；asn=仅 ASN；ripe=仅 RIPE
 * ripe_vendor=1       ipapi.is 缺少商家时使用 RIPE ASN Holder 兜底
 * ripe_timeout=4500   RIPE 请求超时（毫秒）
 *
 * HTTP META：
 * http_meta_protocol=http
 * http_meta_host=127.0.0.1
 * http_meta_port=9876
 * http_meta_auth=     HTTP META 开启 Authorization 时填写
 *
 * 命名：
 * mode=prefix         prefix=覆盖原名；suffix=追加；off=不处理
 * provider=xxx        手动覆盖订阅/商家名
 * vendor_len=16       ASN 商家最大长度，6~24
 * show_provider=1     显示订阅/商家
 * show_vendor=1       显示 ASN 商家
 * show_type=1         显示 IP 类型
 * show_native=1       显示原生/广播
 * show_proto=0        显示协议/传输
 * show_ip=0           显示出口 IP
 * separator=|         字段分隔符
 * name_len=95         节点名最大长度
 * mark_fail=1         探测失败时生成 UNKNOWN/未知标签
 * dedupe=1            重名节点追加 #2/#3
 * debug=0             输出性能统计和失败原因
 *
 * “原生/广播”只是出口地理国家与 ASN/RIR 注册国家的经验比较，
 * 不等同于运营商或数据库的正式“原生 IP”认证。
 */

const SCRIPT_VERSION = "1.0.0";
const CACHE_KEY = "node_rename_cache_v1";
const CACHE_SCHEMA = 1;
const UNKNOWN = "未知";
const UNKNOWN_VENDOR = "UNKNOWN";
const IPAPI_URL = "https://api.ipapi.is";
const DEFAULT_TRACE_ENDPOINTS = [
  "https://www.cloudflare.com/cdn-cgi/trace",
  "https://one.one.one.one/cdn-cgi/trace",
];
const CORE_TARGETS = ["ClashMeta", "Mihomo", "Clash"];
const FINGERPRINT_IGNORED_KEYS = new Set([
  "name",
  "id",
  "collectionName",
  "subName",
]);
const VENDOR_ALIASES = [
  [/HETZNER/i, "HETZNER"],
  [/AMAZON|AWS/i, "AMAZON"],
  [/GOOGLE/i, "GOOGLE"],
  [/MICROSOFT|AZURE/i, "MICROSOFT"],
  [/CLOUDFLARE/i, "CLOUDFLARE"],
  [/DIGITALOCEAN/i, "DIGITALOCEAN"],
  [/AKAMAI|LINODE/i, "AKAMAI"],
  [/\bOVH\b/i, "OVH"],
  [/ORACLE/i, "ORACLE"],
  [/ALIBABA|ALICLOUD/i, "ALIBABA"],
  [/TENCENT/i, "TENCENT"],
  [/HUAWEI/i, "HUAWEI"],
  [/CHINA\s+MOBILE|CMCC/i, "CHINA MOBILE"],
  [/CHINA\s+UNICOM|CUCC/i, "CHINA UNICOM"],
  [/CHINA\s+TELECOM|CTGNET|CHINANET/i, "CHINA TELECOM"],
];

function safeJson(value, fallback) {
  if (value && typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function hours(value) {
  return value * 3600 * 1000;
}

function numberArg(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function enumArg(value, allowed, fallback) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function errorText(error) {
  return String(error?.message || error || "未知错误")
    .replace(/\s+/g, " ")
    .slice(0, 260);
}

function responseStatus(response) {
  const status = Number(response?.statusCode || response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

function assertResponse(response, label) {
  const status = responseStatus(response);
  if (status >= 400) {
    throw new Error(`${label} HTTP ${status}`);
  }
  return response;
}

function normalizeCC(value) {
  const cc = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) ? cc : "";
}

function normalizeIp(value) {
  const ip = String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!ip || ip.length > 64) {
    return "";
  }

  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (
      parts.length === 4 &&
      parts.every(
        (part) =>
          /^\d{1,3}$/.test(part) &&
          Number(part) >= 0 &&
          Number(part) <= 255
      )
    ) {
      return parts.map((part) => String(Number(part))).join(".");
    }
    if (!ip.includes(":")) {
      return "";
    }
  }

  if (
    ip.includes(":") &&
    /^[0-9a-f:.]+$/.test(ip) &&
    (ip.match(/::/g) || []).length <= 1
  ) {
    return ip;
  }
  return "";
}

function flagEmoji(cc) {
  const value = normalizeCC(cc);
  if (!value) {
    return "🌐";
  }
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + value.charCodeAt(0) - 65,
    base + value.charCodeAt(1) - 65
  );
}

function isFlagOnly(value) {
  const points = Array.from(String(value || "").trim()).map((character) =>
    character.codePointAt(0)
  );
  return (
    points.length === 2 &&
    points.every((point) => point >= 0x1f1e6 && point <= 0x1f1ff)
  );
}

function normalizeProviderName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  return raw
    .replace(/[⏳✅❌⭐️]/g, "")
    .replace(/^[\s|\-_/\\]+|[\s|\-_/\\]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function vendorShortFromOrg(org, maxLength = 16) {
  const limit = Math.min(24, Math.max(6, Number(maxLength) || 16));
  let value = String(org || "")
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, " ")
    .replace(/,\s*[A-Z]{2}$/i, " ")
    .replace(/[,_/\\|:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!value) {
    return UNKNOWN_VENDOR;
  }
  for (const [pattern, alias] of VENDOR_ALIASES) {
    if (pattern.test(value)) {
      return alias.slice(0, limit);
    }
  }

  value = value
    .replace(
      /\b(?:INCORPORATED|CORPORATION|COMPANY|LIMITED|HOLDINGS?|TECHNOLOGIES|NETWORKS?|COMMUNICATIONS?|INTERNATIONAL|GMBH|S\.?A\.?|S\.?R\.?L\.?|LLC|LTD|INC|CORP|CO)\b\.?/gi,
      " "
    )
    .replace(/\bAS\d+\b/gi, " ")
    .replace(/[^A-Za-z0-9\u3400-\u9FFF.\-& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return value ? value.toUpperCase().slice(0, limit) : UNKNOWN_VENDOR;
}

function ipapiGeoCC(data) {
  return (
    normalizeCC(data?.location?.country_code) ||
    normalizeCC(data?.country_code) ||
    normalizeCC(data?.country)
  );
}

function ipapiAsnCC(data) {
  return normalizeCC(data?.asn?.country);
}

function ipapiOrg(data) {
  return String(
    data?.asn?.org ||
      data?.company?.name ||
      data?.datacenter?.datacenter ||
      data?.asn?.descr ||
      ""
  ).trim();
}

function positiveFlag(value) {
  if (value === true || value === 1) {
    return true;
  }
  return /^(?:1|true|yes|y)$/i.test(String(value || "").trim());
}

function normalizeIpTypeValue(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function mapIpTypeValue(value) {
  const type = normalizeIpTypeValue(value);
  if (!type) {
    return "";
  }
  if (/(?:mobile|cellular|wireless mobile)/.test(type)) {
    return "移动";
  }
  if (/(?:satellite|starlink|viasat|oneweb)/.test(type)) {
    return "卫星";
  }
  if (/(?:residential|home internet|home broadband)/.test(type)) {
    return "家宽";
  }
  if (
    /(?:hosting|hoster|data ?center|datacentre|cloud|colo(?:cation)?|server|cdn|content delivery)/.test(
      type
    )
  ) {
    return "数据中心";
  }
  if (
    /(?:^|\s)(?:isp|internet service provider|broadband|telecom|carrier)(?:\s|$)/.test(
      type
    )
  ) {
    return "运营商";
  }
  if (/(?:education|university|academic|school)/.test(type)) {
    return "教育";
  }
  if (/(?:government|governmental|military)/.test(type)) {
    return "政府";
  }
  if (/(?:banking|bank|financial|finance)/.test(type)) {
    return "金融";
  }
  if (/(?:business|enterprise|corporate|commercial)/.test(type)) {
    return "商业";
  }
  return "";
}

function inferIpTypeFromOrganization(data) {
  const text = [
    data?.datacenter?.datacenter,
    data?.datacenter?.name,
    data?.datacenter?.domain,
    data?.company?.name,
    data?.company?.domain,
    data?.company?.netname,
    data?.asn?.org,
    data?.asn?.descr,
    data?.asn?.domain,
  ]
    .filter(Boolean)
    .join(" ");

  if (
    /(?:hetzner|amazon|aws|google cloud|microsoft azure|digitalocean|cloudflare|akamai|linode|vultr|ovh|oracle cloud|alibaba cloud|tencent cloud|huawei cloud|hosting|hoster|data ?center|datacentre|cloud services?|colo(?:cation)?|server hosting|cdn)/i.test(
      text
    )
  ) {
    return "数据中心";
  }
  if (
    /(?:china telecom|chinanet|china unicom|china mobile|cmcc|cucc|ctgnet|broadband|telecom|telecommunications|internet service provider|fiber|fibre|cable|mobile communications)/i.test(
      text
    )
  ) {
    return "运营商";
  }
  if (/(?:university|college|academy|education)/i.test(text)) {
    return "教育";
  }
  if (/(?:government|ministry|municipality|military)/i.test(text)) {
    return "政府";
  }
  return "";
}

function ipTypeFromIpapi(data) {
  if (!data || typeof data !== "object") {
    return UNKNOWN;
  }
  if (positiveFlag(data.is_mobile ?? data.mobile)) {
    return "移动";
  }
  if (positiveFlag(data.is_satellite ?? data.satellite)) {
    return "卫星";
  }
  if (
    positiveFlag(
      data.is_datacenter ??
        data.is_data_center ??
        data.datacenter_flag ??
        data.hosting
    ) ||
    (data.datacenter &&
      typeof data.datacenter === "object" &&
      Object.keys(data.datacenter).length > 0)
  ) {
    return "数据中心";
  }

  const candidates = [
    data?.company?.type,
    data?.asn?.type,
    data?.network?.type,
    data?.connection?.type,
    data?.usage_type,
    data?.usageType,
    data?.ip_type,
    data?.ipType,
    data?.type,
  ];
  for (const candidate of candidates) {
    const mapped = mapIpTypeValue(candidate);
    if (mapped) {
      return mapped;
    }
  }
  return inferIpTypeFromOrganization(data) || UNKNOWN;
}

function summarizeIpapi(data) {
  const ip = normalizeIp(data?.ip);
  if (!data || data.error || !ip) {
    return null;
  }
  return {
    ip,
    geoCC: ipapiGeoCC(data),
    asnCC: ipapiAsnCC(data),
    asn: String(data?.asn?.asn || "")
      .replace(/^AS/i, "")
      .trim(),
    org: ipapiOrg(data),
    type: ipTypeFromIpapi(data),
    source: "ipapi.is",
  };
}

function mergeApiSummary(previous, current) {
  if (!previous || previous.ip !== current?.ip) {
    return current;
  }
  return {
    ip: current.ip,
    geoCC: current.geoCC || previous.geoCC || "",
    asnCC: current.asnCC || previous.asnCC || "",
    asn: current.asn || previous.asn || "",
    org: current.org || previous.org || "",
    type:
      current.type && current.type !== UNKNOWN
        ? current.type
        : previous.type || UNKNOWN,
    source: current.source || previous.source || "ipapi.is",
  };
}

function isCompleteApiSummary(summary) {
  return Boolean(
    normalizeIp(summary?.ip) &&
      normalizeCC(summary?.geoCC) &&
      summary?.org &&
      summary?.type &&
      summary.type !== UNKNOWN
  );
}

function ipTypeDiagnostic(data) {
  const fields = {
    is_mobile: data?.is_mobile,
    is_satellite: data?.is_satellite,
    is_datacenter: data?.is_datacenter,
    datacenter: data?.datacenter?.datacenter || data?.datacenter?.name,
    company_type: data?.company?.type,
    asn_type: data?.asn?.type,
    network_type: data?.network?.type,
    connection_type: data?.connection?.type,
    usage_type: data?.usage_type ?? data?.usageType,
    ip_type: data?.ip_type ?? data?.ipType,
    top_type: data?.type,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ")
    .slice(0, 320);
}

function nativeLabel(geoCC, registrationCC) {
  const geo = normalizeCC(geoCC);
  const registered = normalizeCC(registrationCC);
  if (!geo || !registered) {
    return UNKNOWN;
  }
  return geo === registered ? "原生" : "广播";
}

function looksLikeUsage(value) {
  return /\d+(?:\.\d+)?\s*(?:TB|GB|MB|KB|TiB|GiB|MiB|KiB|T|G|M|K)\b/i.test(
    String(value || "")
  );
}

function looksLikeExpire(value) {
  const text = String(value || "");
  return (
    /(?:\d+\s*(?:D|天|日)|\d+\s*(?:H|时|小时)|到期|过期|expire|剩余)/i.test(
      text
    ) && !looksLikeUsage(text)
  );
}

function providerFromNode(proxy, manualProvider) {
  if (manualProvider) {
    return normalizeProviderName(manualProvider) || UNKNOWN_VENDOR;
  }

  const subscription = normalizeProviderName(
    proxy?._subDisplayName || proxy?._subName
  );
  if (subscription) {
    return subscription;
  }

  const parts = String(proxy?.name || "")
    .split(/[|｜\-_/\\]+/)
    .map(normalizeProviderName)
    .filter(Boolean);

  for (const part of parts) {
    if (
      isFlagOnly(part) ||
      looksLikeUsage(part) ||
      looksLikeExpire(part) ||
      /^(?:UNKNOWN|未知|原生|广播|数据中心|运营商|家宽)$/i.test(part) ||
      /^(?:vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic)$/i.test(part)
    ) {
      continue;
    }
    return part.slice(0, 24);
  }
  return UNKNOWN_VENDOR;
}

function protoLabel(proxy) {
  const type = String(proxy?.type || "").toUpperCase();
  const network = String(proxy?.network || "").toUpperCase();
  const hasReality = Boolean(
    proxy?.["reality-opts"] ||
      proxy?.realityOpts ||
      String(proxy?.flow || "").includes("xtls-rprx")
  );
  const security = hasReality ? "REALITY" : proxy?.tls ? "TLS" : "";
  return [type, network, security].filter(Boolean).join("-") || UNKNOWN_VENDOR;
}

function buildName(geo, local, options) {
  const fields = [flagEmoji(geo?.geoCC)];
  if (options.showProvider) {
    fields.push(local.provider || UNKNOWN_VENDOR);
  }
  if (options.showVendor) {
    fields.push(geo?.vendor || UNKNOWN_VENDOR);
  }
  if (options.showType) {
    fields.push(geo?.type || UNKNOWN);
  }
  if (options.showNative) {
    fields.push(geo?.native || UNKNOWN);
  }
  if (options.showProto) {
    fields.push(local.proto || UNKNOWN_VENDOR);
  }
  if (options.showIp) {
    fields.push(geo?.ip || "NO-IP");
  }
  return fields
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(options.separator)
    .slice(0, options.nameLength);
}

function applyMode(oldName, tag, mode, nameLength) {
  if (!tag || mode === "off") {
    return oldName;
  }
  if (mode === "suffix") {
    const old = String(oldName || "");
    if (old === tag || old.endsWith(` ${tag}`)) {
      return old.slice(0, nameLength);
    }
    return `${old} ${tag}`.trim().slice(0, nameLength);
  }
  return tag.slice(0, nameLength);
}

function dedupeNames(proxies, nameLength) {
  const used = new Set();
  const counters = new Map();
  for (const proxy of proxies) {
    const base = String(proxy?.name || "").slice(0, nameLength);
    if (!used.has(base)) {
      used.add(base);
      counters.set(base, 1);
      proxy.name = base;
      continue;
    }

    let count = counters.get(base) || 1;
    let candidate;
    do {
      count++;
      const suffix = `#${count}`;
      candidate = `${base.slice(
        0,
        Math.max(0, nameLength - suffix.length)
      )}${suffix}`;
    } while (used.has(candidate));
    counters.set(base, count);
    used.add(candidate);
    proxy.name = candidate;
  }
}

function isApiSufficient(summary, options) {
  if (!normalizeCC(summary?.geoCC)) {
    return false;
  }
  if (options.showVendor && !summary?.org) {
    return false;
  }
  if (options.showType && (!summary?.type || summary.type === UNKNOWN)) {
    return false;
  }
  return true;
}

function coreMarker(index, fingerprint) {
  return `__NR_${index}_${fingerprint}`;
}

function mapConvertedOutput(output, groups, target) {
  if (!Array.isArray(output) || !output.length) {
    return [];
  }
  const mapped = [];
  const usedIndices = new Set();
  for (const proxy of output) {
    const match = String(proxy?.name || "").match(/__NR_(\d+)_/);
    const index = match ? Number(match[1]) : -1;
    if (
      Number.isInteger(index) &&
      index >= 0 &&
      index < groups.length &&
      !usedIndices.has(index)
    ) {
      usedIndices.add(index);
      mapped.push({ group: groups[index], proxy, target });
    }
  }
  if (mapped.length === output.length) {
    return mapped;
  }
  if (output.length === groups.length) {
    return output.map((proxy, index) => ({
      group: groups[index],
      proxy,
      target,
    }));
  }
  return mapped;
}

async function mapLimit(items, limit, task) {
  if (!items.length) {
    return [];
  }
  const output = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) {
        return;
      }
      output[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function stableSerialize(value, stack = new Set()) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (stack.has(value)) {
    return '"[Circular]"';
  }
  stack.add(value);
  let output;
  if (Array.isArray(value)) {
    output = `[${value.map((item) => stableSerialize(item, stack)).join(",")}]`;
  } else {
    const pairs = [];
    for (const key of Object.keys(value).sort()) {
      if (key.startsWith("_") || FINGERPRINT_IGNORED_KEYS.has(key)) {
        continue;
      }
      const child = value[key];
      if (typeof child === "function" || child === undefined) {
        continue;
      }
      pairs.push(`${JSON.stringify(key)}:${stableSerialize(child, stack)}`);
    }
    output = `{${pairs.join(",")}}`;
  }
  stack.delete(value);
  return output;
}

function nodeFingerprint(proxy) {
  const text = stableSerialize(proxy);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + ((second << 6) >>> 0) + (second >>> 2);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function parseTraceBody(body) {
  const output = {};
  for (const line of String(body || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) {
      output[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return output;
}

function extractCC(object) {
  if (!object || typeof object !== "object") {
    return "";
  }
  const queue = [{ value: object, depth: 0 }];
  const seen = new Set();
  let cursor = 0;

  while (cursor < queue.length) {
    const { value, depth } = queue[cursor++];
    if (!value || typeof value !== "object" || seen.has(value) || depth > 6) {
      continue;
    }
    seen.add(value);
    for (const key of Object.keys(value)) {
      const child = value[key];
      const normalizedKey = key.toLowerCase();
      if (typeof child === "string") {
        const cc = normalizeCC(child);
        if (
          cc &&
          (normalizedKey.includes("country") ||
            normalizedKey === "cc" ||
            normalizedKey.includes("location"))
        ) {
          return cc;
        }
      } else if (child && typeof child === "object") {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return "";
}

function rirCountryFromResponse(data) {
  const stats = data?.data?.stats;
  if (Array.isArray(stats)) {
    for (const item of stats) {
      const cc = normalizeCC(item?.country);
      if (cc) {
        return cc;
      }
    }
  }
  return extractCC(data);
}

function normalizeIpapiBatch(data) {
  if (Array.isArray(data)) {
    return data;
  }
  for (const key of ["data", "results", "ips"]) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }
  if (data?.ip) {
    return [data];
  }
  if (data && typeof data === "object") {
    return Object.values(data).filter(
      (item) => item && typeof item === "object" && item.ip
    );
  }
  return [];
}

function loadCache(store) {
  const raw = safeJson(store.read(CACHE_KEY) || "{}", {});
  if (
    raw?.schema === CACHE_SCHEMA &&
    raw.entries &&
    typeof raw.entries === "object"
  ) {
    return { data: raw, dirty: false };
  }
  return {
    data: {
      schema: CACHE_SCHEMA,
      version: SCRIPT_VERSION,
      entries: {},
    },
    dirty: true,
  };
}

function cacheEntry(cache, key) {
  const entry = cache.data.entries[key];
  return entry && typeof entry === "object" ? entry : null;
}

function cacheLookup(cache, key, freshTtlMs, staleTtlMs, forceFresh = false) {
  const entry = cacheEntry(cache, key);
  if (!entry?.value || !Number.isFinite(Number(entry.ts))) {
    return { value: null, fresh: false, stale: false };
  }
  const age = Date.now() - Number(entry.ts);
  return {
    value: entry.value,
    fresh: !forceFresh && age >= 0 && age < freshTtlMs,
    stale: age >= 0 && age < staleTtlMs,
  };
}

function saveCacheEntry(cache, key, value, extra = {}) {
  cache.data.entries[key] = {
    ts: Date.now(),
    value,
    ...extra,
  };
  cache.data.version = SCRIPT_VERSION;
  cache.dirty = true;
}

function apiCacheLookup(
  cache,
  ip,
  fullTtlMs,
  partialTtlMs,
  staleTtlMs,
  forceFresh = false
) {
  const entry = cacheEntry(cache, `ip:${ip}`);
  const ttl = isCompleteApiSummary(entry?.value) ? fullTtlMs : partialTtlMs;
  return cacheLookup(cache, `ip:${ip}`, ttl, staleTtlMs, forceFresh);
}

function saveApiSummary(cache, summary) {
  if (!summary?.ip) {
    return null;
  }
  const previous = cacheEntry(cache, `ip:${summary.ip}`)?.value;
  const merged = mergeApiSummary(previous, summary);
  saveCacheEntry(cache, `ip:${summary.ip}`, merged, {
    quality: isCompleteApiSummary(merged) ? "full" : "partial",
  });
  if (merged.asn && merged.type && merged.type !== UNKNOWN) {
    const previousAsn = cacheEntry(cache, `asn:${merged.asn}`)?.value || {};
    saveCacheEntry(cache, `asn:${merged.asn}`, {
      type: merged.type || previousAsn.type || UNKNOWN,
      org: merged.org || previousAsn.org || "",
      source: merged.source || previousAsn.source || "ipapi.is",
    });
  }
  return merged;
}

function pruneCache(cache, maxAgeMs, maxEntries) {
  const entries = Object.entries(cache.data.entries);
  const currentTime = Date.now();
  for (const [key, entry] of entries) {
    if (
      !Number.isFinite(Number(entry?.ts)) ||
      currentTime - Number(entry.ts) > maxAgeMs
    ) {
      delete cache.data.entries[key];
      cache.dirty = true;
    }
  }

  const remaining = Object.entries(cache.data.entries);
  if (remaining.length <= maxEntries) {
    return;
  }
  remaining
    .sort((left, right) => Number(left[1]?.ts || 0) - Number(right[1]?.ts || 0))
    .slice(0, remaining.length - maxEntries)
    .forEach(([key]) => {
      delete cache.data.entries[key];
      cache.dirty = true;
    });
}

function normalizeDetection(value) {
  const ip = normalizeIp(value?.ip);
  if (!ip) {
    return null;
  }
  return {
    ip,
    traceCC: normalizeCC(value?.traceCC),
    apiCC: normalizeCC(value?.apiCC),
    source: String(value?.source || "cache"),
  };
}

function fallbackGeo() {
  return {
    ip: "",
    geoCC: "",
    vendor: UNKNOWN_VENDOR,
    type: UNKNOWN,
    native: UNKNOWN,
  };
}

function convertForCore(groups, addFailure) {
  if (typeof ProxyUtils === "undefined" || !ProxyUtils?.produce) {
    throw new Error("当前 Sub-Store 环境缺少 ProxyUtils.produce");
  }

  let best = [];
  for (const target of CORE_TARGETS) {
    const marked = groups.map((group, index) => ({
      ...group.proxy,
      name: coreMarker(index, group.fingerprint),
    }));
    try {
      const output = ProxyUtils.produce(marked, target, "internal");
      const partial = mapConvertedOutput(output, groups, target);
      if (partial.length === groups.length) {
        return partial;
      }
      if (partial.length > best.length) {
        best = partial;
      }
    } catch (error) {
      addFailure(-1, `节点批量转换/${target}`, error);
    }
  }

  const convertedKeys = new Set(best.map((item) => item.group.fingerprint));
  for (const group of groups) {
    if (convertedKeys.has(group.fingerprint)) {
      continue;
    }
    let converted = null;
    for (const target of CORE_TARGETS) {
      try {
        const output = ProxyUtils.produce(
          [{ ...group.proxy, name: `__NR_SINGLE_${group.fingerprint}` }],
          target,
          "internal"
        );
        if (Array.isArray(output) && output[0]) {
          converted = { group, proxy: output[0], target };
          break;
        }
      } catch {}
    }
    if (converted) {
      best.push(converted);
      convertedKeys.add(group.fingerprint);
    }
  }
  return best;
}

async function settled(promise) {
  try {
    return { value: await promise, error: null };
  } catch (error) {
    return { value: null, error };
  }
}

async function operator(proxies = []) {
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return Array.isArray(proxies) ? proxies : [];
  }

  const $ = $substore;
  const args =
    typeof $arguments === "object" && $arguments ? $arguments : {};
  const startedAt = Date.now();
  const info = (message) => {
    if (typeof $.info === "function") {
      $.info(message);
    } else if (typeof console !== "undefined" && console.log) {
      console.log(message);
    }
  };

  const mode = enumArg(args.mode, ["prefix", "suffix", "off"], "prefix");
  if (mode === "off") {
    return proxies;
  }

  const concurrency = numberArg(args.concurrency, 6, 1, 16);
  const batchConcurrency = numberArg(args.batch_concurrency, 2, 1, 4);
  const traceTimeout = numberArg(
    args.trace_timeout || args.timeout,
    4000,
    800,
    30000
  );
  const apiTimeout = numberArg(
    args.api_timeout || args.timeout,
    5500,
    800,
    30000
  );
  const ripeTimeout = numberArg(
    args.ripe_timeout || args.timeout,
    4500,
    800,
    30000
  );
  const startTimeout = numberArg(
    args.start_timeout || args.timeout,
    9000,
    2000,
    30000
  );
  const startDelay = numberArg(args.start_delay, 800, 0, 10000);
  const ttlMs = hours(numberArg(args.ttl, 72, 1, 720));
  const nodeTtlMs = hours(numberArg(args.node_ttl, 6, 0, 168));
  const partialTtlMs = hours(numberArg(args.partial_ttl, 1, 0, 24));
  const staleTtlMs = hours(numberArg(args.stale_ttl, 168, 1, 2160));
  const cacheMaxEntries = numberArg(args.cache_max, 5000, 500, 20000);
  const force = boolArg(args.force, false);
  const forceApi = boolArg(args.force_api, false);
  const debug = boolArg(args.debug, false);
  const markFail = boolArg(args.mark_fail, true);
  const nativeCheck = boolArg(args.native_check, true);
  const nativeSource = nativeCheck
    ? enumArg(args.native_source, ["auto", "asn", "ripe"], "auto")
    : "off";
  const ripeVendorEnabled = boolArg(args.ripe_vendor, true);
  const probeSource = enumArg(
    args.probe_source,
    ["auto", "ipapi", "cf", "dual"],
    "auto"
  );
  const geoSource = enumArg(args.geo_source, ["ipapi", "cf"], "ipapi");
  const apiVia = enumArg(args.api_via, ["auto", "direct", "proxy"], "auto");
  const apiKey = String(args.key || "").trim();
  const vendorMaxLength = numberArg(args.vendor_len, 16, 6, 24);
  const nameLength = numberArg(args.name_len, 95, 40, 160);
  const separator = String(args.separator || "|").slice(0, 3) || "|";

  const options = {
    provider: String(args.provider || "").trim(),
    showProvider: boolArg(args.show_provider, true),
    showVendor: boolArg(args.show_vendor, true),
    showType: boolArg(args.show_type, true),
    showNative: nativeCheck && boolArg(args.show_native, true),
    showProto: boolArg(args.show_proto, false),
    showIp: boolArg(args.show_ip, false),
    dedupe: boolArg(args.dedupe, true),
    separator,
    nameLength,
  };

  const customTraceEndpoints = String(args.cf_endpoints || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const traceEndpoints = customTraceEndpoints.length
    ? customTraceEndpoints
    : DEFAULT_TRACE_ENDPOINTS;

  const metaProtocol = enumArg(
    args.http_meta_protocol,
    ["http", "https"],
    "http"
  );
  const metaHost = String(args.http_meta_host || "127.0.0.1").trim();
  const metaPort = numberArg(args.http_meta_port, 9876, 1, 65535);
  const metaAuthorization = String(args.http_meta_auth || "").trim();
  const metaApi = `${metaProtocol}://${metaHost}:${metaPort}`;
  const metaHeaders = {
    "content-type": "application/json",
    ...(metaAuthorization ? { Authorization: metaAuthorization } : {}),
  };

  const cache = loadCache($);
  const shouldResolveNative = nativeSource !== "off" && options.showNative;
  const failures = [];
  const diagnostics = [];
  const stats = {
    total: proxies.length,
    uniqueNodes: 0,
    duplicateSaved: 0,
    routeCache: 0,
    routeStale: 0,
    coreNodes: 0,
    unsupported: 0,
    probed: 0,
    selfOk: 0,
    selfFail: 0,
    traceOk: 0,
    traceFail: 0,
    conflicts: 0,
    apiCache: 0,
    apiBatchRequests: 0,
    apiBatchResults: 0,
    apiExact: 0,
    nativeFast: 0,
    ripeCountry: 0,
    ripeVendor: 0,
    failed: 0,
  };

  function addFailure(index, stage, error) {
    if (failures.length >= 30) {
      return;
    }
    const prefix = index >= 0 ? `#${index + 1} ` : "";
    failures.push(`${prefix}${stage}: ${errorText(error)}`);
  }

  function addConflict(index, trace, selfApi) {
    stats.conflicts++;
    if (!debug || diagnostics.length >= 20) {
      return;
    }
    diagnostics.push(
      `#${index + 1} Cloudflare=${trace?.ip || "无"}/${
        trace?.geoCC || UNKNOWN
      }, ipapi.is=${selfApi?.summary?.ip || "无"}/${
        selfApi?.summary?.geoCC || UNKNOWN
      }，采用 ipapi.is`
    );
  }

  function logUnknownType(index, source, data) {
    if (!debug || diagnostics.length >= 20) {
      return;
    }
    diagnostics.push(
      `#${index + 1} ${source} 类型未识别: ${
        ipTypeDiagnostic(data) || "接口未返回可用类型字段"
      }`
    );
  }

  const locals = proxies.map((proxy) => ({
    provider: providerFromNode(proxy, options.provider),
    proto: options.showProto ? protoLabel(proxy) : "",
  }));

  const groupMap = new Map();
  for (let index = 0; index < proxies.length; index++) {
    const fingerprint = nodeFingerprint(proxies[index]);
    let group = groupMap.get(fingerprint);
    if (!group) {
      group = {
        fingerprint,
        key: `route:${fingerprint}`,
        proxy: proxies[index],
        firstIndex: index,
        indices: [],
        detection: null,
        staleDetection: null,
        needsProbe: false,
        needsCore: false,
        proxyUrl: "",
      };
      groupMap.set(fingerprint, group);
    }
    group.indices.push(index);
  }

  const groups = Array.from(groupMap.values());
  stats.uniqueNodes = groups.length;
  stats.duplicateSaved = proxies.length - groups.length;

  for (const group of groups) {
    const route = cacheLookup(
      cache,
      group.key,
      nodeTtlMs,
      staleTtlMs,
      force
    );
    const cachedDetection = normalizeDetection(route.value);
    if (route.stale && cachedDetection) {
      group.staleDetection = cachedDetection;
    }
    if (route.fresh && cachedDetection) {
      group.detection = cachedDetection;
      stats.routeCache += group.indices.length;
    } else {
      group.needsProbe = true;
    }

    if (
      apiVia === "proxy" &&
      group.detection?.ip &&
      !apiCacheLookup(
        cache,
        group.detection.ip,
        ttlMs,
        partialTtlMs,
        staleTtlMs,
        forceApi
      ).fresh
    ) {
      group.needsCore = true;
    }
    group.needsCore = group.needsCore || group.needsProbe;
  }

  let core = null;
  const coreGroups = groups.filter((group) => group.needsCore);

  function proxyUrlForPort(port) {
    return `http://${metaHost}:${port}`;
  }

  async function fetchCloudflareTrace(proxyUrl) {
    let lastError = null;
    for (const url of traceEndpoints) {
      try {
        const response = assertResponse(
          await $.http.get({
            url,
            timeout: traceTimeout,
            proxy: proxyUrl,
            headers: {
              accept: "text/plain,*/*",
              "user-agent": `NodeRename/${SCRIPT_VERSION}`,
            },
          }),
          "Cloudflare Trace"
        );
        const trace = parseTraceBody(response.body);
        const ip = normalizeIp(trace.ip);
        if (!ip) {
          throw new Error("未返回有效出口 IP");
        }
        return {
          ip,
          geoCC: normalizeCC(trace.loc),
          source: "cloudflare-trace",
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("全部地址失败");
  }

  async function fetchSelfIpapi(proxyUrl) {
    const query = apiKey ? `?key=${encodeURIComponent(apiKey)}` : "";
    const response = assertResponse(
      await $.http.get({
        url: `${IPAPI_URL}${query}`,
        timeout: apiTimeout,
        proxy: proxyUrl,
        headers: {
          accept: "application/json",
          "user-agent": `NodeRename/${SCRIPT_VERSION}`,
        },
      }),
      "ipapi.is 出口自查"
    );
    const data = safeJson(response.body, null);
    if (!data || data.error) {
      throw new Error(data?.error || "返回无效 JSON");
    }
    const summary = summarizeIpapi(data);
    if (!summary) {
      throw new Error("未返回有效出口 IP");
    }
    return { raw: data, summary };
  }

  async function batchIpapi(ips) {
    const body = { ips };
    if (apiKey) {
      body.key = apiKey;
    }
    const response = assertResponse(
      await $.http.post({
        url: IPAPI_URL,
        timeout: Math.min(30000, apiTimeout + Math.max(0, ips.length - 1) * 60),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": `NodeRename/${SCRIPT_VERSION}`,
        },
        body: JSON.stringify(body),
      }),
      "ipapi.is 批量查询"
    );
    const data = safeJson(response.body, null);
    if (!data || data.error) {
      throw new Error(data?.error || "返回无效 JSON");
    }
    return normalizeIpapiBatch(data);
  }

  async function exactIpapi(ip, proxyUrl) {
    const body = { q: ip };
    if (apiKey) {
      body.key = apiKey;
    }
    const request = {
      url: IPAPI_URL,
      timeout: apiTimeout,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `NodeRename/${SCRIPT_VERSION}`,
      },
      body: JSON.stringify(body),
    };
    if (proxyUrl) {
      request.proxy = proxyUrl;
    }
    const response = assertResponse(
      await $.http.post(request),
      "ipapi.is 精确查询"
    );
    const data = safeJson(response.body, null);
    if (!data || data.error) {
      throw new Error(data?.error || "返回无效 JSON");
    }
    return data;
  }

  async function fetchRirCountry(ip) {
    const response = assertResponse(
      await $.http.get({
        url: `https://stat.ripe.net/data/rir-stats-country/data.json?resource=${encodeURIComponent(
          ip
        )}&sourceapp=node-rename-v1`,
        timeout: ripeTimeout,
        headers: {
          accept: "application/json",
          "user-agent": `NodeRename/${SCRIPT_VERSION}`,
        },
      }),
      "RIPE RIR Country"
    );
    const data = safeJson(response.body, null);
    if (!data || data.status === "error") {
      throw new Error(data?.message || "返回无效 JSON");
    }
    return rirCountryFromResponse(data);
  }

  async function fetchRipeVendor(ip) {
    const networkResponse = assertResponse(
      await $.http.get({
        url: `https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(
          ip
        )}&sourceapp=node-rename-v1`,
        timeout: ripeTimeout,
        headers: {
          accept: "application/json",
          "user-agent": `NodeRename/${SCRIPT_VERSION}`,
        },
      }),
      "RIPE Network Info"
    );
    const network = safeJson(networkResponse.body, null);
    const asn = String(network?.data?.asns?.[0] || "")
      .replace(/^AS/i, "")
      .trim();
    if (!asn) {
      throw new Error("未返回 ASN");
    }

    const overviewResponse = assertResponse(
      await $.http.get({
        url: `https://stat.ripe.net/data/as-overview/data.json?resource=AS${encodeURIComponent(
          asn
        )}&sourceapp=node-rename-v1`,
        timeout: ripeTimeout,
        headers: {
          accept: "application/json",
          "user-agent": `NodeRename/${SCRIPT_VERSION}`,
        },
      }),
      "RIPE AS Overview"
    );
    const overview = safeJson(overviewResponse.body, null);
    const org = String(overview?.data?.holder || "").trim();
    if (!org) {
      throw new Error("未返回 ASN Holder");
    }
    return { asn, org, source: "ripe-stat" };
  }

  async function stopCore() {
    if (!core?.pid) {
      return;
    }
    const pid = core.pid;
    core = null;
    try {
      await $.http.post({
        url: `${metaApi}/stop`,
        timeout: startTimeout,
        headers: metaHeaders,
        body: JSON.stringify({ pid: [pid] }),
      });
    } catch (error) {
      addFailure(-1, "HTTP META Stop", error);
    }
  }

  if (coreGroups.length) {
    try {
      const converted = convertForCore(coreGroups, addFailure);
      stats.coreNodes = converted.length;
      stats.unsupported = coreGroups.length - converted.length;
      const convertedSet = new Set(
        converted.map((item) => item.group.fingerprint)
      );
      for (const group of coreGroups) {
        if (!convertedSet.has(group.fingerprint) && group.needsProbe) {
          addFailure(group.firstIndex, "节点转换", "当前核心不支持此节点");
        }
      }

      if (converted.length) {
        const rounds = Math.ceil(converted.length / concurrency);
        const probeWorst =
          probeSource === "cf"
            ? traceEndpoints.length * traceTimeout
            : probeSource === "ipapi"
              ? apiTimeout
              : probeSource === "dual"
                ? Math.max(apiTimeout, traceEndpoints.length * traceTimeout)
                : apiTimeout + traceEndpoints.length * traceTimeout;
        const coreLifetime = Math.min(
          1800000,
          Math.max(60000, startDelay + rounds * (probeWorst + 1000) + 10000)
        );
        const response = assertResponse(
          await $.http.post({
            url: `${metaApi}/start`,
            timeout: startTimeout,
            headers: metaHeaders,
            body: JSON.stringify({
              proxies: converted.map((item) => item.proxy),
              timeout: coreLifetime,
            }),
          }),
          "HTTP META Start"
        );
        core = safeJson(response.body, null);
        if (
          !core?.pid ||
          !Array.isArray(core?.ports) ||
          core.ports.length !== converted.length
        ) {
          throw new Error(
            `启动结果无效：${String(response.body || "").slice(0, 220)}`
          );
        }
        converted.forEach((item, index) => {
          item.group.proxyUrl = proxyUrlForPort(core.ports[index]);
        });

        if (startDelay > 0) {
          await $.wait(startDelay);
        }

        await mapLimit(
          converted.filter((item) => item.group.needsProbe),
          concurrency,
          async ({ group }) => {
            stats.probed++;
            let trace = null;
            let selfApi = null;

            if (probeSource === "auto" || probeSource === "ipapi") {
              try {
                selfApi = await fetchSelfIpapi(group.proxyUrl);
                stats.selfOk++;
              } catch (error) {
                stats.selfFail++;
                addFailure(group.firstIndex, "ipapi.is 出口自查", error);
              }
              if (!selfApi && probeSource === "auto") {
                try {
                  trace = await fetchCloudflareTrace(group.proxyUrl);
                  stats.traceOk++;
                } catch (error) {
                  stats.traceFail++;
                  addFailure(group.firstIndex, "Cloudflare 兜底", error);
                }
              }
            } else if (probeSource === "cf") {
              try {
                trace = await fetchCloudflareTrace(group.proxyUrl);
                stats.traceOk++;
              } catch (error) {
                stats.traceFail++;
                addFailure(group.firstIndex, "Cloudflare", error);
              }
            } else {
              const [traceResult, selfResult] = await Promise.all([
                settled(fetchCloudflareTrace(group.proxyUrl)),
                settled(fetchSelfIpapi(group.proxyUrl)),
              ]);
              trace = traceResult.value;
              selfApi = selfResult.value;
              if (trace) {
                stats.traceOk++;
              } else {
                stats.traceFail++;
                addFailure(group.firstIndex, "Cloudflare", traceResult.error);
              }
              if (selfApi) {
                stats.selfOk++;
              } else {
                stats.selfFail++;
                addFailure(
                  group.firstIndex,
                  "ipapi.is 出口自查",
                  selfResult.error
                );
              }
              if (
                trace &&
                selfApi &&
                (trace.ip !== selfApi.summary.ip ||
                  (trace.geoCC &&
                    selfApi.summary.geoCC &&
                    trace.geoCC !== selfApi.summary.geoCC))
              ) {
                addConflict(group.firstIndex, trace, selfApi);
              }
            }

            if (selfApi) {
              const sameIp = trace?.ip === selfApi.summary.ip;
              group.detection = {
                ip: selfApi.summary.ip,
                apiCC: selfApi.summary.geoCC,
                traceCC: sameIp ? trace?.geoCC || "" : "",
                source: "ipapi.is-self",
              };
              saveApiSummary(cache, selfApi.summary);
              if (selfApi.summary.type === UNKNOWN) {
                logUnknownType(
                  group.firstIndex,
                  "ipapi.is 出口自查",
                  selfApi.raw
                );
              }
            } else if (trace) {
              group.detection = {
                ip: trace.ip,
                apiCC: "",
                traceCC: trace.geoCC,
                source: trace.source,
              };
            }

            if (group.detection) {
              saveCacheEntry(cache, group.key, group.detection, {
                quality: "full",
              });
            }
          }
        );
      }
    } catch (error) {
      addFailure(-1, "HTTP META/出口探测", error);
    }
  }

  for (const group of groups) {
    if (!group.detection && group.staleDetection) {
      group.detection = group.staleDetection;
      stats.routeStale += group.indices.length;
    }
  }

  const detectionByIp = new Map();
  for (const group of groups) {
    if (!group.detection?.ip) {
      continue;
    }
    const candidate = {
      ...group.detection,
      proxyUrl: group.proxyUrl,
      firstIndex: group.firstIndex,
    };
    const previous = detectionByIp.get(group.detection.ip);
    if (!previous || (!previous.proxyUrl && candidate.proxyUrl)) {
      detectionByIp.set(group.detection.ip, candidate);
    }
  }
  const uniqueIps = Array.from(detectionByIp.keys());

  try {
    const apiMissing = [];
    for (const ip of uniqueIps) {
      const lookup = apiCacheLookup(
        cache,
        ip,
        ttlMs,
        partialTtlMs,
        staleTtlMs,
        forceApi
      );
      if (lookup.fresh && isApiSufficient(lookup.value, options)) {
        stats.apiCache++;
      } else {
        apiMissing.push(ip);
      }
    }

    const apiRefreshed = new Set();
    if (apiMissing.length && apiVia !== "proxy") {
      const chunks = [];
      for (let offset = 0; offset < apiMissing.length; offset += 100) {
        chunks.push(apiMissing.slice(offset, offset + 100));
      }
      await mapLimit(chunks, batchConcurrency, async (chunk) => {
        const chunkSet = new Set(chunk);
        try {
          stats.apiBatchRequests++;
          const results = await batchIpapi(chunk);
          for (const data of results) {
            const summary = summarizeIpapi(data);
            if (!summary || !chunkSet.has(summary.ip)) {
              continue;
            }
            saveApiSummary(cache, summary);
            apiRefreshed.add(summary.ip);
            stats.apiBatchResults++;
            if (summary.type === UNKNOWN) {
              const detection = detectionByIp.get(summary.ip);
              logUnknownType(
                detection?.firstIndex || 0,
                "ipapi.is 批量查询",
                data
              );
            }
          }
        } catch (error) {
          for (const ip of chunk) {
            addFailure(
              detectionByIp.get(ip)?.firstIndex || 0,
              "ipapi.is 批量查询",
              error
            );
          }
        }
      });
    }

    const exactMissing = apiMissing.filter((ip) => {
      const lookup = apiCacheLookup(
        cache,
        ip,
        ttlMs,
        partialTtlMs,
        staleTtlMs,
        false
      );
      return (
        !apiRefreshed.has(ip) ||
        !lookup.fresh ||
        !isApiSufficient(lookup.value, options)
      );
    });

    await mapLimit(
      exactMissing,
      Math.min(concurrency, 6),
      async (ip) => {
        const detection = detectionByIp.get(ip);
        const proxyUrl = apiVia === "proxy" ? detection?.proxyUrl || "" : "";
        if (apiVia === "proxy" && !proxyUrl) {
          addFailure(
            detection?.firstIndex || 0,
            "ipapi.is 精确查询",
            "没有可用的 HTTP META 端口"
          );
          return;
        }
        try {
          const data = await exactIpapi(ip, proxyUrl);
          const summary = summarizeIpapi(data);
          if (!summary || summary.ip !== ip) {
            throw new Error("返回 IP 与查询 IP 不一致");
          }
          saveApiSummary(cache, summary);
          stats.apiExact++;
          if (summary.type === UNKNOWN) {
            logUnknownType(
              detection?.firstIndex || 0,
              "ipapi.is 精确查询",
              data
            );
          }
        } catch (error) {
          addFailure(
            detection?.firstIndex || 0,
            "ipapi.is 精确查询",
            error
          );
        }
      }
    );
  } catch (error) {
    addFailure(-1, "IP 元数据阶段", error);
  } finally {
    await stopCore();
  }

  const apiByIp = new Map();
  for (const ip of uniqueIps) {
    const lookup = apiCacheLookup(
      cache,
      ip,
      ttlMs,
      partialTtlMs,
      staleTtlMs,
      false
    );
    if (lookup.value && (lookup.fresh || lookup.stale)) {
      apiByIp.set(ip, lookup.value);
    }
  }

  const rirNeeded = [];
  if (shouldResolveNative) {
    for (const ip of uniqueIps) {
      const api = apiByIp.get(ip);
      if (nativeSource === "auto" && normalizeCC(api?.asnCC)) {
        stats.nativeFast++;
        continue;
      }
      if (nativeSource === "asn") {
        continue;
      }
      const lookup = cacheLookup(
        cache,
        `rir:${ip}`,
        ttlMs,
        staleTtlMs,
        forceApi
      );
      if (!lookup.fresh) {
        rirNeeded.push(ip);
      }
    }
  }

  const vendorNeeded = [];
  if (ripeVendorEnabled && options.showVendor) {
    for (const ip of uniqueIps) {
      if (apiByIp.get(ip)?.org) {
        continue;
      }
      const lookup = cacheLookup(
        cache,
        `vendor:${ip}`,
        ttlMs,
        staleTtlMs,
        forceApi
      );
      if (!lookup.fresh) {
        vendorNeeded.push(ip);
      }
    }
  }

  await Promise.all([
    mapLimit(rirNeeded, Math.min(concurrency, 6), async (ip) => {
      try {
        const cc = await fetchRirCountry(ip);
        if (!cc) {
          throw new Error("未返回注册国家");
        }
        saveCacheEntry(cache, `rir:${ip}`, cc);
        stats.ripeCountry++;
      } catch (error) {
        addFailure(
          detectionByIp.get(ip)?.firstIndex || 0,
          "RIPE 注册国家",
          error
        );
      }
    }),
    mapLimit(vendorNeeded, Math.min(concurrency, 4), async (ip) => {
      try {
        const vendor = await fetchRipeVendor(ip);
        saveCacheEntry(cache, `vendor:${ip}`, vendor);
        stats.ripeVendor++;
      } catch (error) {
        addFailure(
          detectionByIp.get(ip)?.firstIndex || 0,
          "RIPE ASN 商家",
          error
        );
      }
    }),
  ]);

  for (const group of groups) {
    let geo = null;
    const detection = group.detection;
    if (detection?.ip) {
      const apiLookup = apiCacheLookup(
        cache,
        detection.ip,
        ttlMs,
        partialTtlMs,
        staleTtlMs,
        false
      );
      const api =
        apiLookup.value && (apiLookup.fresh || apiLookup.stale)
          ? apiLookup.value
          : null;
      const vendorLookup = cacheLookup(
        cache,
        `vendor:${detection.ip}`,
        ttlMs,
        staleTtlMs,
        false
      );
      const ripeVendor =
        vendorLookup.value && (vendorLookup.fresh || vendorLookup.stale)
          ? vendorLookup.value
          : null;
      const asn = String(api?.asn || ripeVendor?.asn || "").replace(/^AS/i, "");
      const asnLookup = asn
        ? cacheLookup(cache, `asn:${asn}`, ttlMs, staleTtlMs, false)
        : { value: null, fresh: false, stale: false };
      const asnInfo =
        asnLookup.value && (asnLookup.fresh || asnLookup.stale)
          ? asnLookup.value
          : null;
      const rirLookup = cacheLookup(
        cache,
        `rir:${detection.ip}`,
        ttlMs,
        staleTtlMs,
        false
      );
      const rirCC =
        rirLookup.value && (rirLookup.fresh || rirLookup.stale)
          ? normalizeCC(rirLookup.value)
          : "";

      const apiCC = normalizeCC(api?.geoCC || detection.apiCC);
      const traceCC = normalizeCC(detection.traceCC);
      const geoCC =
        geoSource === "cf" ? traceCC || apiCC : apiCC || traceCC;
      const registrationCC =
        nativeSource === "ripe"
          ? rirCC
          : nativeSource === "asn"
            ? normalizeCC(api?.asnCC)
            : normalizeCC(api?.asnCC) || rirCC;
      const org = api?.org || ripeVendor?.org || asnInfo?.org || "";
      const type =
        api?.type && api.type !== UNKNOWN
          ? api.type
          : asnInfo?.type || UNKNOWN;

      geo = {
        ip: detection.ip,
        geoCC,
        vendor: vendorShortFromOrg(org, vendorMaxLength),
        type,
        native:
          !shouldResolveNative
            ? UNKNOWN
            : nativeLabel(geoCC, registrationCC),
      };
    } else if (markFail) {
      geo = fallbackGeo();
    } else {
      stats.failed += group.indices.length;
    }

    if (!geo) {
      continue;
    }
    for (const index of group.indices) {
      const tag = buildName(geo, locals[index], options);
      proxies[index].name = applyMode(
        proxies[index].name,
        tag,
        mode,
        nameLength
      );
    }
  }

  if (options.dedupe) {
    dedupeNames(proxies, nameLength);
  }

  pruneCache(
    cache,
    Math.max(staleTtlMs, ttlMs, hours(720)),
    cacheMaxEntries
  );
  if (cache.dirty) {
    try {
      $.write(JSON.stringify(cache.data), CACHE_KEY);
    } catch (error) {
      addFailure(-1, "写入缓存", error);
    }
  }

  if (debug) {
    info(
      `[NodeRename ${SCRIPT_VERSION}] 总数=${stats.total}, 唯一配置=${
        stats.uniqueNodes
      }, 批内去重=${stats.duplicateSaved}, 出口缓存=${stats.routeCache}, ` +
        `旧出口缓存=${stats.routeStale}, 核心节点=${stats.coreNodes}, ` +
        `不支持=${stats.unsupported}, 实测=${stats.probed}, ` +
        `ipapi自查=${stats.selfOk}/${stats.selfFail}, ` +
        `CF=${stats.traceOk}/${stats.traceFail}, 冲突=${stats.conflicts}, ` +
        `IP缓存=${stats.apiCache}, 批量请求=${stats.apiBatchRequests}, ` +
        `批量结果=${stats.apiBatchResults}, 精确查询=${stats.apiExact}, ` +
        `ASN国家直用=${stats.nativeFast}, RIPE国家=${stats.ripeCountry}, ` +
        `RIPE商家=${stats.ripeVendor}, 失败=${stats.failed}, ` +
        `耗时=${Date.now() - startedAt}ms`
    );
    if (diagnostics.length) {
      info(
        `[NodeRename ${SCRIPT_VERSION}] 诊断：\n${diagnostics.join("\n")}`
      );
    }
    if (failures.length) {
      info(
        `[NodeRename ${SCRIPT_VERSION}] 失败明细：\n${failures.join("\n")}`
      );
    }
  }

  return proxies;
}
