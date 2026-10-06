import { parseCorpus, validateSentence } from "./core/conllu";
import { checkProjectivity, explainSubtree } from "./core/projectivity";

const DEMO = `# 演示 1: 合法但非投射。HEAD 依次为 3 4 0 3，根为 3。
# 节点 4 的子树位置为 {2,4}，中间缺少 3，因此非投射。
1	看	看	VERB	_	_	3	nsubj	_	_
2	一	一	NUM	_	_	4	nummod	_	_
3	电影	电影	NOUN	_	_	0	root	_	_
4	场	场	NOUN	_	_	3	dep	_	_

# 演示 2: 全部连续的链（投射）。
1	我	我	PRON	_	_	2	nsubj	_	_
2	爱	爱	VERB	_	_	0	root	_	_
3	北京	北京	PROPN	_	_	2	obj	_	_
4	。	。	PUNCT	_	_	2	punct	_	_
`;

const BAD_CASES: [string, string][] = [
  ["多根", "1\t甲\t_\tX\t_\t_\t0\troot\t_\t_\n2\t乙\t_\tX\t_\t_\t0\troot\t_\t_"],
  ["环", "1\t甲\t_\tX\t_\t_\t2\tdep\t_\t_\n2\t乙\t_\tX\t_\t_\t1\tdep\t_\t_\n3\t丙\t_\tX\t_\t_\t0\troot\t_\t_"],
  ["自指", "1\t甲\t_\tX\t_\t_\t1\tdep\t_\t_\n2\t乙\t_\tX\t_\t_\t0\troot\t_\t_"],
  ["跨句引用(HEAD 超界)", "1\t甲\t_\tX\t_\t_\t5\tdep\t_\t_\n2\t乙\t_\tX\t_\t_\t0\troot\t_\t_"],
  ["多词编号(拒绝)", "1-2\t甲乙\t_\tX\t_\t_\t0\troot\t_\t_"],
  ["空节点(拒绝)", "1\t甲\t_\tX\t_\t_\t0\troot\t_\t_\n1.1\t乙\t_\tX\t_\t_\t1\tdep\t_\t_"],
];

export function runDemo() {
  console.log("=== 合法句子 ===");
  for (const s of parseCorpus(DEMO)) {
    const diags = validateSentence(s);
    const report = checkProjectivity(s.tokens);
    console.log(`句子 ${s.index}: 结构${diags.length ? "非法" : "合法"}, 投射性=${report.projective ? "投射" : "非投射"}`);
    for (const v of report.violations) {
      console.log(
        `  非连续子树: 节点 ${v.nodeId}, 区间 [${v.min},${v.max}], 后代 {${v.descendants}}, 缺口 {${v.gaps}}, 父链 ${v.parentChain.join(" -> ")}`
      );
    }
    console.log("  子树解释(节点4):", JSON.stringify(explainSubtree(s.tokens, 4)));
  }
  console.log("\n=== 拒绝用例 ===");
  for (const [label, text] of BAD_CASES) {
    try {
      const [s] = parseCorpus(text);
      const diags = validateSentence(s);
      console.log(`${label}: ${diags.length ? diags.map((d) => `[${d.code}] ${d.message}`).join("; ") : "（未检出，异常！）"}`);
    } catch (e) {
      console.log(`${label}: [${(e as { code?: string }).code}] ${(e as Error).message}`);
    }
  }
}
