import { createHash } from 'node:crypto'
import { assertObjectJsonSchema, assertToolRestriction } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'

interface ArchitectureNode {
  id: string
  role: string
  prompt: string
  dependencies: string[]
  provider?: string
  model?: string
  schema?: ObjectJsonSchema
  persona?: string
  toolFilter?: ToolRestriction
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('architecture must contain JSON objects')
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`architecture ${field} must be a non-empty string`)
  return value
}

/**
 * Compile a model-authored architecture into the existing workflow runtime.
 * @param value - JSON graph with role, prompt, dependency and model choices.
 * @returns the normalized definition, content digest and compiled workflow body.
 */
export function prepareArchitecture(value: unknown): { version: string; architecture: { nodes: ArchitectureNode[] }; script: string } {
  const graph = object(value)
  if (Object.keys(graph).some(key => key !== 'nodes')) throw new Error('architecture accepts only nodes')
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error('architecture requires at least one node')
  const nodes: ArchitectureNode[] = graph.nodes.map((value: unknown) => {
    const row = object(value)
    if (Object.keys(row).some(key => !['id', 'role', 'prompt', 'dependencies', 'provider', 'model', 'schema', 'persona', 'toolFilter'].includes(key))) {
      throw new Error('architecture node contains an unsupported field')
    }
    if (!Array.isArray(row.dependencies)) throw new Error('architecture dependencies must be an array')
    const dependencies = row.dependencies.map((dependency: unknown) => text(dependency, 'dependency'))
    if (new Set(dependencies).size !== dependencies.length) throw new Error('architecture dependencies must be unique')
    if (row.schema !== undefined) assertObjectJsonSchema(row.schema)
    if (row.toolFilter !== undefined) assertToolRestriction(row.toolFilter)
    return {
      id: text(row.id, 'id'), role: text(row.role, 'role'), prompt: text(row.prompt, 'prompt'),
      dependencies: dependencies.sort(),
      ...row.provider === undefined ? {} : { provider: text(row.provider, 'provider') },
      ...row.model === undefined ? {} : { model: text(row.model, 'model') },
      ...row.schema === undefined ? {} : { schema: row.schema },
      ...row.persona === undefined ? {} : { persona: text(row.persona, 'persona') },
      ...row.toolFilter === undefined ? {} : { toolFilter: {
        ...row.toolFilter.allow === undefined ? {} : { allow: [...new Set(row.toolFilter.allow)].sort() },
        ...row.toolFilter.deny === undefined ? {} : { deny: [...new Set(row.toolFilter.deny)].sort() },
      } },
    }
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length) throw new Error('architecture node ids must be unique')
  for (const node of nodes) {
    if (node.dependencies.some(id => !ids.has(id))) throw new Error(`architecture node ${node.id} has an unknown dependency`)
  }
  const remaining = new Map(nodes.map(node => [node.id, node]))
  const completed = new Set<string>()
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter(node => node.dependencies.every(id => completed.has(id)))
    if (ready.length === 0) throw new Error('architecture contains a dependency cycle')
    for (const node of ready) { remaining.delete(node.id); completed.add(node.id) }
  }
  const version = createHash('sha256').update(JSON.stringify({ format: 1, nodes })).digest('hex')
  // Data stays JSON-quoted; prompts never become executable source.
  const script = `const nodes = ${JSON.stringify(nodes)};
const byId = new Map(nodes.map(node => [node.id, node]));
const pending = new Map();
const outputs = Object.create(null);
function run(id) {
  if (pending.has(id)) return pending.get(id);
  const node = byId.get(id);
  const result = (async () => {
    const context = await Promise.all(node.dependencies.map(async id => ({ id, output: await run(id) })));
    if (context.some(item => item.output === null)) throw new Error('architecture dependency failed: ' + node.id);
    const prompt = JSON.stringify({ role: node.role, task: node.prompt, input: args, dependencies: context });
    const options = { label: node.id };
    if (node.provider !== undefined) options.provider = node.provider;
    if (node.model !== undefined) options.model = node.model;
    if (node.schema !== undefined) options.schema = node.schema;
    if (node.persona !== undefined) options.persona = node.persona;
    if (node.toolFilter !== undefined) options.toolFilter = node.toolFilter;
    return outputs[node.id] = await agent(prompt, options);
  })();
  pending.set(id, result);
  return result;
}
await Promise.all(nodes.map(node => run(node.id)));
if (Object.values(outputs).some(value => value === null)) throw new Error('architecture member failed');
return { architectureVersion: ${JSON.stringify(version)}, outputs };`
  return { version, architecture: { nodes }, script }
}

/**
 * Compile a graph into the existing workflow runtime.
 * @param value - Model-authored JSON graph.
 * @returns the plain JavaScript workflow body.
 */
export function compileArchitecture(value: unknown): string {
  return prepareArchitecture(value).script
}

/**
 * Select exactly one workflow representation at the tool boundary.
 * @param script - optional authored workflow script.
 * @param architecture - optional declarative graph.
 * @returns the body passed to the native workflow engine.
 */
export function resolveWorkflowBody(script: string | undefined, architecture: unknown): string {
  if ((script === undefined) === (architecture === undefined)) throw new Error('Provide exactly one of script or architecture')
  return architecture === undefined ? text(script, 'script') : compileArchitecture(architecture)
}
