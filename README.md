# CoNLL-U 依存树与非投射子树核验后端

纯本地运行的受限 CoNLL-U 依存树核验服务：TypeScript + Node.js + SQLite（`node:sqlite`，零运行时依赖），只提供 HTTP API 与 CLI，不训练句法模型、不预测词性、不纠正句子。

## 范围与假设

- 只支持从 1 连续编号的整数 token ID 与基本 HEAD 依存列。
- 带连字符的多词编号（`2-3`）与带小数点的空节点（`1.1`）**明确拒绝**，不悄悄跳过。
- 注释行（`#` 开头）与全部十列原文原样保存；DEPS 等列仅保留，不用于构建增强依存图。
- 节点位置按 token ID 决定；标点是普通 token，参与所有位置与结构核验，无任何语言特定例外。
- 不宣称验证全部 CoNLL-U 标准或语义标注质量；规则版本号 `conllu-basic-v1` 随语料保存。

## 环境要求

- Windows 本地，Node.js ≥ 23（使用内置 `node:sqlite` 与 `fetch`），无需 Docker / WSL / 外部服务。

## 构建、测试、启动、演示

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试
npm start          # 启动 HTTP API（默认端口 0 = 自动选择空闲端口，启动时打印实际端口）
npm run demo       # 内置演示：非投射示例 + 多根/环/自指/跨句引用等拒绝用例
```

可配置项（环境变量）：`PORT`（端口，默认 0 即空闲端口）、`DATA_DIR`（数据目录，默认项目内 `data/`）、`DB_PATH`、`MAX_SENTENCES`（默认 10000）、`MAX_TOKENS`（默认 500）。重启后数据库仍在，可继续查询已保存的核验依据。

## 输入格式（十列示例）

句子由空行分隔，每个 token 一行、十个制表符字段（ID FORM LEMMA UPOS XPOS FEATS HEAD DEPREL DEPS MISC）：

```
# sent_id = demo-1
# text = 合法但非投射：HEAD 依次为 3 4 0 3
1	看	看	VERB	_	_	3	dep	_	_
2	一	一	NUM	_	_	4	nummod	_	_
3	电影	电影	NOUN	_	_	0	root	_	_
4	场	场	NOUN	_	_	3	dep	_	_
```

上例中节点 4 的子树位置为 {2, 4}，区间 [2,4] 内缺少 3，因此**合法但非投射**（仍允许保存，与 HEAD 语法错误严格区分）。

## 结构核验规则

依次检查：十列结构 → ID 从 1 连续 → HEAD 为非负整数且不超出本句范围（拒绝跨句引用）→ 根约定（HEAD=0 恰好一个且关系为 `root`；其余 token 不得用 `root`）→ 禁止自指 → 无环 → 所有 token 沿父链可达唯一根。每个错误都带句子号、token ID 与具体引用链（如 `1 -> 2 -> 1`），不合法的图绝不交给投射性算法。

## 投射性核验

在合法树上，对每个节点取含自身的子树位置集合，检查是否构成连续区间；若 `[min, max]` 内存在不属于该子树的 token，则该子树非连续、整树非投射。报告给出全部非连续子树的节点、区间、实际后代、缺口 token 与父链解释。

## CLI 用法

```powershell
node dist/cli.js import demo examples/demo.conllu   # 导入语料（创建版本），输出分类统计
node dist/cli.js list                               # 列出语料版本
node dist/cli.js sentences 1                        # 列出句子及分类 invalid|projective|nonprojective
node dist/cli.js show 1 1                           # 查看原文、注释、token 与诊断
node dist/cli.js check 1 1                          # 结构诊断 + 投射性报告
node dist/cli.js explain 1 1 4                      # 解释节点 4 的子树（后代/区间/缺口/父链）
node dist/cli.js stats 1                            # 三种分类统计
node dist/cli.js export 1 out.conllu                # 导出原文 CoNLL-U
node dist/cli.js revise 1 edits.json                # 修改 HEAD 创建新版本（旧版本与旧报告不变）
node dist/cli.js serve --port 8080                  # 启动 HTTP API
```

`edits.json` 示例：`{"edits":[{"sentence":1,"heads":[3,3,0,3]}], "name":"v2"}`。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 服务信息与规则版本 |
| POST | `/corpora` | 导入语料，body `{name, text}` |
| GET | `/corpora` / `/corpora/:id` | 语料列表 / 详情 |
| GET | `/corpora/:id/sentences?status=` | 句子列表（可按分类过滤） |
| GET | `/corpora/:id/sentences/:idx` | 原文、注释、token、诊断、投射性报告 |
| GET | `/corpora/:id/sentences/:idx/diagnostics` | 结构诊断 |
| GET | `/corpora/:id/sentences/:idx/projectivity` | 投射性报告（非法句返回 `INVALID_SENTENCE`） |
| GET | `/corpora/:id/sentences/:idx/subtree/:tokenId` | 子树解释 |
| GET | `/corpora/:id/stats` | 分类统计 |
| GET | `/corpora/:id/export?format=conllu\|json` | 导出 |
| POST | `/corpora/:id/versions` | 修改 HEAD 创建新版本，body `{edits:[{sentence,heads}]}` |

错误统一为 `{"error":{"code","message","details"}}`。错误码：`FIELD_COUNT`、`MULTIWORD_ID`、`EMPTY_NODE_ID`、`BAD_ID`、`NON_CONTIGUOUS_IDS`、`BAD_HEAD`、`HEAD_OUT_OF_RANGE`、`ROOT_COUNT`、`ROOT_RELATION`、`SELF_LOOP`、`CYCLE`、`DISCONNECTED`、`EMPTY_SENTENCE`、`TOO_MANY_SENTENCES`、`TOO_MANY_TOKENS`、`INVALID_SENTENCE`、`NOT_FOUND`、`BAD_REQUEST`。

## 目录结构

- `src/core/conllu.ts` — 解析与结构校验（含父链/环检测）
- `src/core/projectivity.ts` — 投射性核验与子树解释
- `src/db.ts` — SQLite 持久化、导入、版本修订
- `src/server.ts` — HTTP API
- `src/cli.ts` — 命令行入口
- `src/tests/verify.test.ts` — 测试（含随机树暴力交叉验证）
- `examples/demo.conllu` — 十列输入示例
