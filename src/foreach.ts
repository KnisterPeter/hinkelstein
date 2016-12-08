import * as commonTags from 'common-tags';

export function forEach<T, R>(list: T[], task: (task: T) => boolean|R|Promise<boolean|R>): Promise<boolean|R> {
  return list.reduce(async (promise, entry) => {
    const continueReduce = await promise;
    if (continueReduce === false) {
      console.log(`\n${commonTags.stripIndent`
        -------------------------------------------------------------------------------

          Skipping ${entry}

        -------------------------------------------------------------------------------
      `}\n`);
      return false;
    }
    return task(entry);
  }, Promise.resolve(true));
}
