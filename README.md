# Writable Figma MCP Bridge（Figma 连接器）

> 给**任何 MCP 兼容的 AI 客户端**提供在 Figma 沙箱内执行任意 JS 的通用写入通道 —— 本地、无云服务、默认仅本机可达。
>
> 适用于大多数桌面端 AI 助手，通过标准 MCP 接入后即可读写 Figma 文件。

---

## 一、这个工具解决什么问题

市面上已有的 AI ↔ Figma 方案大多偏**只读**（Figma 官方 MCP、Dev Mode MCP）—— 能解析、能读取，却改不了设计稿。

**Figma 连接器** 的定位是：**通用的、可写入的 Figma 桥接** —— 不绑定某个 AI 产品，任何能发 MCP 请求的客户端都能用；同时自带一个 Figma 插件面板，提供可视化状态和操作。

它解决的核心痛点：

- **AI 能不能改我的设计文件？** 能。通过 `figma_run_js` 在 Figma 沙箱里执行一段 JS，对当前打开的文件做任意读取与写入（创建节点、改样式、绑变量、套组件）。
- **改坏了怎么办？** 每次写入前自动快照文档，任务抛错会自动删除本次新建的节点（撤销式回滚）。
- **怎么告诉 AI 要操作哪个文件？** 在插件面板粘贴 Figma 文件链接并设为「当前链接」，插件轮询时把这个文件标识上报给服务端，Agent 即可据此读写。
- **如何让 AI 跳转到某个节点？** 面板每条链接旁有「瞄准」按钮，一键解析 `node-id`、切换页面、居中放大并选中该节点。

设计理念是 **「本地优先、可审计」**：整个链路只跑在你的机器上（`127.0.0.1`），不依赖任何外部 API Key 或 OAuth，代码量小、可完全审查。

---

## 二、核心特性

- **可写 MCP 桥接**：把 `figma_run_js` 作为可信写入入口暴露给 MCP 客户端。
- **安全写入**：每次任务前快照节点，出错自动回滚本次新建节点。
- **设计系统优先**：内置 `helpers`（设计系统索引、组件导入、变量绑定、样式应用等），避免硬编码。
- **状态可视化**：面板实时显示「等待任务 / 读取中 / 写入中」三种状态（蓝色=写入、绿色=读取）。
- **瞄准按钮**：每条链接一键跳转并选中目标节点（自适应缩放）。
,
- **重复链接提示**：粘贴已有链接时底部浮窗提示「当前链接已存在」，避免误操作。
- **多插件保护**：`GET /health` 列出所有轮询窗口，`FIGMA_WRITER_STRICT=1` 可强制单窗口独占，避免多窗口写错文件。

---

## 三、工作原理

```
AI 客户端 (Claude / WorkBuddy)
        │  MCP (http://localhost:8788/mcp)
        ▼
本地 MCP 服务 (server.mjs)  ── 任务入队
        │
        ▲ 轮询 GET /plugin/job
        │
Figma 插件 (code.js 运行在 Figma 沙箱)  ── 在 Figma 内执行读/写
        │ 结果 POST /plugin/result
        ▼
本地 MCP 服务  ── 把结果回传给 AI
```

1. AI 通过 MCP 调用服务端（`http://localhost:8788/mcp`）。
2. 服务端把任务入队。
3. Figma 插件轮询 `/plugin/job`，取出任务并在 Figma 内执行（只允许操作**当前打开的文件**）。
4. 插件通过 `POST /plugin/result` 回传结果给 AI。

> ⚠️ 插件的真实读写边界是「Figma 当前打开的文档」。面板选中的链接用于标识「声明在操作哪个文件」并上报给服务端/AI，两者不一致时读写仍以当前打开的文件为准。

---

## 四、环境要求

- **Node.js ≥ 18**（运行本地 MCP 服务必需，[nodejs.org](https://nodejs.org) 下载安装）。
- **Figma 桌面端**（Web 版不支持本地插件/dev 模式）。
- 无需 API Key、无需 OAuth、无需联网（服务只跑在 `127.0.0.1`）。

## 五、快速开始

### 1. 启动本地服务

**方式 A：命令行（推荐，便于看日志）**

```bash
cd writable-figma-mcp-bridge
node server.mjs
```

**方式 B：双击启动器**

- macOS：双击仓库里的 `start.command`
- Windows：双击 `start.bat`

> 双击脚本会以「最小化/后台」方式启动 `node server.mjs`，无需敲命令。前提是本机已安装 Node.js。

启动后默认 `127.0.0.1:8788`，仅本机可达，默认暴露唯一工具 `figma_run_js`。

需要调试、临时暴露全部旧工具时（命令行方式）：

```bash
FIGMA_WRITER_RUN_JS_ONLY=0 node server.mjs
```

### 2. 在 Figma 中手动安装插件（重点）

Figma 插件需要手动导入本仓库的 `manifest.json`，步骤如下：

1. 打开 **Figma 桌面端**（官方支持 macOS / Windows）。
2. 打开任意一个 Figma 设计文件。
3. 顶部菜单：`Plugins（插件）` → `Development（开发）` → `Import plugin from manifest…（从清单导入插件…）`。
4. 在文件选择框里选中本仓库的 **`manifest.json`**（位于 `writable-figma-mcp-bridge/manifest.json`）。
5. 菜单 `Plugins（插件）` → `Development（开发）` → `Writable Figma MCP Bridge` 运行它。
6. 在弹出的面板点击 **「开始」**，让它连上本地服务。

> 只要「开始」亮起、状态显示「等待任务…」即说明插件已接入。之后 AI 通过 MCP 下发的所有读写任务都会作用在你当前打开的这个文件上。

### 3. 配置 MCP 客户端（以 WorkBuddy / Claude 为例）

本服务是常驻 HTTP 服务，MCP 配置应指向 **Streamable HTTP** 端点：

```json
{
  "mcpServers": {
    "figma-writer": {
      "type": "http",
      "url": "http://localhost:8788/mcp"
    }
  }
}
```

- WorkBuddy：打开左侧栏「专家」→「自定义连接器」写入 `~/.workbuddy/mcp.json`（注意是 `.workbuddy` 无点前缀的 `mcp.json`）。
- Claude 桌面端：可直接运行仓库里的 `node install_claude_3p_connector.mjs`，会自动写入桌面端配置（需重启 Claude）。

---

## 六、功能说明

### 链接管理
- 在顶部输入框粘贴 Figma 文件链接，点「添加」即可加入下方列表。
- 每行可「选中」作为当前活跃链接（轮询时上报给服务端），并带「瞄准」按钮。
- 粘贴重复链接时，底部会滑出红色浮窗提示「当前链接已存在」。

### 瞄准按钮（Aim）
每行链接右侧的十字准星图标：点击后解析链接里的 `node-id`，切换到该节点所在页面，自动居中放大并选中它。若链接指向其他文件（当前打开文件里找不到该节点），会明确提示「链接可能指向其他文件」。

### 状态指示
面板右上角状态点随任务变化：
- **灰色**「等待任务…」：空闲
- **蓝色**「当前 AI 写入中…」：检测到写操作
- **绿色**「当前 AI 读取中…」：检测到读操作

### 自动回滚
每次 `figma_run_js` 前会快照文档节点；若执行抛错，自动删除本次新建的节点并报告回滚数量。对已有节点的修改不自动回滚（可用 Figma 撤销 `Cmd/Ctrl+Z`）。

---

## 七、安全

| 项 | 说明 |
|---|---|
| 默认无鉴权 | `FIGMA_WRITER_TOKEN` 为空时，本机任意进程都能访问 `/mcp` 并执行 `figma_run_js`（即在你打开的 Figma 文件里跑任意 JS）。 |
| 绑定地址 | 默认 `127.0.0.1`，仅本机可达。**切勿**将 `HOST` 设为 `0.0.0.0` 暴露到公网。 |
| 建议 | 在共享/公共机器上务必设置 `FIGMA_WRITER_TOKEN`，否则任意本机进程都可调用。 |
| 插件沙箱 | Figma 插件运行在 Figma 沙箱内，无法读取你电脑上的密码、文件或其他应用凭证，风险边界仅限「当前打开的 Figma 文档」。 |

---

## 八、环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8788` | MCP 服务 HTTP 端口。 |
| `HOST` | `127.0.0.1` | 绑定地址，保持回环地址即可。 |
| `FIGMA_WRITER_RUN_JS_ONLY` | `1` | `1` 仅暴露 `figma_run_js`；`0` 暴露全部旧工具。 |
| `FIGMA_WRITER_TOKEN` | 空 | 设置后 `/mcp` 与 `/plugin/*` 需校验该 token（Bearer 头或 `?token=`）。 |
| `FIGMA_WRITER_STRICT` | 空 | `1` 开启单窗口独占模式，避免多窗口冲突。 |

---

## 九、可用的 helpers（在 `figma_run_js` 内可用）

`figma_run_js` 会注入：`figma`（Figma API）、`args`（结构化参数）、`helpers`（安全助手）。

- `helpers.loadFont(fontName)`
- `helpers.ensureTextFontLoaded(textNode, fallbackFontName)`
- `helpers.paint(value, theme)` / `helpers.hexToRgb(hex)` / `helpers.rgbToHex(rgb)`
- `helpers.normalizeHex(value, theme)`
- `helpers.findVariable(nameOrKey, resolvedType)`
- `helpers.indexDesignSystem(options)`
- `helpers.cloneReferenceNode(selector, options)`
- `helpers.importComponentByName(nameOrKey, options)`
- `helpers.applyTextStyle(textNode, styleName)`
- `helpers.applyPaintStyle(node, styleName, field)`
- `helpers.bindVariable(node, field, variableName, fallbackValue, resolvedType)`
- `helpers.bindFillVariable(node, variableName,  fallbackValue)` / `helpers.bindStrokeVariable(...)`
- `helpers.findNodes(selector)` / `helpers.getNode(id)`
- `helpers.summarizeNode(node, depth)` / `helpers.inspectNodeAppearance(node)`
- `helpers.validateCanvas(options)`

> 在 `figma_run_js` 的代码里避免使用可选链 `?.` 与空值合并 `??`，Figma 插件运行时可能拒绝。

---

## 十一、许可

MIT License。
