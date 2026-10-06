/** CLI 入口：导入、查询、诊断、投射性核验、子树解释、统计、导出、改 HEAD、启动服务、演示。 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_LIMITS,
  SentenceStatus,
  explain,
  exportCorpus,
  getSentence,
  importCorpus,
  listCorpora,
  listRevisions,
  listSentences,
  openDb,
  runProjectivity,
  setHead,
  stats,
} from "./db";
import { startServer } from "./server";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_PATH = process.env.CONLLU_DB ?? path.join(DATA_DIR, "conllu.db");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

export const DEMO_CORPUS = `# 演示 1：合法但非投射。HEAD 依次为 3、4、0、3，根为 3；
# 节点 4 的子树位置为 {2,4}，中间缺少 3，故非投射。
1	甲	甲	PROPN	_	_	3	nsubj	_	_
2	乙	乙	PROPN	_	_	4	nsubj	_	_
3	走	走	VERB	_	_	0	root	_	_
4	来	来	VERB	_	_	3	conj	_	_

# 演示 2：全部连续的投射链 1->2->3->4（根为 4）。
1	我	我	PRON	_	_	2	nsubj	_	_
2	认真	认真	ADV	_	_	3	advmod	_	_
3	阅读	阅读	VERB	_	_	4	xcomp	_	_
4	学习	学习	VERB	_	_	0	root	_	_

# 演示 3：多根，应被拒绝。
1	他	他	PRON	_	_	0	root	_	_
2	走	走	VERB	_	_	0	root	_	_

# 演示 4：环 1->2->1，应被拒绝。
1	甲	甲	NOUN	_	_	2	det	_	_
2	乙	乙	NOUN	_	_	1	det	_	_
3	丙	丙	NOUN	_	_	0	root	_	_

# 演示 5：自指，应被拒绝。
1	丁	丁	NOUN	_	_	1	det	_	_
2	戊	戊	NOUN	_	_	0	root	_	_

# 演示 6：跨句引用（HEAD 超出本句范围），应被拒绝。
1	己	己	NOUN	_	_	9	det	_	_
2	庚	庚	NOUN	_	_	0	root	_	_

# 演示 7：中文词形 + 注释 + 标点，标点作为普通 token 参与核验（投射）。
# sent_id = zh-1
1	我	我	PRON	_	_	2	nsubj	_	_
2	爱	爱	VERB	_	_	0	root	_	_
3	北京	北京	PROPN	_	_	2	obj	_	_
4	。	。	PUNCT	_	_	2	punct	_	_
`;

const USAGE = `用法: node dist/src/cli.js <命令> [参数]
  import <file> --name <名称>     导入 CoNLL-U 语料（UTF-8）
  corpora                         列出语料版本
  sentences <corpusId> [--status invalid|projective|non_projective]
  show <sentenceId>               查看句子原文与树
  diagnose <sentenceId>           查看结构诊断
  check <sentenceId>              运行投射性核验
  explain <sentenceId> <tokenId>  解释某节点的子树
  stats <corpusId>                统计结果
  export <corpusId>               导出 CoNLL-U 文本
  set-head <sentenceId> <tokenId> <head> [deprel]   修改 HEAD（生成新版本）
  revisions <sentenceId>          查看修订历史
  serve [--port N]                启动 HTTP API（默认自动选择空闲端口）
  demo                            导入内置演示语料并展示结果
限制: 句子数 <= ${DEFAULT_LIMITS.maxSentences}，每句 token 数 <= ${DEFAULT_LIMITS.maxTokensPerSentence}
数据库: ${DB_PATH}`;

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(DB_PATH);

  switch (cmd) {
    case "import": {
      const file = args[0];
      const name = arg("--name") ?? path.basename(file ?? "corpus");
      if (!file) throw new Error("缺少文件参数");
      const text = fs.readFileSync(file, "utf8");
      out(importCorpus(db, name, text));
      break;
    }
    case "corpora":
      out(listCorpora(db));
      break;
    case "sentences":
      out(listSentences(db, Number(args[0]), arg("--status") as SentenceStatus | undefined));
      break;
    case "show":
      out(getSentence(db, Number(args[0])));
      break;
    case "diagnose": {
      const s = getSentence(db, Number(args[0]));
      if (!s) throw new Error(`句子 ${args[0]} 不存在`);
      out({ id: s.id, status: s.status, report: s.report });
      break;
    }
    case "check":
      out(runProjectivity(db, Number(args[0])));
      break;
    case "explain":
      out(explain(db, Number(args[0]), Number(args[1])));
      break;
    case "stats":
      out(stats(db, Number(args[0])));
      break;
    case "export":
      process.stdout.write(exportCorpus(db, Number(args[0])));
      break;
    case "set-head":
      out(setHead(db, Number(args[0]), Number(args[1]), Number(args[2]), args[3]));
      break;
    case "revisions":
      out(listRevisions(db, Number(args[0])));
      break;
    case "serve": {
      const port = Number(arg("--port") ?? process.env.PORT ?? 0);
      const server = await startServer(db, port);
      const actual = (server.address() as { port: number }).port;
      console.log(`API 服务已启动: http://127.0.0.1:${actual} （数据库 ${DB_PATH}）`);
      break;
    }
    case "demo": {
      const result = importCorpus(db, `demo-${Date.now()}`, DEMO_CORPUS);
      console.log("== 导入结果 ==");
      out(result);
      const sents = listSentences(db, result.corpusId);
      console.log("\n== 逐句状态 ==");
      out(sents);
      const first = sents[0];
      console.log("\n== 句 1（HEAD 3,4,0,3）投射性核验 ==");
      out(runProjectivity(db, first.id));
      console.log("\n== 句 1 节点 4 的子树解释（位置 {2,4}，缺 3） ==");
      out(explain(db, first.id, 4));
      console.log("\n== 统计 ==");
      out(stats(db, result.corpusId));
      break;
    }
    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`错误 [${e.code ?? "INTERNAL"}]: ${e.message}`);
    process.exitCode = 1;
  });
}
