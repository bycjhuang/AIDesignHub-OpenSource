import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'adh-skill-policy';
export const inject = ['skills'];

/** Adapt a public skill provider without modifying the global registry. */
export function filterSkillProvider(provider, excludedSkillIds) {
  const excluded = new Set(excludedSkillIds);
  const allowed = candidate => candidate && !excluded.has(candidate.name);
  return {
    name: provider.name,
    async list(options) {
      const value = await provider.list(options);
      return Array.isArray(value) ? value.filter(allowed)
        : { ...value, candidates: value.candidates.filter(allowed) };
    },
    async get(candidate, options) {
      if (!allowed(candidate)) return undefined;
      const definition = await provider.get(candidate, options);
      return definition && allowed(definition) ? definition : undefined;
    },
  };
}

/**
 * The upstream plugin still owns discovery, ranks, cwd-sensitive roots, reads,
 * watchers and invalidation. This facade adapts only its public provider
 * registration, before candidates enter the real registry and model catalog.
 */
export async function apply(ctx, config = {}) {
  if (typeof config.filesystemModule !== 'string' || !isAbsolute(config.filesystemModule)) {
    throw new TypeError('adh-skill-policy requires the pinned filesystem module path');
  }
  if (!Array.isArray(config.excludedSkillIds) || config.excludedSkillIds.some(value => typeof value !== 'string')) {
    throw new TypeError('adh-skill-policy requires an explicit excludedSkillIds array');
  }
  const upstream = await import(pathToFileURL(config.filesystemModule).href);
  if (typeof upstream.apply !== 'function') throw new Error('ADH_SKILL_POLICY_UNSUPPORTED_FILESYSTEM');
  const facade = {
    skills: {
      registerProvider(factory) {
        return ctx.skills.registerProvider(control => filterSkillProvider(factory(control), config.excludedSkillIds));
      },
    },
    effect: ctx.effect.bind(ctx),
    on: ctx.on.bind(ctx),
    get: ctx.get.bind(ctx),
    get logger() { return ctx.logger; },
    get fs() { return ctx.get('fs'); },
  };
  await upstream.apply(facade, config.filesystem ?? {});
}
