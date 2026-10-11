// Adapted from deepseek-harness@46a7f68b packages/workflow/tool-workflow (MIT), via Nexgent PR #4 runtime/packages/workflow/tool-workflow/src/architecture.ts (refactor/dsh-application fd0b2f42)
/**
 * Declarative workflow graphs (`data-formats.md` §架构图存储, contract
 * `ArchitectureGraph`): validate and normalize a model-written graph, hash
 * it, and compile it into a workflow script that calls `agent()` once per
 * node after the node's dependencies. Pure.
 *
 * Normalization: nodes sorted by `id`, each node's `dependencies` sorted and
 * de-duplicated, `tools.allow` / `tools.deny` sorted and de-duplicated, only
 * the contract's fields kept. The version is the lowercase hex SHA-256 of
 * `JSON.stringify({ format: 1, nodes })` over the normalized nodes. Errors
 * (unknown field, bad id, duplicate id, unknown dependency, cycle, too many
 * nodes) are `tool/invalid-input` with a message naming the node.
 */
import { createHash } from 'node:crypto'
import {
  assertToolRestriction,
  COLLABORATION_LIMITS,
  MEMBER_NAME_PATTERN,
  NexgentError,
  type ArchitectureGraph,
  type ArchitectureNode,
  type ToolRestriction,
} from '@nexgent/kernel'

const NODE_FIELDS = ['id', 'prompt', 'dependencies', 'preset', 'tools', 'model'] as const

/** A validated graph, its content version, and the script that runs it. */
export interface PreparedArchitecture {
  /** Lowercase hex SHA-256 of the normalized graph. */
  readonly version: string
  readonly architecture: ArchitectureGraph
  /** Workflow script body (see {@link compileArchitecture}). */
  readonly script: string
}

function invalid(message: string): NexgentError {
  return new NexgentError('tool/invalid-input', `graph: ${message}`)
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${what} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${what} must be a non-empty string`)
  return value
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function normalizeTools(value: unknown, id: string): ToolRestriction {
  try {
    assertToolRestriction(value)
  } catch (error) {
    throw invalid(`node ${id}: ${(error as Error).message}`)
  }
  return {
    ...(value.allow === undefined ? {} : { allow: sortedUnique(value.allow) }),
    ...(value.deny === undefined ? {} : { deny: sortedUnique(value.deny) }),
  }
}

function normalizeNode(value: unknown, index: number): ArchitectureNode {
  const row = object(value, `node ${index + 1}`)
  const id = text(row.id, `node ${index + 1} id`)
  if (!MEMBER_NAME_PATTERN.test(id)) throw invalid(`node id ${JSON.stringify(id)} must be lowercase letters, digits and dashes, starting with a letter (at most 32 characters)`)
  const extra = Object.keys(row).filter(key => !(NODE_FIELDS as readonly string[]).includes(key))
  if (extra.length > 0) throw invalid(`node ${id} has unsupported fields: ${extra.join(', ')}`)
  if (!Array.isArray(row.dependencies)) throw invalid(`node ${id} dependencies must be an array of node ids`)
  const dependencies = sortedUnique(row.dependencies.map((dependency: unknown) => text(dependency, `node ${id} dependency`)))
  return {
    id,
    prompt: text(row.prompt, `node ${id} prompt`),
    dependencies,
    ...(row.preset === undefined ? {} : { preset: text(row.preset, `node ${id} preset`) }),
    ...(row.tools === undefined ? {} : { tools: normalizeTools(row.tools, id) }),
    ...(row.model === undefined ? {} : { model: text(row.model, `node ${id} model`) }),
  }
}

/** Validate and normalize an untrusted graph. @throws `tool/invalid-input`. */
export function normalizeArchitecture(value: unknown): ArchitectureGraph {
  const graph = object(value, 'the graph')
  const extra = Object.keys(graph).filter(key => key !== 'nodes')
  if (extra.length > 0) throw invalid(`only "nodes" is accepted, got ${extra.join(', ')}`)
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw invalid('needs at least one node')
  if (graph.nodes.length > COLLABORATION_LIMITS.maxGraphNodes) throw invalid(`has ${graph.nodes.length} nodes; at most ${COLLABORATION_LIMITS.maxGraphNodes}`)
  const nodes = graph.nodes.map(normalizeNode).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const seen = new Set<string>()
  for (const node of nodes) {
    if (seen.has(node.id)) throw invalid(`node id ${node.id} appears twice`)
    seen.add(node.id)
  }
  for (const node of nodes) {
    const unknown = node.dependencies.filter(id => !seen.has(id))
    if (unknown.length > 0) throw invalid(`node ${node.id} depends on unknown node${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`)
    if (node.dependencies.includes(node.id)) throw invalid(`node ${node.id} depends on itself`)
  }
  const remaining = new Map(nodes.map(node => [node.id, node]))
  const done = new Set<string>()
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(node => node.dependencies.every(id => done.has(id)))
    if (ready.length === 0) throw invalid(`dependency cycle among ${[...remaining.keys()].join(', ')}`)
    for (const node of ready) {
      remaining.delete(node.id)
      done.add(node.id)
    }
  }
  return { nodes }
}

/** The content version of a normalized graph. */
export function architectureVersion(graph: ArchitectureGraph): string {
  return createHash('sha256').update(JSON.stringify({ format: 1, nodes: graph.nodes })).digest('hex')
}

/**
 * The workflow script for a normalized graph. Node data is embedded as JSON,
 * so prompts never become source. Each node runs once, after all its
 * dependencies, as `agent(prompt, { name: id, preset?, tools?, model? })`;
 * its prompt is the node prompt, then `args` (when given), then each
 * dependency's reply and presented files. A failed member rejects its
 * `agent()` call, which fails every node that depends on it and the run.
 * The script returns `{ architecture: <version>, outputs: { <id>: text } }`.
 */
export function compileArchitecture(graph: ArchitectureGraph, version: string = architectureVersion(graph)): string {
  return `const nodes = ${JSON.stringify(graph.nodes)};
const byId = new Map(nodes.map(node => [node.id, node]));
const running = new Map();
const outputs = {};
const describe = (id, result) => {
  const files = result.deliverables.flatMap(version => version.files.map(file => file.path));
  return 'Result of ' + id + ':\\n' + result.text + (files.length > 0 ? '\\nFiles presented by ' + id + ': ' + files.join(', ') : '');
};
function run(id) {
  if (running.has(id)) return running.get(id);
  const node = byId.get(id);
  const promise = (async () => {
    const inputs = await Promise.all(node.dependencies.map(async dependency => describe(dependency, await run(dependency))));
    const parts = [node.prompt];
    if (args !== undefined && args !== null) parts.push('Input:\\n' + JSON.stringify(args, null, 2));
    parts.push(...inputs);
    const options = { name: node.id };
    if (node.preset !== undefined) options.preset = node.preset;
    if (node.tools !== undefined) options.tools = node.tools;
    if (node.model !== undefined) options.model = node.model;
    const result = await agent(parts.join('\\n\\n'), options);
    outputs[node.id] = result.text;
    return result;
  })();
  running.set(id, promise);
  return promise;
}
const settled = await Promise.allSettled(nodes.map(node => run(node.id)));
const failed = settled.find(item => item.status === 'rejected');
if (failed !== undefined) throw failed.reason;
return { architecture: ${JSON.stringify(version)}, outputs };`
}

/** Validate, normalize, hash and compile a model-written graph. @throws `tool/invalid-input`. */
export function prepareArchitecture(value: unknown): PreparedArchitecture {
  const architecture = normalizeArchitecture(value)
  const version = architectureVersion(architecture)
  return { version, architecture, script: compileArchitecture(architecture, version) }
}
