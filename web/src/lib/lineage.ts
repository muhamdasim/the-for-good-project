import { STAGE_ORDER } from "./meta";
import type { IssueLite } from "./types";

export interface ChainNode {
  issue: IssueLite;
  children: ChainNode[];
  prs: IssueLite[];
}

export interface StreamChainGroup {
  stream: number;
  roots: ChainNode[];
  updatedAt: string;
  issueCount: number;
  prCount: number;
}

const STREAM_RE = /^stream:(\d+)$/i;
const PARENT_RE = /^Part of #(\d+)\b/im;
const CLOSES_RE = /\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\s+#(\d+)/gi;

export function streamNumber(issue: IssueLite): number | null {
  for (const label of issue.labels) {
    const match = STREAM_RE.exec(label.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

export function parentNumber(issue: IssueLite): number | null {
  const match = PARENT_RE.exec(issue.body);
  return match ? Number(match[1]) : null;
}

function closedNumbers(pr: IssueLite): number[] {
  const out: number[] = [];
  CLOSES_RE.lastIndex = 0;
  let match;
  while ((match = CLOSES_RE.exec(pr.body))) out.push(Number(match[1]));
  return out;
}

function stageRank(issue: IssueLite) {
  const rank = STAGE_ORDER.indexOf(issue.stage as (typeof STAGE_ORDER)[number]);
  return rank === -1 ? STAGE_ORDER.length : rank;
}

export function chainUpdatedAt(node: ChainNode, seen = new Set<number>()): string {
  if (seen.has(node.issue.number)) return node.issue.updatedAt;
  seen.add(node.issue.number);

  let latest = node.issue.updatedAt;
  for (const pr of node.prs) if (pr.updatedAt > latest) latest = pr.updatedAt;
  for (const child of node.children) {
    const updatedAt = chainUpdatedAt(child, seen);
    if (updatedAt > latest) latest = updatedAt;
  }
  return latest;
}

export function chainSize(node: ChainNode, seen = new Set<number>()): number {
  if (seen.has(node.issue.number)) return 0;
  seen.add(node.issue.number);
  return 1 + node.children.reduce((total, child) => total + chainSize(child, seen), 0);
}

function sortChildren(node: ChainNode, path = new Set<number>()) {
  if (path.has(node.issue.number)) {
    node.children = [];
    return;
  }

  path.add(node.issue.number);
  node.children = node.children
    .filter((child) => !path.has(child.issue.number))
    .sort((a, b) => stageRank(a.issue) - stageRank(b.issue) || a.issue.number - b.issue.number);
  for (const child of node.children) sortChildren(child, new Set(path));
}

function buildStreamRoots(issues: IssueLite[], prs: IssueLite[]): ChainNode[] {
  const nodes = new Map<number, ChainNode>();
  for (const issue of issues) nodes.set(issue.number, { issue, children: [], prs: [] });

  for (const pr of prs) {
    for (const number of closedNumbers(pr)) nodes.get(number)?.prs.push(pr);
  }

  const roots: ChainNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentNumber(node.issue);
    const parentNode = parent != null && parent !== node.issue.number ? nodes.get(parent) : undefined;
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }

  const reachable = new Set<number>();
  const mark = (node: ChainNode, path = new Set<number>()) => {
    if (reachable.has(node.issue.number) || path.has(node.issue.number)) return;
    reachable.add(node.issue.number);
    path.add(node.issue.number);
    for (const child of node.children) mark(child, new Set(path));
  };
  for (const root of roots) mark(root);

  for (const node of nodes.values()) {
    if (reachable.has(node.issue.number)) continue;
    node.children = node.children.filter((child) => child.issue.number !== node.issue.number);
    roots.push(node);
    mark(node);
  }

  for (const root of roots) sortChildren(root);
  roots.sort((a, b) => chainUpdatedAt(b).localeCompare(chainUpdatedAt(a)));
  return roots;
}

export function buildStreamChains(all: IssueLite[]): StreamChainGroup[] {
  const grouped = new Map<number, { issues: IssueLite[]; prs: IssueLite[] }>();

  for (const item of all) {
    const stream = streamNumber(item);
    if (stream == null) continue;
    if (!grouped.has(stream)) grouped.set(stream, { issues: [], prs: [] });
    const group = grouped.get(stream);
    if (!group) continue;
    if (item.isPR) group.prs.push(item);
    else group.issues.push(item);
  }

  return [...grouped.entries()]
    .map(([stream, group]) => {
      const roots = buildStreamRoots(group.issues, group.prs);
      const updatedAt = roots.reduce((latest, root) => {
        const next = chainUpdatedAt(root);
        return next > latest ? next : latest;
      }, "");
      return {
        stream,
        roots,
        updatedAt,
        issueCount: group.issues.length,
        prCount: group.prs.length,
      };
    })
    .filter((group) => group.roots.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.stream - b.stream);
}
