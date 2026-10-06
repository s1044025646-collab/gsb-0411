import test from "node:test";
import assert from "node:assert/strict";
import { parseCorpus, parseSentence, validateStructure, parentChain } from "../src/conllu";
import { checkProjectivity, explainSubtree, subtreeMembers } from "../src/projective";

const NONPROJ = `1	甲	甲	PROPN	_	_	3	nsubj	_	_
2	乙	乙	PROPN	_	_	4	nsubj	_	_
3	走	走	VERB	_	_	0	root	_	_
4	来	来	VERB	_	_	3	conj	_	_`;

const CHAIN = `1	我	我	PRON	_	_	2	nsubj	_	_
2	认真	认真	ADV	_	_	3	advmod	_	_
3	阅读	阅读	VERB	_	_	4	xcomp	_	_
4	学习	学习	VERB	_	_	0	root	_	_`;

test("解析十列结构并保留注释与字段原文", () => {
  const s = parseSentence(`# sent_id = a\n${CHAIN}`);
  assert.deepEqual(s.comments, ["# sent_id = a"]);
  assert.equal(s.tokens.length, 4);
  assert.equal(s.tokens[0].form, "我");
  assert.equal(s.tokens[0].deps, "_");
  assert.equal(s.tokens[3].head, 0);
});

test("拒绝非十列行", () => {
  assert.throws(() => parseSentence("1\t只有两列"), /十列/);
});

test("明确拒绝多词编号与空节点编号", () => {
  assert.throws(() => parseSentence("1-2	a	a	X	_	_	0	root	_	_"), /连字符/);
  assert.throws(() => parseSentence("3.1	a	a	X	_	_	0	root	_	_"), /小数点/);
});

test("编号必须连续", () => {
  const s = parseSentence(`1	a	a	X	_	_	0	root	_	_
3	c	c	X	_	_	1	x	_	_`);
  const errs = validateStructure(s.tokens);
  assert.equal(errs[0].code, "ID_SEQUENCE");
});

test("演示句：HEAD 3,4,0,3 合法但非投射，节点 4 子树 {2,4} 缺 3", () => {
  const s = parseSentence(NONPROJ);
  assert.deepEqual(validateStructure(s.tokens), []);
  const report = checkProjectivity(s.tokens);
  assert.equal(report.projective, false);
  assert.equal(report.rootId, 3);
  const sub = report.subtrees.find((x) => x.nodeId === 4)!;
  assert.deepEqual(sub.interval, [2, 4]);
  assert.deepEqual(sub.descendants, [2, 4]);
  assert.deepEqual(sub.gaps, [3]);
  assert.deepEqual(sub.parentChain, [4, 3]);
  // 根的子树覆盖整句且连续
  assert.equal(report.subtrees.some((x) => x.nodeId === 3), false);
  // 独立后代枚举核对
  assert.deepEqual(subtreeMembers(s.tokens, 4), [2, 4]);
});

test("投射链全部连续，叶子子树自然连续", () => {
  const s = parseSentence(CHAIN);
  const report = checkProjectivity(s.tokens);
  assert.equal(report.projective, true);
  const leaf = explainSubtree(s.tokens, 1)!;
  assert.equal(leaf.contiguous, true);
  assert.deepEqual(leaf.descendants, [1]);
});

test("多根被拒绝", () => {
  const s = parseSentence(`1	a	a	X	_	_	0	root	_	_
2	b	b	X	_	_	0	root	_	_`);
  assert.ok(validateStructure(s.tokens).some((e) => e.code === "ROOT_COUNT"));
});

test("环被拒绝并给出引用链", () => {
  const s = parseSentence(`1	a	a	X	_	_	2	x	_	_
2	b	b	X	_	_	1	x	_	_
3	c	c	X	_	_	0	root	_	_`);
  const errs = validateStructure(s.tokens);
  const cyc = errs.find((e) => e.code === "CYCLE")!;
  assert.ok(cyc);
  assert.ok(cyc.chain!.length >= 3);
});

test("自指被拒绝", () => {
  const s = parseSentence(`1	a	a	X	_	_	1	x	_	_
2	b	b	X	_	_	0	root	_	_`);
  assert.ok(validateStructure(s.tokens).some((e) => e.code === "SELF_HEAD"));
});

test("跨句引用（HEAD 越界）被拒绝", () => {
  const s = parseSentence(`1	a	a	X	_	_	9	x	_	_
2	b	b	X	_	_	0	root	_	_`);
  assert.ok(validateStructure(s.tokens).some((e) => e.code === "HEAD_RANGE"));
});

test("非根使用 root 关系、根不用 root 关系均被拒绝", () => {
  const a = parseSentence(`1	a	a	X	_	_	2	root	_	_
2	b	b	X	_	_	0	root	_	_`);
  assert.ok(validateStructure(a.tokens).some((e) => e.code === "ROOT_RELATION"));
  const b = parseSentence(`1	a	a	X	_	_	0	nsubj	_	_
2	b	b	X	_	_	1	x	_	_`);
  assert.ok(validateStructure(b.tokens).some((e) => e.code === "ROOT_RELATION"));
});

test("标点作为普通 token 参与位置核验", () => {
  const s = parseSentence(`1	我	我	PRON	_	_	2	nsubj	_	_
2	爱	爱	VERB	_	_	0	root	_	_
3	北京	北京	PROPN	_	_	2	obj	_	_
4	。	。	PUNCT	_	_	2	punct	_	_`);
  assert.deepEqual(validateStructure(s.tokens), []);
  assert.equal(checkProjectivity(s.tokens).projective, true);
});

test("父链解释正确", () => {
  const s = parseSentence(CHAIN);
  assert.deepEqual(parentChain(s.tokens, 1), [1, 2, 3, 4]);
});

test("parseCorpus 按空行切句并保留坏句诊断", () => {
  const { sentences, errors } = parseCorpus(`${CHAIN}\n\n1\tx\tx\tX\n\n${NONPROJ}`);
  assert.equal(sentences.length, 3);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].sentenceIndex, 1);
});
