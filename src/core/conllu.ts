import { ConlluError, Diagnostic, Sentence, Token } from "./types";

export const RULE_VERSION = "conllu-basic-v1";

export const MAX_SENTENCES = Number(process.env.MAX_SENTENCES ?? 10000);
export const MAX_TOKENS = Number(process.env.MAX_TOKENS ?? 500);

const INT_RE = /^\d+$/;

export function parseTokenLine(line: string, sentenceIndex: number): Token {
  const fields = line.split("\t");
  if (fields.length !== 10) {
    throw new ConlluError(
      "FIELD_COUNT",
      `句子 ${sentenceIndex}: token 行需要 10 个制表符字段，实际 ${fields.length} 个: ${line}`,
      { sentence: sentenceIndex, line }
    );
  }
  const [idS, form, lemma, upos, xpos, feats, headS, deprel, deps, misc] = fields;
  if (idS.includes("-")) {
    throw new ConlluError(
      "MULTIWORD_ID",
      `句子 ${sentenceIndex}: 不支持多词编号 "${idS}"（带连字符），已明确拒绝`,
      { sentence: sentenceIndex, id: idS }
    );
  }
  if (idS.includes(".")) {
    throw new ConlluError(
      "EMPTY_NODE_ID",
      `句子 ${sentenceIndex}: 不支持空节点编号 "${idS}"（带小数点），已明确拒绝`,
      { sentence: sentenceIndex, id: idS }
    );
  }
  if (!INT_RE.test(idS)) {
    throw new ConlluError("BAD_ID", `句子 ${sentenceIndex}: 非法 token ID "${idS}"`, {
      sentence: sentenceIndex,
      id: idS,
    });
  }
  if (!INT_RE.test(headS)) {
    throw new ConlluError(
      "BAD_HEAD",
      `句子 ${sentenceIndex}: token ${idS} 的 HEAD "${headS}" 不是非负整数`,
      { sentence: sentenceIndex, id: idS, head: headS }
    );
  }
  return {
    id: Number(idS),
    form,
    lemma,
    upos,
    xpos,
    feats,
    head: Number(headS),
    deprel,
    deps,
    misc,
    raw: line,
  };
}

export function parseCorpus(text: string): Sentence[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n[ \t]*\n/);
  const sentences: Sentence[] = [];
  for (const block of blocks) {
    if (block.trim() === "") continue;
    const index = sentences.length + 1;
    if (index > MAX_SENTENCES) {
      throw new ConlluError(
        "TOO_MANY_SENTENCES",
        `句子数量超过上限 ${MAX_SENTENCES}`,
        { limit: MAX_SENTENCES }
      );
    }
    const comments: string[] = [];
    const tokens: Token[] = [];
    for (const line of block.split("\n")) {
      if (line === "") continue;
      if (line.startsWith("#")) {
        comments.push(line);
      } else {
        tokens.push(parseTokenLine(line, index));
      }
    }
    if (tokens.length === 0) {
      throw new ConlluError("EMPTY_SENTENCE", `句子 ${index}: 没有任何 token 行`, {
        sentence: index,
      });
    }
    if (tokens.length > MAX_TOKENS) {
      throw new ConlluError(
        "TOO_MANY_TOKENS",
        `句子 ${index}: token 数 ${tokens.length} 超过上限 ${MAX_TOKENS}`,
        { sentence: index, limit: MAX_TOKENS }
      );
    }
    sentences.push({ index, comments, tokens, raw: block });
  }
  return sentences;
}

/** 沿父链从 token 走到根，返回链（含自身与根）。遇环抛错。 */
export function parentChain(tokens: Token[], startId: number): number[] {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const chain: number[] = [];
  const seen = new Set<number>();
  let cur = startId;
  while (true) {
    if (seen.has(cur)) {
      chain.push(cur);
      throw new ConlluError(
        "CYCLE",
        `依存图存在环，引用链: ${chain.join(" -> ")}`,
        { chain: [...chain] }
      );
    }
    seen.add(cur);
    chain.push(cur);
    const tok = byId.get(cur);
    if (!tok) break;
    if (tok.head === 0) break;
    cur = tok.head;
  }
  return chain;
}

/** 结构校验：返回诊断列表；合法时返回空数组。不合法图绝不交给后续算法。 */
export function validateSentence(sentence: Sentence): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const tokens = sentence.tokens;
  const n = tokens.length;
  const sidx = sentence.index;

  const ids = tokens.map((t) => t.id).sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== i + 1) {
      diags.push({
        code: "NON_CONTIGUOUS_IDS",
        message: `句子 ${sidx}: token ID 必须从 1 连续编号，位置 ${i + 1} 处发现 ID ${ids[i]}`,
        sentence: sidx,
        tokenId: ids[i],
      });
      break;
    }
  }
  if (diags.length > 0) return diags;

  const byId = new Map(tokens.map((t) => [t.id, t]));

  let rootCount = 0;
  for (const t of tokens) {
    if (t.head === 0) {
      rootCount++;
      if (t.deprel !== "root") {
        diags.push({
          code: "ROOT_RELATION",
          message: `句子 ${sidx}: token ${t.id} HEAD=0 但关系为 "${t.deprel}"，根必须使用 root 关系`,
          sentence: sidx,
          tokenId: t.id,
        });
      }
    } else {
      if (t.head > n) {
        diags.push({
          code: "HEAD_OUT_OF_RANGE",
          message: `句子 ${sidx}: token ${t.id} 的 HEAD=${t.head} 超出本句范围 1..${n}（不允许跨句引用）`,
          sentence: sidx,
          tokenId: t.id,
        });
        continue;
      }
      if (t.head === t.id) {
        diags.push({
          code: "SELF_LOOP",
          message: `句子 ${sidx}: token ${t.id} 的 HEAD 指向自身（自指）`,
          sentence: sidx,
          tokenId: t.id,
          chain: [t.id, t.id],
        });
      }
      if (t.deprel === "root") {
        diags.push({
          code: "ROOT_RELATION",
          message: `句子 ${sidx}: token ${t.id} HEAD=${t.head} 非根却使用 root 关系`,
          sentence: sidx,
          tokenId: t.id,
        });
      }
    }
  }
  if (rootCount !== 1) {
    diags.push({
      code: "ROOT_COUNT",
      message: `句子 ${sidx}: HEAD=0 的 token 必须恰好一个，实际 ${rootCount} 个`,
      sentence: sidx,
    });
  }
  if (diags.length > 0) return diags;

  // 环与连通性：沿父链走到根
  for (const t of tokens) {
    try {
      parentChain(tokens, t.id);
    } catch (e) {
      if (e instanceof ConlluError && e.code === "CYCLE") {
        diags.push({
          code: "CYCLE",
          message: `句子 ${sidx}: token ${t.id} 的父链存在环: ${(e.details.chain as number[]).join(" -> ")}`,
          sentence: sidx,
          tokenId: t.id,
          chain: e.details.chain as number[],
        });
        return diags;
      }
      throw e;
    }
  }
  // 每个 token 只有一个父节点由单列 HEAD 保证；连通性：所有父链终点必须是唯一根
  const root = tokens.find((t) => t.head === 0)!;
  for (const t of tokens) {
    const chain = parentChain(tokens, t.id);
    if (chain[chain.length - 1] !== root.id) {
      diags.push({
        code: "DISCONNECTED",
        message: `句子 ${sidx}: token ${t.id} 的父链 ${chain.join(" -> ")} 未到达根 ${root.id}`,
        sentence: sidx,
        tokenId: t.id,
        chain,
      });
    }
  }
  void byId;
  return diags;
}
