import type { Sandbox } from "../../runtime/sandbox/index.js";

export interface Skill { readonly name: string; readonly instructions: string }
/** Skills supply instructions only; they cannot grant permissions or execute scripts. */
export class SkillRegistry {
  readonly #skills = new Map<string, Skill>();
  register(skill: Skill): () => boolean {
    if (!skill.name || this.#skills.has(skill.name)) throw new Error(`Duplicate or empty skill: ${skill.name}`);
    const entry = Object.freeze({ ...skill });
    this.#skills.set(skill.name, entry);
    return () => this.#skills.get(skill.name) === entry && this.#skills.delete(skill.name);
  }
  async load(name: string, path: string, sandbox: Sandbox): Promise<() => boolean> {
    sandbox.assert("skills", name);
    return this.register({ name, instructions: await sandbox.readText(path) });
  }
  get(name: string, sandbox: Sandbox): Skill {
    sandbox.assert("skills", name);
    const skill = this.#skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill;
  }
  list(): readonly string[] { return [...this.#skills.keys()]; }
}
