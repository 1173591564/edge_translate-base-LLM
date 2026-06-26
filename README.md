# DeepSeek 智能翻译

基于 DeepSeek LLM 的浏览器翻译扩展，采用**语义块翻译** + **稳定性连续采样** + **LLM 驱动格式保持**架构，在翻译质量和页面结构保真之间取得最佳平衡。

## 核心特性

### 一次性完整输入
提取页面全部语义块后一次性发送给 LLM，让模型获得完整上下文，翻译质量远高于逐条碎片翻译。

### 语义块提取
按块级祖先元素（`<p>`, `<h1>`-`<h6>`, `<li>`, `<div>` 等）分组文本节点，而非按 DOM 碎片切割：

```
<p><strong>Bold text</strong> and <a href="#">normal link</a></p>

→ 碎片方式: "Bold text" | "and" | "normal link"     (3 个孤立碎片)
→ 语义块方式: "Bold text and normal link"             (1 个完整语义单元)
```

### LLM 驱动格式保持
对内联元素（`<strong>`, `<em>`, `<a>` 等）使用 `«N»...«/N»` 标记边界，由 LLM 在翻译时自行决定切分位置，确保翻译后页面格式完整：

```
发送: «1»Bold text«/1» «2»and«/2» «3»normal link«/3»
LLM:  «1»粗体文字«/1» «2»和«/2» «3»普通链接«/3»
回填: <strong>粗体文字</strong> 和 <a>普通链接</a>    ✓ 格式保持
```

### 稳定性连续采样
类似称重仪器等待读数稳定后才记录——每 400ms 采样 DOM 变化，连续 3 次稳定后才开始翻译，避免页面还没加载完就提取。

### 空闲感知完成机制
动态页面（SPA、无限滚动）永远有变化，采用 3 秒空闲检测：
- 3 秒无新 DOM 变化 → 标记"翻译完成"
- 新内容出现 → 自动切回"翻译中"继续翻译

### 页面内浮动状态组件
翻译进度实时显示在页面右上角，带 shimmer 流光动画和进度条，自动翻译时无需打开 popup。

## 安装

1. 克隆仓库：
   ```bash
   git clone https://github.com/1173591564/edge_translate-base-LLM.git
   ```

2. 打开浏览器扩展管理页面：
   - Edge: `edge://extensions/`
   - Chrome: `chrome://extensions/`

3. 开启"开发人员模式"

4. 点击"加载解压缩的扩展"，选择项目目录

## 使用

1. 点击扩展图标，输入 DeepSeek API Key 并保存
2. 打开任意英文网页，点击"翻译此页"或开启"自动翻译"
3. 翻译结果直接替换原文，点击"恢复原文"可还原

## 架构

```
content.js     DOM 提取 + 翻译应用 + 浮动组件 + 缓存 + MutationObserver
background.js  API Key 管理 + DeepSeek 流式调用 + 自动翻译触发
popup.*        设置界面（API Key、自动翻译开关、手动翻译按钮）
```

| 文件 | 行数 | 职责 |
|------|------|------|
| content.js | ~640 | 稳定采样 + 语义块提取 + 翻译应用/恢复 + 缓存 + SPA 监听 |
| background.js | ~190 | DeepSeek API 流式调用 + 自动翻译 |
| popup.* | ~250 | 设置 UI |

## 技术栈

- **翻译引擎**: DeepSeek LLM（流式输出）
- **扩展框架**: Chrome Manifest V3
- **存储**: chrome.storage.local（API Key + URL 缓存）
- **动态内容**: MutationObserver + webNavigation
