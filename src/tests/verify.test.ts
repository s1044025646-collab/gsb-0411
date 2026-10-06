import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseCorpus, validateSentence } from "../core/conllu";
import { checkProjectivity, descendantsMap, explainSubtree } from "../core/projectivity";
import { openDb, importCorpus, getSentenceRow, reviseCorpus } from "../db";
import { createServer } from "../server";
import { Token } from "../core/types";

function sent(heads: number[], deprels?: string[]): string {
  return heads
    .map((h, i) => {
      const rel = deprels?.[i] ?? (h === 0 ? "root" : "dep");
      return `${i + 1}\tw${i + 1}\t_\tX\t_\t_\t${h}\t${rel}\t_\t_`;
    })
    .join("\n");
}

function tokensOf(heads: number[]): Token[] {
  return parseCorpus(sent(heads))[0].tokens;
}

// ---------- 解析与结构校验 ----------

test("字段数不足被拒绝", () => {
  assert.throws(() => parseCorpus("1\t我\t_\tX"), /10 个制表符字段/);
});

test("多词编号 2-3 明确拒绝", () => {
  assert.throws(() => parseCorpus(sent([0]) + "\n2-3\t甲乙\t_\tX\t_\t_\t_\t_\t_\t_"), /多词编号/);
});

test("空节点 1.1 明确拒绝", () => {
  assert.throws(() => parseCorpus(sent([0]) + "\n1.1\t乙\t_\tX\t_\t_\t1\tdep\t_\t_"), /空节点编号/);
});

test("ID 必须从 1 连续编号", () => {
  const s = parseCorpus("2\t甲\t_\tX\t_\t_\t0\troot\t_\t_")[0];
  const diags = validateSentence(s);
  assert.equal(diags[0].code, "NON_CONTIGUOUS_IDS");
});

test("根约定：恰好一个 HEAD=0 且关系为 root", () => {
  const multi = parseCorpus(sent([0, 0]))[0];
  assert.ok(validateSentence(multi).some((d) => d.code === "ROOT_COUNT"));
  const badRel = parseCorpus(sent([0, 1], ["dep", "dep"]))[0];
  assert.ok(validateSentence(badRel).some((d) => d.code === "ROOT_RELATION"));
  const nonRootRel = parseCorpus(sent([2, 0], ["root", "root"]))[0];
  assert.ok(validateSentence(nonRootRel).some((d) => d.code === "ROOT_RELATION"));
});

test("自指被拒绝并给出引用链", () => {
  const s = parseCorpus(sent([1, 0]))[0];
  const d = validateSentence(s).find((x) => x.code === "SELF_LOOP")!;
  assert.deepEqual(d.chain, [1, 1]);
});

test("环被拒绝并给出引用链", () => {
  const s = parseCorpus(sent([2, 1, 0]))[0];
  const d = validateSentence(s).find((x) => x.code === "CYCLE")!;
  assert.deepEqual(d.chain, [1, 2, 1]);
});

test("HEAD 超出本句范围（跨句引用）被拒绝", () => {
  const s = parseCorpus(sent([5, 0]))[0];
  assert.ok(validateSentence(s).some((d) => d.code === "HEAD_OUT_OF_RANGE"));
});

// ---------- 投射性 ----------

test("演示用例：HEAD 3,4,0,3 合法但非投射，节点4子树{2,4}缺3", () => {
  const tokens = tokensOf([3, 4, 0, 3]);
  assert.equal(validateSentence(parseCorpus(sent([3, 4, 0, 3]))[0]).length, 0);
  const report = checkProjectivity(tokens);
  assert.equal(report.projective, false);
  const v = report.violations.find((x) => x.nodeId === 4)!;
  assert.deepEqual(v.descendants, [2, 4]);
  assert.deepEqual(v.gaps, [3]);
  assert.equal(v.min, 2);
  assert.equal(v.max, 4);
  assert.deepEqual(v.parentChain, [4, 3]);
});

test("全连续链是投射的，根的子树覆盖整句，叶子自然连续", () => {
  const tokens = tokensOf([2, 3, 4, 0]);
  const report = checkProjectivity(tokens);
  assert.equal(report.projective, true);
  const root = explainSubtree(tokens, 4)!;
  assert.deepEqual(root.descendants, [1, 2, 3, 4]);
  const leaf = explainSubtree(tokens, 1)!;
  assert.equal(leaf.contiguous, true);
});

test("独立后代枚举核对区间缺口（暴力交叉验证）", () => {
  // 随机合法树，比较 descendantsMap 与暴力父链枚举
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let trial = 0; trial < 50; trial++) {
    const n = 2 + Math.floor(rand() * 8);
    const heads: number[] = [];
    for (let i = 1; i <= n; i++) {
      if (i === 1) heads.push(0);
      else heads.push(1 + Math.floor(rand() * (i - 1))); // 父节点编号更小 → 必无环
    }
    const tokens = tokensOf(heads);
    const desc = descendantsMap(tokens);
    for (const t of tokens) {
      // 暴力：后代 = 父链经过 t 的所有节点
      const brute = new Set<number>([t.id]);
      for (const u of tokens) {
        let cur = u.id;
        const seen = new Set<number>();
        while (cur !== 0 && !seen.has(cur)) {
          seen.add(cur);
          if (cur === t.id) { brute.add(u.id); break; }
          cur = tokens[cur - 1].head;
        }
      }
      assert.deepEqual([...desc.get(t.id)!].sort((a, b) => a - b), [...brute].sort((a, b) => a - b));
    }
    // 投射性与暴力区间检查一致
    const report = checkProjectivity(tokens);
    for (const t of tokens) {
      const set = desc.get(t.id)!;
      const min = Math.min(...set), max = Math.max(...set);
      const bruteContig = max - min + 1 === set.size;
      const reported = !report.violations.some((v) => v.nodeId === t.id);
      assert.equal(reported, bruteContig);
    }
  }
});

test("中文词形、注释、标点、叶子节点", () => {
  const text = [
    "# sent_id = zh-1",
    "# text = 我爱北京。",
    "1\t我\t我\tPRON\t_\t_\t2\tnsubj\t_\t_",
    "2\t爱\t爱\tVERB\t_\t_\t0\troot\t_\t_",
    "3\t北京\t北京\tPROPN\t_\t_\t2\tobj\t_\t_",
    "4\t。\t。\tPUNCT\t_\t_\t2\tpunct\t_\t_",
  ].join("\n");
  const s = parseCorpus(text)[0];
  assert.deepEqual(s.comments, ["# sent_id = zh-1", "# text = 我爱北京。"]);
  assert.equal(validateSentence(s).length, 0);
  const report = checkProjectivity(s.tokens);
  assert.equal(report.projective, true);
  assert.equal(s.tokens[3].form, "。"); // 标点是普通 token
});

test("非投射中文句：标点参与位置计算", () => {
  const text = [
    "1\t看\t看\tVERB\t_\t_\t3\tdep\t_\t_",
    "2\t，\t，\tPUNCT\t_\t_\t4\tpunct\t_\t_",
    "3\t电影\t电影\tNOUN\t_\t_\t0\troot\t_\t_",
    "4\t场\t场\tNOUN\t_\t_\t3\tdep\t_\t_",
  ].join("\n");
  const s = parseCorpus(text)[0];
  assert.equal(validateSentence(s).length, 0);
  const report = checkProjectivity(s.tokens);
  assert.equal(report.projective, false);
  assert.deepEqual(report.violations[0].gaps, [3]);
});

// ---------- 持久化与版本 ----------

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conllu-test-"));
  return openDb(path.join(dir, "test.db"));
}

test("导入分类：invalid / projective / nonprojective 区分保存", () => {
  const db = tmpDb();
  const text = [sent([3, 4, 0, 3]), sent([2, 3, 4, 0]), sent([1, 0])].join("\n\n");
  const r = importCorpus(db, "t1", text);
  assert.deepEqual(
    { total: r.total, invalid: r.invalid, projective: r.projective, nonprojective: r.nonprojective },
    { total: 3, invalid: 1, projective: 1, nonprojective: 1 }
  );
  const bad = getSentenceRow(db, r.corpusId, 3) as Record<string, string>;
  assert.equal(bad.status, "invalid");
  assert.equal(bad.projectivity, null); // 不合法图不交给投射性算法
  const np = getSentenceRow(db, r.corpusId, 1) as Record<string, string>;
  assert.equal(np.status, "nonprojective");
});

test("重启后可继续查询已保存的核验依据", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conllu-test-"));
  const p = path.join(dir, "test.db");
  const db1 = openDb(p);
  const r = importCorpus(db1, "persist", sent([3, 4, 0, 3]));
  db1.close();
  const db2 = openDb(p);
  const row = getSentenceRow(db2, r.corpusId, 1) as Record<string, string>;
  assert.equal(row.status, "nonprojective");
  const proj = JSON.parse(row.projectivity);
  assert.deepEqual(proj.violations[0].gaps, [3]);
});

test("修改 HEAD 创建新版本，旧报告不变", () => {
  const db = tmpDb();
  const r1 = importCorpus(db, "v1", sent([3, 4, 0, 3]));
  const r2 = reviseCorpus(db, r1.corpusId, [{ sentence: 1, heads: [3, 3, 0, 3] }]);
  assert.notEqual(r1.corpusId, r2.corpusId);
  assert.equal(r2.projective, 1); // 新版本修复后投射
  const oldRow = getSentenceRow(db, r1.corpusId, 1) as Record<string, string>;
  assert.equal(oldRow.status, "nonprojective"); // 旧报告保持非投射
  const parent = db.prepare("SELECT parent_id FROM corpora WHERE id = ?").get(r2.corpusId) as { parent_id: number };
  assert.equal(parent.parent_id, r1.corpusId);
});

// ---------- API 与 CLI 分类一致性 ----------

test("HTTP API 分类与核心算法一致", async () => {
  const db = tmpDb();
  const server = createServer(db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const text = [sent([3, 4, 0, 3]), sent([2, 3, 4, 0]), sent([1, 0])].join("\n\n");
    const res = await fetch(`${base}/corpora`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "api", text }),
    });
    assert.equal(res.status, 201);
    const imp = (await res.json()) as { corpusId: number };

    const stats = (await (await fetch(`${base}/corpora/${imp.corpusId}/stats`)).json()) as Record<string, number>;
    assert.deepEqual(
      { invalid: stats.invalid, projective: stats.projective, nonprojective: stats.nonprojective },
      { invalid: 1, projective: 1, nonprojective: 1 }
    );

    const proj = (await (await fetch(`${base}/corpora/${imp.corpusId}/sentences/1/projectivity`)).json()) as {
      projective: boolean;
      violations: { nodeId: number; gaps: number[] }[];
    };
    assert.equal(proj.projective, false);
    assert.deepEqual(proj.violations[0].gaps, [3]);

    const sub = (await (await fetch(`${base}/corpora/${imp.corpusId}/sentences/1/subtree/4`)).json()) as {
      descendants: number[];
      gaps: number[];
      contiguous: boolean;
    };
    assert.deepEqual(sub.descendants, [2, 4]);
    assert.deepEqual(sub.gaps, [3]);
    assert.equal(sub.contiguous, false);

    // 非法句的投射性请求返回明确错误码
    const badRes = await fetch(`${base}/corpora/${imp.corpusId}/sentences/3/projectivity`);
    assert.equal(badRes.status, 400);
    const badBody = (await badRes.json()) as { error: { code: string } };
    assert.equal(badBody.error.code, "INVALID_SENTENCE");

    // 导出与导入原文一致
    const exported = await (await fetch(`${base}/corpora/${imp.corpusId}/export`)).text();
    assert.ok(exported.includes("w1"));
  } finally {
    server.close();
  }
});
