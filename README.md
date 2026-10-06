# CoNLL-U 依存树与非投射子树核验后端

受限 CoNLL-U 依存树核验服务：TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`），仅提供 HTTP API 与 CLI，无前端。Windows 本地直接运行，不依赖 Docker / WSL / 付费服务 / 外部在线 API。

## 范围与假设

- 输入为 UTF-8 文本，句子由空行分隔，每个 token 为**十列制表符**字段（ID FORM LEMMA UPOS XPOS FEATS HEAD DEPREL DEPS MISC），所有字段原文保留。
- 仅支持从 1 连续编号的整数 token ID 与基本 HEAD 依存列；带连字符的多词编号（`1-2`）与带小数点的空节点（`3.1`）**明确拒绝**，不悄悄跳过。
- 注释行（`#` 开头）原样保存并随导出还原。
- DEPS 等字段仅原文保留，**不**用于建立增强依存图；不训练句法模型、不预测词性、不纠正句子；不宣称验证全部 CoNLL-U 标准或语义标注质量。
- 节点位置完全由 token ID 决定（不按词形或数据库行序）；标点是普通 token，参与全部位置与结构核验，无任何语言特定例外。
- 数量限制：句子数 <= 10000，每句 token 数 <= 500（`src/db.ts` 中 `DEFAULT_LIMITS` 可调）。

## 结构核验规则

依次检查：十列结构 -> 编号连续（1..n）-> HEAD 范围（0..n，越界即拒绝跨句引用）-> 根约定（HEAD=0 恰好一个且关系为 `root`，其余 token 不得自指、不得用 `root` 关系）-> 无环且所有节点沿父链到达唯一根。结构错误给出错误码、token ID 与具体引用链（如环 `1 -> 2 -> 1`），不合法图不会交给投射性算法。

## 投射性判定

对每个节点取包含自身的子树 token 位置集合，若 `[min, max]` 区间内存在不属于该子树的 token（缺口），该子树非连续，整树为**合法但非投射**。报告给出全部非连续子树的区间、实际后代、缺口 token 与父链解释。根的子树必覆盖整句，叶子子树自然连续。合法但非投射的树允许保存，与 HEAD 语法错误严格区分。

句子三态：`invalid`（结构非法）、`projective`（合法投射）、`non_projective`（合法非投射）。批量导入保留坏句诊断。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # 构建并运行全部测试（node:test）
npm start         # 启动 HTTP API（默认自动选择空闲端口）
npm run demo      # 导入内置演示语料并展示核验结果
```

数据库文件保存在项目内 `data/conllu.db`（可用环境变量 `CONLLU_DB` 覆盖），重启后可继续查询已保存的核验依据。

## 十列输入示例

```conllu
# sent_id = demo-1
1	甲	甲	PROPN	_	_	3	nsubj	_	_
2	乙	乙	PROPN	_	_	4	nsubj	_	_
3	走	走	VERB	_	_	0	root	_	_
4	来	来	VERB	_	_	3	conj	_	_
```

HEAD 依次为 3、4、0、3，根为 3；节点 4 的子树位置为 {2, 4}，中间缺少 3，因此**合法但非投射**。`examples/demo.conllu` 还包含全连续投射链、多根、环、自指、跨句引用（均被拒绝）及中文词形 + 注释 + 标点句。

## CLI

```powershell
node dist/src/cli.js import examples/demo.conllu --name demo
node dist/src/cli.js corpora
node dist/src/cli.js sentences 1 --status non_projective
node dist/src/cli.js show 1            # 原文与树
node dist/src/cli.js diagnose 3        # 结构诊断（含引用链）
node dist/src/cli.js check 1           # 运行投射性核验
node dist/src/cli.js explain 1 4       # 解释节点 4 的子树（区间/后代/缺口/父链）
node dist/src/cli.js stats 1
node dist/src/cli.js export 1
node dist/src/cli.js set-head 1 2 3    # 修改 HEAD，生成新修订版本，旧报告不变
node dist/src/cli.js revisions 1
node dist/src/cli.js serve --port 8080 # 省略 --port 时自动选择空闲端口
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/corpora` | 导入语料版本，body `{name, text}` |
| GET | `/corpora` / `/corpora/:id` | 列出 / 查看语料（含规则版本与统计） |
| GET | `/corpora/:id/sentences?status=` | 按句查询（可按三态过滤） |
| GET | `/corpora/:id/stats` | 统计结果 |
| GET | `/corpora/:id/export` | 导出 CoNLL-U 文本 |
| GET | `/sentences/:id` | 句子原文与树 |
| GET | `/sentences/:id/diagnostics` | 结构诊断 |
| GET/POST | `/sentences/:id/projectivity` | 查看 / 运行投射性核验 |
| GET | `/sentences/:id/subtree/:tokenId` | 解释子树（区间、后代、缺口、父链） |
| POST | `/sentences/:id/head` | 修改 HEAD `{tokenId, head, deprel?}`，生成新版本 |
| GET | `/sentences/:id/revisions` | 修订历史（旧报告不可变） |

错误响应统一为 `{"error": {"code", "message"}}`，错误码：`PARSE_ERROR`、`ID_SEQUENCE`、`HEAD_RANGE`、`ROOT_COUNT`、`ROOT_RELATION`、`SELF_HEAD`、`CYCLE`、`DISCONNECTED`、`LIMIT_EXCEEDED`、`NOT_FOUND`、`VALIDATION_ERROR`。HTTP 状态：400 参数错误 / 404 不存在 / 413 超限 / 422 语义校验失败。

API 与 CLI 共用同一套 `src/db.ts` 实现，句子分类与解释结果一致。

## 已知限制

- 仅覆盖基本 HEAD 依存树，不解析 DEPS 增强图、不验证 FEATS/MISC 内容。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能。
- 单进程服务，无鉴权，面向本机使用。
