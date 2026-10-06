import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, importCorpus, getSentence, setHead, listRevisions, exportCorpus, explain, stats } from "../src/db";
import { startServer, serverPort } from "../src/server";
import { DEMO_CORPUS } from "../src/cli";

function tmpDb() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "conllu-")), "t.db");
  return openDb(p);
}

test("导入演示语料：分类为 投射/非投射/无效", () => {
  const db = tmpDb();
  const r = importCorpus(db, "demo", DEMO_CORPUS);
  assert.equal(r.total, 7);
  assert.equal(r.projective, 2);
  assert.equal(r.nonProjective, 1);
  assert.equal(r.invalid, 4);
  assert.ok(r.errors.length >= 4);
});

test("修改 HEAD 生成新版本且旧报告不变", () => {
  const db = tmpDb();
  const r = importCorpus(db, "demo", DEMO_CORPUS);
  const sent = getSentence(db, 1)!;
  assert.equal(sent.status, "non_projective");
  const oldReport = JSON.stringify(sent.report);
  // 把 token 4 的 HEAD 改为 2，使树变为 1->3<-4<-2? 改为链式：2 的 HEAD 改为 3
  const res = setHead(db, 1, 2, 3);
  assert.equal(res.revision, 1);
  assert.equal(res.status, "projective");
  const revs = listRevisions(db, 1);
  assert.equal(revs.length, 2);
  assert.equal(revs[0].report_json, oldReport);
  assert.equal(getSentence(db, 1)!.status, "projective");
});

test("修改 HEAD 造成环时新版本标记为 invalid 并给出链", () => {
  const db = tmpDb();
  importCorpus(db, "demo", DEMO_CORPUS);
  const res = setHead(db, 1, 3, 4, "conj");
  assert.equal(res.status, "invalid");
  const report = res.report as { structureErrors: { code: string }[] };
  assert.ok(report.structureErrors.some((e) => e.code === "CYCLE" || e.code === "ROOT_COUNT"));
});

test("导出保持十列与注释", () => {
  const db = tmpDb();
  const r = importCorpus(db, "demo", DEMO_CORPUS);
  const text = exportCorpus(db, r.corpusId);
  assert.ok(text.includes("# sent_id = zh-1"));
  assert.ok(text.includes("1\t甲\t甲\tPROPN\t_\t_\t3\tnsubj\t_\t_"));
});

test("explain 与 stats 在 API 与 CLI 共用同一实现", () => {
  const db = tmpDb();
  importCorpus(db, "demo", DEMO_CORPUS);
  const ex = explain(db, 1, 4);
  assert.deepEqual(ex.gaps, [3]);
  assert.deepEqual(ex.gapForms, ["走"]);
  const st = stats(db, 1);
  assert.deepEqual(st, { total: 7, invalid: 4, projective: 2, non_projective: 1 });
});

test("HTTP API：导入、查询、核验、解释、统计、导出", async () => {
  const db = tmpDb();
  const server = await startServer(db, 0);
  const port = serverPort(server);
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, body: unknown) =>
    fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  const imp = await (await post("/corpora", { name: "api", text: DEMO_CORPUS })).json();
  assert.equal(imp.total, 7);
  assert.equal(imp.nonProjective, 1);

  const sents = await (await fetch(`${base}/corpora/${imp.corpusId}/sentences?status=non_projective`)).json();
  assert.equal(sents.length, 1);

  const proj = await (await post(`/sentences/${sents[0].id}/projectivity`, {})).json();
  assert.equal(projectiveOf(proj), false);

  const sub = await (await fetch(`${base}/sentences/${sents[0].id}/subtree/4`)).json();
  assert.deepEqual(sub.gaps, [3]);

  const st = await (await fetch(`${base}/corpora/${imp.corpusId}/stats`)).json();
  assert.equal(st.invalid, 4);

  const exp = await (await fetch(`${base}/corpora/${imp.corpusId}/export`)).text();
  assert.ok(exp.includes("root"));

  const diag = await (await fetch(`${base}/sentences/${sents[0].id + 2}/diagnostics`)).json();
  assert.equal(diag.status, "invalid");

  const bad = await fetch(`${base}/sentences/999`);
  assert.equal(bad.status, 404);
  const badJson = await bad.json();
  assert.equal(badJson.error.code, "NOT_FOUND");

  server.close();
});

function projectiveOf(r: { projective: boolean }) {
  return r.projective;
}
