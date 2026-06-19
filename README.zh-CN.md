# Sporttery Odds API（体彩竞彩足球赔率 API）

[English](README.md) · **简体中文**

一个 **Cloudflare Worker REST API + 本地 MCP 服务**,实现一个干净、可被 agent 调用的
竞彩足球赔率服务。它提供**最新赔率**,并**纯粹基于赔率推导**一切——隐含/去水概率、
返还率、真实赔率、相对参考的凯利指数/价值,以及完整的单关/过关奖金计算。

```
┌── 实时赔率 ───────────────┐   ┌── 纯计算（不依赖上游）──────────────────┐
│ GET /api/matches          │   │ POST /api/derive   赔率推导               │
│ GET /api/match/:id        │   │ POST /api/value    凯利指数/价值          │
└───────────────────────────┘   │ POST /api/parlay   单关/过关奖金          │
                                 │ GET  /api/parlay/types · GET /api/meta   │
                                 └──────────────────────────────────────────┘
```

- **面向 agent**:JSON 进 / JSON 出、开放 CORS、自描述的 `/api/meta`、可选的 **API Key 鉴权**,
  外加一个把同等能力作为工具暴露的本地 **MCP 服务**。
- **纯函数、已测试**:全部推导/过关逻辑都在零依赖模块里,配 25 个单元测试,无需构建(`npm test`)。
- **简洁数据通道**:每数据中心 Cache → 上游(可选经 `UPSTREAM_PROXY` 转发中继)。本地 MCP
  服务直连上游。

> ⚠️ **地域封锁。** 上游做了地域限制,对数据中心 IP(含 Cloudflare)返回 HTTP **567**。要让部署后的
> Worker 提供实时赔率,需把 `UPSTREAM_PROXY` 设为一个能访问上游的转发中继。当运行环境本身可直连上游
> (本地开发,或 MCP 服务)时则无需代理。计算类端点(`derive`/`value`/`parlay`)不依赖上游,任何
> 地方都能用。

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [架构与数据流](#架构与数据流)
- [鉴权](#鉴权)
- [REST 端点](#rest-端点)
- [赔率推导（公式）](#赔率推导公式)
- [盘口与 outcome code](#盘口与-outcome-code)
- [过关规则](#过关规则)
- [MCP 本地服务](#mcp-本地服务)
- [部署](#部署)
- [配置](#配置)
- [缓存](#缓存)
- [未来：实时 WebSocket 流](#未来实时-websocket-流)
- [开发与测试](#开发与测试)
- [数据源](#数据源)
- [爬虫协议（robots）](#爬虫协议robots)
- [免责声明](#免责声明)

---

## 快速开始

需要 **Node ≥ 22.6**(用于 `--experimental-strip-types`;测试与脚本直接跑 TypeScript,无构建步骤)。

```bash
npm install
npm test                  # 25 个单元测试（推导/解析/过关/标签），无网络
npm run dev               # wrangler dev → http://localhost:8787
curl http://localhost:8787/api/matches | jq '.data.matches[0]'
```

当 Worker 能直连上游时(如本地开发),`/api/matches` 直接拉取(`source: upstream`)。

---

## 项目结构

```
SportteryAPI/
├── src/                     # Cloudflare Worker
│   ├── index.ts             # 路由 / HTTP 入口,全部 REST 端点
│   ├── auth.ts              # API Key 鉴权
│   ├── derive.ts    ✅纯函数  # 赔率推导：隐含/去水概率、返还率、真实赔率、凯利
│   ├── parlay.ts    ✅纯函数  # 单关/过关 M串N 表 + 奖金计算
│   ├── labels.ts    ✅纯函数  # 解码 had/hhad/crs/ttg/hafu outcome code
│   ├── parse.ts     ✅纯函数  # 原始上游 JSON → 标准化 + 已推导的 Match[]
│   ├── upstream.ts          # Cache API → 上游拉取（可选 UPSTREAM_PROXY）
│   ├── stream.ts            # OddsStream Durable Object（未来 WebSocket）
│   ├── env.ts / http.ts / types.ts
├── mcp/                     # 本地 stdio MCP 服务
│   ├── server.ts            # MCP 工具（get_matches、derive_odds、calc_parlay…）
│   └── sporttery.ts         # node 侧体彩客户端（缓存 + 可选代理）
├── scripts/
│   ├── smoke.ts             # REST 冒烟测试（BASE=… node …）
│   ├── mcp-smoke.ts         # MCP stdio 冒烟测试（npm run mcp:smoke）
│   └── refresh-sample.ts    # 刷新 sample.json（npm run refresh-sample）
├── test/                    # 25 个 node:test 单元测试（无网络）
├── sample.json              # 抓取的上游样本（离线测试用）
├── .env.example             # 环境变量模板（MCP 代理 / smoke key）
├── wrangler.jsonc.example   # 配置模板——复制为 wrangler.jsonc
├── .mcp.json                # Claude Code 项目级 MCP 注册
└── README.md / README.zh-CN.md
```

`✅纯函数` 模块**不含任何 Cloudflare 依赖**,用 Node 的类型擦除直接做单元测试,被 Worker 与
MCP 服务共享。

---

## 架构与数据流

```
 agent / 浏览器 ──HTTP（+ API Key）──▶ Worker（index.ts）
                                         ├─ /api/matches ─▶ Cache API ─▶ 上游 ─┐
                                         ├─ /api/derive|value|parlay ─▶ 纯计算  │
                                         └─ 鉴权（auth.ts）                     │
                                                 上游（可选 UPSTREAM_PROXY）     ▼
                                                           webapi.sporttery.cn
 本地 MCP（mcp/server.ts）─▶ 直连上游 ─▶ 纯计算
```

Worker 按需拉取赔率(由每数据中心 Cache 削峰)。运行环境可直连上游时直接拉取;被地域封锁的全球边缘则需要 `UPSTREAM_PROXY`。

---

## 鉴权

可选的 API Key 鉴权,保护 `/api/*` 与 `/stream`;`/` 与 `/health` 保持开放。

- **默认关闭**——未配置 `API_KEY` 时所有端点开放(方便本地开发)。
- **开启**:设置 `API_KEY` 密钥(单个,或逗号分隔多个):
  ```bash
  echo "key1,key2" | npx wrangler secret put API_KEY      # 生产
  # 本地开发：在 .dev.vars 里写 API_KEY=...
  ```
- **携带 Key** 的三种方式:
  - `Authorization: Bearer <key>`
  - `X-API-Key: <key>`
  - `?key=<key>`(WebSocket 客户端用)
- 缺失/错误 → `401`。Key 比较为常数时间。

```bash
curl -H "Authorization: Bearer key1" http://localhost:8787/api/matches
```

---

## REST 端点

Base URL:`http://localhost:8787`(本地)或 `https://sporttery-api.<你的子域名>.workers.dev`(线上)。
所有响应为 `{ "success": true, "data": … }` 或 `{ "success": false, "error": "…" }`。CORS 开放(`*`)。
配置了 API_KEY 时,`/api/*` 需要携带 key。

### `GET /api/matches` — 最新赔率 + 衍生指标
查询参数(均可选):`pools`(`had,hhad,crs,ttg,hafu` 逗号分隔)、`date`(`260619`)、`league`(子串)、`matchId`。

```bash
curl "http://localhost:8787/api/matches?pools=had,hhad" -H "X-API-Key: $KEY"
```
```jsonc
{
  "success": true,
  "data": {
    "matchCount": 12, "pools": ["had","hhad"], "source": "upstream",
    "matches": [{
      "matchNumStr": "周五029",
      "home": { "abbName": "美国" }, "away": { "abbName": "澳大利亚" },
      "markets": {
        "had": {
          "poolNameZh": "胜平负",
          "overround": 1.1294, "returnRate": 0.8854, "margin": 0.1146,
          "outcomes": [
            { "key":"home","labelZh":"主胜","odds":1.44,"trend":"down",
              "impliedProb":0.6944,"noVigProb":0.6149,"fairOdds":1.6264 }
          ]
        }
      }
    }]
  }
}
```

### `GET /api/match/:matchId` — 按 matchId 取单场（全部盘口）

### `POST /api/derive` — 从赔率推导（无状态）
Body:`{ "odds": [1.44, 3.90, 5.60] }` 或 `{ "h":1.44, "d":3.90, "a":5.60 }`。任意 N 路盘口均可。

### `POST /api/value` — 凯利指数 / 相对参考赔率的价值
Body:`{ "offered":[2.10,3.40,3.80], "reference":[2.00,3.50,4.00], "labels":["主胜","平","主负"] }`。
参考赔率集会被去水成「真实概率」,给每个 outcome 打分:`kelly`(= 赔率×参考概率)、`ev`、`kellyFraction`、`isValue`。

### `POST /api/parlay` — 单关 / 过关奖金计算
```jsonc
{
  "legs": [ { "odds": 1.44 }, { "odds": 2.10 }, { "odds": 3.30, "result": "void" } ],
  "passType": "3串1",     // "单关"、"M串N" 标签、省略(= N串1),或 "folds":[2,3]
  "multiplier": 2          // 倍数，默认 1
}
```
返回 `bets`(注数)、`totalStake`、`maxPayout`/`maxPayoutCapped`、`realizedPayout`(按每注 `result`)、`byFold`、`capped`(500万封顶)。

### `GET /api/parlay/types` — 完整 M串N 对照表(`?matches=4` 过滤)
### `GET /api/meta` — 玩法标签、过关表、公式、鉴权与数据源说明
### `GET /health` · `GET /` — 存活探针 / 端点索引(无需鉴权)

> 💡 Windows 上发送含中文的请求体请用**文件**(`--data-binary @body.json`),别用内联 `-d`,
> 否则像 `串` 这样的字符会被命令行代码页弄乱。

---

## 赔率推导（公式）

对一个 N 路盘口,十进制赔率 `o_i`:

| 指标 | 公式 |
|---|---|
| 隐含概率(含水) | `1 / o_i` |
| 总概率 overround | `S = Σ(1/o_i)` |
| **返还率**(RTP) | `1 / S` |
| 利润率(抽水) | `1 − 1/S` |
| 去水真实概率 | `(1/o_i) / S` |
| 真实赔率 | `1 / 去水概率 = o_i × S` |
| 凯利指数 | `o_i × p_ref_i`(需外部参考概率) |
| EV 期望值 | `p_ref_i × o_i − 1` |

单一赔率集无法得到有意义的凯利指数(会退化为返还率),所以 `/api/value` 需要一组**参考**赔率。

---

## 盘口与 outcome code

| 盘口 | 名称 | Outcomes |
|---|---|---|
| `had` | 胜平负(无让球) | `h`/`d`/`a` → 主胜 / 平 / 主负 |
| `hhad` | 让球胜平负 | `h`/`d`/`a`,`goalLine` 加到**主队**比分判定 |
| `crs` | 比分 | `sHHsMM` = `主:客`;`s1sh`/`s1sd`/`s1sa` = 胜其它/平其它/负其它 |
| `ttg` | 总进球 | `s0`…`s6` 精确;**`s7` = 7+** |
| `hafu` | 半全场 | 9 个 code,首字符=半场、次字符=全场(如 `ha` = 胜/负) |

**趋势**(`up`/`flat`/`down`)由体彩每个赔率的变化标志推导而来。

---

## 过关规则

- 单注金额 = **2 元**;单关 = `2 × 倍数 × 赔率`;M串N 每注 = `2 × 倍数 × Π(赔率)`。
- "M串N" 的注数(`bets`)= 所选 fold 尺寸上的 `Σ C(M, size)`。
- 单张彩票封顶 **5,000,000 元**;混合过关最大关数 = 所选玩法里最小的关数限制(木桶原则;had/hhad = 8,crs/ttg/hafu = 6)。

| 场数 M | 玩法（label → 注数） |
|---|---|
| 2 | 2串1 |
| 3 | 3串1, 3串3, 3串4 |
| 4 | 4串1, 4串4, 4串5, 4串6, 4串11 |
| 5 | 5串1, 5串5, 5串6, 5串10, 5串16, 5串20, 5串26 |
| 6 | 6串1, 6串6, 6串7, 6串15, 6串20, 6串22, 6串35, 6串42, 6串50, 6串57 |
| 7 | 7串1, 7串7, 7串8, 7串21, 7串35, 7串120 |
| 8 | 8串1, 8串8, 8串9, 8串28, 8串56, 8串70, 8串247 |

---

## MCP 本地服务

把实时赔率 + 推导 + 过关引擎作为工具暴露给 MCP 宿主(Claude Desktop / Claude Code)。它在
**本地运行**,直接从你的网络拉取上游(不受边缘地域封锁、无需代理),复用已测试的 `src/*` 模块。

**工具**:`get_matches`、`get_match`、`derive_odds`、`compare_value`、`calc_parlay`、`list_parlay_types`、`get_meta`。

```bash
npm run mcp:smoke    # 拉起服务、列工具、调几个
```

**Claude Code** — 项目里已带 `.mcp.json`;重开项目并批准 `sporttery-odds`。或全局注册:
```bash
claude mcp add sporttery-odds -- \
  node --no-warnings --experimental-strip-types /绝对路径/SportteryAPI/mcp/server.ts
```

**Claude Desktop** — 加到 `%APPDATA%\Claude\claude_desktop_config.json`:
```jsonc
{
  "mcpServers": {
    "sporttery-odds": {
      "command": "node",
      "args": ["--no-warnings", "--experimental-strip-types",
               "C:/绝对路径/SportteryAPI/mcp/server.ts"]
    }
  }
}
```
若宿主需要代理才能访问体彩,在 `.env` 里设置 `SPORTTERY_PROXY`。需要 Node ≥ 22.6。

---

## 部署

```bash
npx wrangler login
cp wrangler.jsonc.example wrangler.jsonc                  # 按需编辑
echo "你的强密钥" | npx wrangler secret put API_KEY        # 开启鉴权（推荐）
npm run deploy
```

要让全球边缘也能拉到实时赔率,设置一个能访问上游的转发中继:
```bash
# 在 wrangler.jsonc → vars 里：  "UPSTREAM_PROXY": "https://my-relay.example/"
npm run deploy
```
不设 `UPSTREAM_PROXY` 时,部署后的 Worker 会被封锁(`/api/matches` → 502);计算端点照常可用。
`wrangler.jsonc` 已 gitignore——提交 `wrangler.jsonc.example`。密钥放在 `.dev.vars` / `wrangler secret put`。

---

## 配置

**Worker** — `wrangler.jsonc` 里的 `vars`(密钥用 `.dev.vars` / `wrangler secret put`):

| 变量 | 默认 | 含义 |
|---|---|---|
| `DEFAULT_POOLS` | `hhad,had,crs,ttg,hafu` | `/api/matches` 默认返回的盘口（Worker 始终拉取全部盘口) |
| `CACHE_TTL_SECONDS` | `30` | 每数据中心 Cache API TTL |
| `UPSTREAM_PROXY` | _(未设)_ | 转发代理 URL 前缀,经可访问上游的中继绕开地域封锁 |
| `API_KEY` | _(密钥)_ | 逗号分隔的 API Key;未设 = 关闭鉴权 |

**Node 侧**(MCP / smoke)— 环境变量,可从 `.env` 加载:

| 变量 | 默认 | 含义 |
|---|---|---|
| `SPORTTERY_PROXY` | _(未设)_ | MCP 拉体彩用的 HTTP 代理(也认 `HTTPS_PROXY`) |
| `API_KEY` | _(未设)_ | REST 冒烟测试携带的 key |
| `BASE` | `http://localhost:8787` | 冒烟测试目标 |

**代理**——`SPORTTERY_PROXY` 是普通 HTTP 代理(clash/v2ray),经 undici 应用到 node 侧拉取;
`UPSTREAM_PROXY` 是给 Worker 的**URL 前缀**(Worker 不能用 CONNECT 代理),指向一个透明的、可访问上游的转发中继。

---

## 缓存

`/api/matches` 在 `data.source` 里报告由哪一层服务:

1. **Cache API**(`edge-cache`)— 每数据中心、`CACHE_TTL_SECONDS`(默认 30s)。削平突发,每窗口最多打上游一次。
2. **上游**(`upstream`)— Cache 未命中时拉取(可选经 `UPSTREAM_PROXY`)。

---

## 未来：实时 WebSocket 流

`src/stream.ts` 实现了 `OddsStream`——一个可休眠的 Durable Object,把赔率差分扇出给 WebSocket
客户端。启用:取消注释 `wrangler.jsonc` 里的 `durable_objects`、`migrations`、`triggers.crons`
(DO 用 `new_sqlite_classes`),然后部署。客户端连接 `wss://<worker>/stream?pools=had,hhad&key=<API_KEY>`。

---

## 开发与测试

```bash
npm test           # 25 个单元测试（node:test，无网络）
npm run typecheck  # tsc --noEmit，覆盖 src/
npm run dev        # 本地 Worker
npm run mcp:smoke  # MCP 服务冒烟测试
BASE=http://localhost:8787 API_KEY=$KEY node --experimental-strip-types scripts/smoke.ts
npm run refresh-sample   # 从线上上游刷新 sample.json
```

无构建步骤:TypeScript 经 `node --experimental-strip-types` 运行,Worker 由 Wrangler/esbuild 打包。

---

## 数据源

本项目是一个**非官方**的数据读取器,不托管、不生成、也不拥有任何彩票数据。

- **上游接口:** `https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry`
- 这是支撑官方竞彩赔率计算器页面(`https://m.sporttery.cn/mjc/jsq/zqspf/`)的**未公开文档的公开 Web API**。
- 所有赛程、赔率、赛果及相关数据,以及全部相关知识产权,均归 **中国体育彩票 / China Sports Lottery（sporttery.cn）** 所有。数据由国家体育总局体育彩票管理中心发布,运营方为中体彩彩票运营管理有限公司。网站备案:京ICP备09045816号。
- 本项目**仅读取上游 JSON 并对其进行转换**,输出派生指标。本项目不主张对底层数据的任何所有权,不构成任何官方背书,也不保证数据准确。底层数据的再分发权利属于权利人,而非本项目或其使用者。

---

## 爬虫协议（robots）

我们对相关主机直接核查了 sporttery 的 `robots.txt`(原始响应头与正文)。

- **`https://www.sporttery.cn/robots.txt`** —— 存在(HTTP 200)。仅有一组 `User-agent: *`,包含五条基于扩展名的 `Disallow` 规则:`/*.pdf$`、`/*.js$`、`/*.json$`、`/*.php$`、`/*.mp4$`。**没有** `Allow`、**没有** `Crawl-delay`、**没有** `Sitemap`。
- **`https://m.sporttery.cn/robots.txt`** —— 不存在(HTTP 404)。无任何指令。
- **`https://webapi.sporttery.cn/robots.txt`**(即 API 主机)—— 根本不提供 `robots.txt`;请求只会返回腾讯云 EdgeOne WAF 拦截页(HTTP 403 / 567)。

**这对本项目意味着:**

- 本项目只调用**单一 JSON API 接口**(`/gateway/jc/football/getMatchCalculatorV1.qry`),**不**抓取 HTML 页面,也**不**对站点进行爬取。
- `robots.txt` 是**按主机(per-host)**生效的。唯一发布的 robots 文件位于 `www.sporttery.cn`,与 API 主机 `webapi.sporttery.cn` 是**不同的主机**,因此并不约束该 API。即便如此,该文件的 `Disallow` 规则是锚定到行尾的扩展名模式(`.pdf/.js/.json/.php/.mp4`),像 `/gateway/jc/football/...` 这样的路径也不会命中。
- **没有 `Disallow` 并不等于获得许可。** API 主机由 WAF 保护,会主动挑战并拦截自动化请求——这是比 `robots.txt` 更强的访问控制信号。

**本项目采取的合理使用措施:**

- 设置较短的缓存 TTL,重复读取尽量走缓存而非反复请求上游。
- 低请求频率;不做批量或并发抓取。
- 在接口前使用**单一代理 / 中继**,而非大规模爬虫集群。
- 遵守任何速率限制,遇到错误时退避。
- **遇到 4xx/5xx 或 WAF 拦截响应即停止**,不做激进重试。

如果你判断 sporttery 的任何 `robots.txt` 规则(或站点条款)禁止访问你打算访问的路径,请**予以尊重**,并在继续之前取得中国体育彩票的授权。如有疑问,请勿抓取。

---

## 免责声明

- 本项目**与中国体育彩票 / China Sports Lottery（sporttery.cn）及其任何运营方均无隶属、授权或背书关系**。所有商标与数据归各自权利人所有。
- 本项目**仅供信息与技术用途**,**不构成投注建议**,不是预测服务,也不对任何结果作出保证。
- 数据按**「现状」提供,不附带任何保证**,不保证准确性、完整性、时效性或可用性。上游随时可能变更、中断或返回错误。官方赛程、赔率、赛果及兑奖以中国体育彩票官方渠道为准。
- **博彩涉及资金风险。** 任何彩票或投注行为**仅限年满 18 周岁的成年人**,且仅限在你所在司法辖区合法的情况下进行。请**理性购彩**。
- **你需自行负责**遵守 sporttery 的条款(包括其《法律声明》,其中限制复制/派生使用,并禁止以「非正当手段」访问),并遵守所有适用的当地法律。使用本项目风险自负。
- 本声明**不构成法律意见**。如果你是权利人,希望对本项目(或其对你接口的访问)进行修改或下线,请联系维护者,将**应要求予以移除**。
