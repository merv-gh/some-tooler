import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, basename } from 'path';

// ═══════════════════════════════════════════════════════════════
// Skills loader — reads .claude/skills/ SKILL.md files
// Makes them available as invocable tools in the UI
// ═══════════════════════════════════════════════════════════════

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  /** Full markdown content of SKILL.md */
  content: string;
  /** Path to the SKILL.md file */
  path: string;
}

/**
 * Scan for skills in standard locations:
 *  1. <projectDir>/.claude/skills/
 *  2. <workspaceRoot>/.claude/skills/  (tooler-level)
 *
 * Each skill is a folder containing SKILL.md with YAML frontmatter.
 */
export function loadSkills(dirs: string[]): SkillDef[] {
  const skills: SkillDef[] = [];
  const seen = new Set<string>();

  for (const baseDir of dirs) {
    const skillsDir = join(baseDir, '.claude', 'skills');
    if (!existsSync(skillsDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(skillsDir);
    } catch { continue; }

    for (const entry of entries) {
      const entryPath = join(skillsDir, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      const skillFile = join(entryPath, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const id = `skill.${entry}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const raw = readFileSync(skillFile, 'utf-8');
      const { name, description } = parseFrontmatter(raw, entry);

      skills.push({ id, name, description, content: raw, path: skillFile });
    }
  }

  return skills;
}

/**
 * Parse YAML frontmatter from SKILL.md.
 * Expects --- delimited block at top with name: and description: fields.
 */
function parseFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  let name = fallbackName;
  let description = '';

  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (match) {
    const fm = match[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    if (nameMatch) name = nameMatch[1].trim();
    if (descMatch) description = descMatch[1].trim();
  }

  // Truncate long descriptions for UI
  if (description.length > 200) description = description.slice(0, 197) + '...';

  return { name, description };
}

/**
 * Build a prompt that includes the skill's full instructions
 * plus the user's specific request.
 */
export function buildSkillPrompt(skill: SkillDef, userPrompt: string): string {
  // Strip frontmatter for the actual instructions
  const instructions = skill.content.replace(/^---[\s\S]*?---\n*/, '').trim();

  return `You are executing the "${skill.name}" skill.

## Skill Instructions
${instructions}

## User Request
${userPrompt}

Follow the skill instructions above to fulfill the user's request. Output working code in fenced code blocks.`;
}
