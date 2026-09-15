import type { Skill } from "../../contracts/common.js";
import type { Sandbox } from "../../runtime/sandbox/index.js";
import { createNodeScaffold } from "../node-scaffold.js";

export const memorySkillNode = createNodeScaffold("MEMORY.SKILL");

/** Process-local reference registry; durable stores can implement the Node directly. */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();

  register(skill: Skill): () => boolean {
    const key = `${skill.name}@${skill.version ?? "latest"}`;
    if (!skill.name || this.#skills.has(key)) throw new Error(`Duplicate or empty skill: ${key}`);
    const entry = Object.freeze({ ...skill });
    this.#skills.set(key, entry);
    return () => this.#skills.get(key) === entry && this.#skills.delete(key);
  }

  async load(name: string, path: string, sandbox: Sandbox, version?: string): Promise<() => boolean> {
    sandbox.assert("skills", name);
    return this.register({ name, ...(version ? { version } : {}), instructions: await sandbox.readText(path) });
  }

  get(name: string, sandbox: Sandbox, version?: string): Skill {
    sandbox.assert("skills", name);
    const skill = this.#skills.get(`${name}@${version ?? "latest"}`);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill;
  }
}
