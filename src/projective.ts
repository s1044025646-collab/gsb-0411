/**
 * 投射性核验：对每个节点取包含自身的子树 token 位置集合，
 * 若 [min, max] 区间内存在不属于该子树的 token，则该子树非连续，整树非投射。
 * 位置完全由 token ID 决定；标点作为普通 token 参与，无任何语言特定例外。
 */
import { Token, parentChain } from "./conllu";

export interface NonProjectiveSubtree {
  nodeId: number;
  interval: [number, number];
  descendants: number[];
  gaps: number[];
  parentChain: number[];
}

export interface ProjectivityReport {
  projective: boolean;
  rootId: number;
  subtrees: NonProjectiveSubtree[];
}

function childrenMap(tokens: Token[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const t of tokens) children.set(t.id, []);
  for (const t of tokens) {
    if (t.head !== 0) children.get(t.head)!.push(t.id);
  }
  return children;
}

export function subtreeMembers(tokens: Token[], nodeId: number): number[] {
  const children = childrenMap(tokens);
  const members: number[] = [];
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    members.push(id);
    for (const c of children.get(id)!) stack.push(c);
  }
  return members.sort((a, b) => a - b);
}

export function checkProjectivity(tokens: Token[]): ProjectivityReport {
  const root = tokens.find((t) => t.head === 0)!;
  const children = childrenMap(tokens);

  const subtreeOf = new Map<number, number[]>();
  const order: number[] = [];
  const stack: number[] = [root.id];
  while (stack.length) {
    const id = stack.pop()!;
    order.push(id);
    for (const c of children.get(id)!) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const set = [id];
    for (const c of children.get(id)!) set.push(...subtreeOf.get(c)!);
    subtreeOf.set(id, set);
  }

  const subtrees: NonProjectiveSubtree[] = [];
  for (const t of tokens) {
    const members = subtreeOf.get(t.id)!.slice().sort((a, b) => a - b);
    const min = members[0];
    const max = members[members.length - 1];
    const memberSet = new Set(members);
    const gaps: number[] = [];
    for (let p = min; p <= max; p++) {
      if (!memberSet.has(p)) gaps.push(p);
    }
    if (gaps.length > 0) {
      subtrees.push({
        nodeId: t.id,
        interval: [min, max],
        descendants: members,
        gaps,
        parentChain: parentChain(tokens, t.id),
      });
    }
  }
  subtrees.sort((a, b) => a.nodeId - b.nodeId);
  return { projective: subtrees.length === 0, rootId: root.id, subtrees };
}

/** 解释单个节点的子树（连续与否都返回）。 */
export function explainSubtree(tokens: Token[], nodeId: number) {
  const byId = new Map(tokens.map((t) => [t.id, t]));
  if (!byId.has(nodeId)) return null;
  const members = subtreeMembers(tokens, nodeId);
  const min = members[0];
  const max = members[members.length - 1];
  const memberSet = new Set(members);
  const gaps: number[] = [];
  for (let p = min; p <= max; p++) if (!memberSet.has(p)) gaps.push(p);
  return {
    nodeId,
    interval: [min, max] as [number, number],
    descendants: members,
    gaps,
    contiguous: gaps.length === 0,
    parentChain: parentChain(tokens, nodeId),
    forms: members.map((id) => byId.get(id)!.form),
    gapForms: gaps.map((id) => byId.get(id)!.form),
  };
}
