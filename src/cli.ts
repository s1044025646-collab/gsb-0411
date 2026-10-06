#!/usr/bin/env node
import * as fs from "node:fs";
import { openDb, importCorpus, getSentenceRow, reviseCorpus } from "./db";
import { startServer } from "./server";
import { explainSubtree } from "./core/projectivity";
import { Token } from "./core/types";

function print(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function fail(msg: string, code = 1): never {
  console.error(`错误: ${msg}`);
  process.exit(code);
}

const HELP = [
  "CoNLL-U 依存树/非投射子树核验工具",
  "",
  "用法: node dist/cli.js <命令> [参数]",
  "",
  "命令:",
  "  serve [--port N]                 启动 HTTP API（默认端口 0 = 自动选择空闲端口）",
  "  import <name> <file.conllu>      导入语料（创建新版本），输出统计",
  "  list                             列出所有语料版本",
  "  sentences <corpusId> [status]    列出句子及分类（invalid|projective|nonprojective）",
  "  show <corpusId> <idx>            查看句子原文、注释、token 与诊断",
  "  check <corpusId> <idx>           查看结构诊断与投射性报告",
  "  explain <corpusId> <idx> <tokId> 解释某节点子树（后代/区间/缺口/父链）",
  "  stats <corpusId>                 统计三种分类数量",
  "  export <corpusId> [file]         导出原文 CoNLL-U（默认输出到 stdout）",
  "  revise <corpusId> <edits.json>   按 {edits:[{sentence,heads:[...]}]} 修改 HEAD 并创建新版本",
  "  demo                             运行内置演示（非投射示例 + 各类拒绝用例）",
  "",
].join("\n");

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const pIdx = args.indexOf("--port");
      const port = pIdx >= 0 ? Number(args[pIdx + 1]) : Number(process.env.PORT ?? 0);
      const { port: actual } = await startServer(port);
      console.log(`API 已启动: http://127.0.0.1:${actual}  (规则版本见 GET /)`);
      break;
    }
    case "import": {
      const [name, file] = args;
      if (!name || !file) fail("用法: import <name> <file.conllu>");
      const text = fs.readFileSync(file, "utf-8");
      const db = openDb();
      print(importCorpus(db, name, text));
      break;
    }
    case "list": {
      const db = openDb();
      print(db.prepare("SELECT * FROM corpora ORDER BY id").all());
      break;
    }
    case "sentences": {
      const db = openDb();
      const rows = args[1]
        ? db.prepare("SELECT idx, status FROM sentences WHERE corpus_id = ? AND status = ? ORDER BY idx").all(Number(args[0]), args[1])
        : db.prepare("SELECT idx, status FROM sentences WHERE corpus_id = ? ORDER BY idx").all(Number(args[0]));
      print(rows);
      break;
    }
    case "show":
    case "check": {
      const [cid, idx] = args.map(Number);
      if (!cid || !idx) fail(`用法: ${cmd} <corpusId> <idx>`);
      const db = openDb();
      const row = getSentenceRow(db, cid, idx) as Record<string, string>;
      if (cmd === "show") console.log(row.raw);
      print({
        status: row.status,
        diagnostics: JSON.parse(row.diagnostics),
        projectivity: row.projectivity ? JSON.parse(row.projectivity) : null,
      });
      break;
    }
    case "explain": {
      const [cid, idx, tok] = args.map(Number);
      if (!cid || !idx || !tok) fail("用法: explain <corpusId> <idx> <tokenId>");
      const db = openDb();
      const row = getSentenceRow(db, cid, idx) as Record<string, string>;
      if (row.status === "invalid") fail(`句子 ${idx} 结构不合法: ${row.diagnostics}`);
      print(explainSubtree(JSON.parse(row.tokens) as Token[], tok));
      break;
    }
    case "stats": {
      const db = openDb();
      const rows = db.prepare("SELECT status, COUNT(*) n FROM sentences WHERE corpus_id = ? GROUP BY status").all(Number(args[0]));
      print(rows);
      break;
    }
    case "export": {
      const db = openDb();
      const rows = db.prepare("SELECT raw FROM sentences WHERE corpus_id = ? ORDER BY idx").all(Number(args[0])) as unknown as { raw: string }[];
      const text = rows.map((r) => r.raw).join("\n\n") + "\n";
      if (args[1]) fs.writeFileSync(args[1], text, "utf-8");
      else process.stdout.write(text);
      break;
    }
    case "revise": {
      const [cid, file] = args;
      if (!cid || !file) fail("用法: revise <corpusId> <edits.json>");
      const edits = JSON.parse(fs.readFileSync(file, "utf-8"));
      const db = openDb();
      print(reviseCorpus(db, Number(cid), edits.edits, edits.name));
      break;
    }
    case "demo": {
      const { runDemo } = require("./demo");
      runDemo();
      break;
    }
    default:
      process.stdout.write(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
