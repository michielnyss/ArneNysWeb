// One save to the site's repo: read main, plan the commit (save.js), and
// commit it, re-planning if main moved in between. Used by Save in the
// website editor and by Publish in the archive.

import { commit, snapshot } from './github.js';
import { planSave } from './save.js';

/**
 * `build(snapshot)` returns the save request (see planSave) for the repo as
 * it is now. With `dry`, nothing is written: the result says what would be.
 * @returns {{ head, noop?, dryRun?, message, files: {path, action}[], changed, saved }}
 */
export async function saveToRepo(env, build, user, dry) {
  for (let attempt = 0; ; attempt++) {
    const s = await snapshot(env);
    const plan = planSave(s, build(s), user);
    const summary = {
      message: plan.message,
      files: plan.entries.map((e) => ({ path: e.path, action: e.sha === null ? 'delete' : 'write' })),
      changed: plan.changed,
      saved: plan.saved,
    };
    if (plan.noop) return { noop: true, head: s.head, ...summary };
    if (dry) return { dryRun: true, head: s.head, ...summary };
    try {
      const sha = await commit(env, { head: s.head, tree: s.tree, entries: plan.entries, message: plan.message });
      console.log('commit', sha, plan.changed.map((c) => `${c.action}:${c.slug}`).join(' '));
      return { head: sha, ...summary };
    } catch (e) {
      if (e.status === 422 && attempt < 2) continue; // main moved; re-plan on the new head
      throw e;
    }
  }
}
