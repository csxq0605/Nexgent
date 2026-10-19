/**
 * The built-in presets (`data-formats.md` §预设). Fields only, no code:
 * the read-only presets narrow the member to `read-only`; the general
 * executor inherits the parent's sandbox mode and tools; the explorer
 * (rework K4, audit D11) is a light read-only searcher: low effort, no
 * thinking, at most 24 model calls per run, on the parent's model.
 */
import { BUILTIN_PRESET_NAMES, type AgentPreset } from '@nexgent/kernel'

/** Name of a built-in preset. */
export type BuiltinPresetName = (typeof BUILTIN_PRESET_NAMES)[number]

/** Preset a member gets when the caller names none. */
export const DEFAULT_PRESET_NAME: BuiltinPresetName = 'general-executor'

const SHARED = 'You are a member of a larger task: another agent gave you one sub-task and will read your final reply. '
  + 'Work only on that sub-task, inside the project working directory. '

/** The built-in presets by name, in {@link BUILTIN_PRESET_NAMES} order. */
export const BUILTIN_PRESETS: Readonly<Record<BuiltinPresetName, AgentPreset>> = {
  'read-only-analyst': {
    name: 'read-only-analyst',
    description: 'Reads files and materials and reports findings; changes nothing.',
    persona: `${SHARED}You are an analyst running on the {{model}} model. `
      + 'Read the files and materials you were pointed to, investigate with read-only tools, and answer with concrete findings: '
      + 'what you found, where (file and line or cell), and how sure you are. You cannot change files; do not try.',
    sandboxMode: 'read-only',
  },
  'read-only-checker': {
    name: 'read-only-checker',
    description: 'Checks a result against stated requirements and reports pass or fail with evidence; changes nothing.',
    persona: `${SHARED}You are a checker running on the {{model}} model. `
      + 'Check the named result against each stated requirement using read-only tools. '
      + 'For every requirement say pass or fail with the evidence you saw (file, line, value or command output); '
      + 'end with one line: overall pass or fail. Do not fix anything; you cannot change files.',
    sandboxMode: 'read-only',
  },
  'general-executor': {
    name: 'general-executor',
    description: 'Does the sub-task with the same tools and sandbox mode as the main conversation, and presents its output files.',
    persona: `${SHARED}You are an executor running on the {{model}} model. `
      + 'Complete the sub-task with the available tools. Change or create the files the task names, where it names them; '
      + 'other members may be working in the same project at the same time, so keep to the files your task covers. '
      + 'Verify your work and hand new output files back with present. End with a short reply: what you produced or changed, where, and anything left open.',
  },
  explorer: {
    name: 'explorer',
    description: 'Quick, low-cost search of the project to answer a question (where something is, how something works); changes nothing.',
    persona: `${SHARED}You are an explorer running on the {{model}} model. `
      + 'Find what the question asks with read-only tools (list, search and read files), as directly as you can. '
      + 'Answer briefly with what you found and where (file and line); say what you could not find. You cannot change files; do not try.',
    sandboxMode: 'read-only',
    effort: 'low',
    thinking: 'off',
    maxSteps: 24,
  },
}

/** Whether `name` is a built-in preset. */
export function isBuiltinPresetName(name: string): name is BuiltinPresetName {
  return (BUILTIN_PRESET_NAMES as readonly string[]).includes(name)
}
