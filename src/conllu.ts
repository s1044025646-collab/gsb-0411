/**
 * 受限 CoNLL-U 解析与结构核验。
 * 仅支持：连续整数 token ID（1..n）、基本 HEAD 依存列。
 * 明确拒绝：带连字符的多词编号（1-2）、带小数点的空节点（3.1）。
 * DEPS 等字段仅原文保留，不用于构建增强依存图。
 */

export const RULE_VERSION = "conllu-basic-1.0";

export interface Token {
  id: number;
  form: string;
  lemma: string;
  upos: string;
  xpos: string;
  feats: string;
  head: number;
  deprel: string;
  deps: string;
  misc: string;
  raw: string;
}

export interface Sentence {
  comments: string[];
  tokens: Token[];
  text: string;
}

export type ErrorCode =
  | "PARSE_ERROR"
  | "ID_SEQUENCE"
  | "HEAD_RANGE"
  | "ROOT_COUNT"
  | "ROOT_RELATION"
  | "SELF_HEAD"
  | "CYCLE"
  | "DISCONNECTED"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR";

export interface StructureError {
  code: ErrorCode;
  message: string;
  tokenId?: number;
  chain?: number[];
}

const INT_RE = /^\d+$/;

export interface ParsedCorpus {
  sentences: Sentence[];
  errors: { sentenceIndex: number; error: StructureError }[];
}

/** 按空行切句并解析；解析失败的句保留原文占位并记录错误，句号保持一致。 */
export function parseCorpus(text: string): ParsedCorpus {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.replace(/\n+$/, ""))
    .filter((b) => b.trim().length > 0);
  const sentences: Sentence[] = [];
  const errors: { sentenceIndex: number; error: StructureError }[] = [];
  blocks.forEach((block, i) => {
    try {
      sentences.push(parseSentence(block));
    } catch (e) {
      errors.push({ sentenceIndex: i, error: e as StructureError });
      sentences.push({ comments: [], tokens: [], text: block });
    }
  });
  return { sentences, errors };
}

export function parseSentence(block: string): Sentence {
  const comments: string[] = [];
  const tokens: Token[] = [];
  const lines = block.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    if (line.startsWith("#")) {
      comments.push(line);
      continue;
    }
    if (line.trim() === "") continue;
    const cols = line.split("\t");
    if (cols.length !== 10) {
      throw serr("PARSE_ERROR", `第 ${ln + 1} 行不是十列制表符结构（实际 ${cols.length} 列）: ${line}`);
    }
    const [idStr, form, lemma, upos, xpos, feats, headStr, deprel, deps, misc] = cols;
    if (idStr.includes("-")) {
      throw serr("PARSE_ERROR", `不支持带连字符的多词编号 "${idStr}"，已明确拒绝`);
    }
    if (idStr.includes(".")) {
      throw serr("PARSE_ERROR", `不支持带小数点的空节点编号 "${idStr}"，已明确拒绝`);
    }
    if (!INT_RE.test(idStr)) {
      throw serr("PARSE_ERROR", `非法 token 编号 "${idStr}"`);
    }
    if (!INT_RE.test(headStr)) {
      throw serr("PARSE_ERROR", `token ${idStr} 的 HEAD "${headStr}" 不是非负整数`);
    }
    tokens.push({
      id: parseInt(idStr, 10),
      form, lemma, upos, xpos, feats,
      head: parseInt(headStr, 10),
      deprel, deps, misc,
      raw: line,
    });
  }
  if (tokens.length === 0) {
    throw serr("PARSE_ERROR", "句子不包含任何 token 行");
  }
  return { comments, tokens, text: block };
}

export class ConlluError extends Error {
  code: ErrorCode;
  tokenId?: number;
  chain?: number[];
  constructor(e: StructureError) {
    super(e.message);
    this.code = e.code;
    this.tokenId = e.tokenId;
    this.chain = e.chain;
  }
}

function serr(code: ErrorCode, message: string, tokenId?: number, chain?: number[]): ConlluError {
  return new ConlluError({ code, message, tokenId, chain });
}

/** 结构核验：编号连续、HEAD 范围、根约定、无环、全连通。空数组 = 结构合法。 */
export function validateStructure(tokens: Token[]): StructureError[] {
  const errors: StructureError[] = [];
  const n = tokens.length;
  const byId = new Map<number, Token>();
  for (const t of tokens) byId.set(t.id, t);

  for (let i = 1; i <= n; i++) {
    if (!byId.has(i)) {
      errors.push(serr("ID_SEQUENCE", `token 编号不连续：缺少 ${i}（要求 1..${n} 连续整数）`));
      break;
    }
  }
  for (const t of tokens) {
    if (t.id < 1 || t.id > n) {
      errors.push(serr("ID_SEQUENCE", `token 编号 ${t.id} 超出 1..${n} 范围`, t.id));
    }
  }
  if (errors.length > 0) return errors;

  let rootCount = 0;
  for (const t of tokens) {
    if (t.head === 0) {
      rootCount++;
      if (t.deprel !== "root") {
        errors.push(serr("ROOT_RELATION", `token ${t.id} HEAD=0 但关系为 "${t.deprel}"，根必须使用 root 关系`, t.id));
      }
    } else {
      if (t.head < 0 || t.head > n) {
        errors.push(serr("HEAD_RANGE", `token ${t.id} 的 HEAD=${t.head} 超出本句范围 0..${n}（不允许跨句引用）`, t.id));
      }
      if (t.head === t.id) {
        errors.push(serr("SELF_HEAD", `token ${t.id} 自指（HEAD 等于自身 ID）`, t.id, [t.id, t.id]));
      }
      if (t.deprel === "root") {
        errors.push(serr("ROOT_RELATION", `token ${t.id} HEAD=${t.head} 非根却使用 root 关系`, t.id));
      }
    }
  }
  if (rootCount !== 1) {
    errors.push(serr("ROOT_COUNT", `HEAD=0 的 token 必须恰好一个，实际 ${rootCount} 个`));
  }
  if (errors.length > 0) return errors;

  const root = tokens.find((t) => t.head === 0)!;
  for (const t of tokens) {
    const chain: number[] = [t.id];
    const seen = new Set<number>([t.id]);
    let cur = t;
    while (cur.head !== 0) {
      const parent = byId.get(cur.head)!;
      if (seen.has(parent.id)) {
        chain.push(parent.id);
        errors.push(serr("CYCLE", `检测到环：${chain.join(" -> ")}`, t.id, chain.slice()));
        break;
      }
      seen.add(parent.id);
      chain.push(parent.id);
      cur = parent;
    }
    if (errors.length > 0) break;
    if (cur.head === 0 && cur.id !== root.id) {
      errors.push(serr("DISCONNECTED", `token ${t.id} 沿父链到达的根 ${cur.id} 与唯一根不一致`, t.id, chain));
      break;
    }
  }
  return errors;
}

/** 父链：从 token 沿 HEAD 到根（含两端）。仅在结构合法时调用。 */
export function parentChain(tokens: Token[], tokenId: number): number[] {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  const chain: number[] = [];
  let cur = byId.get(tokenId);
  const seen = new Set<number>();
  while (cur) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    chain.push(cur.id);
    if (cur.head === 0) break;
    cur = byId.get(cur.head);
  }
  return chain;
}
