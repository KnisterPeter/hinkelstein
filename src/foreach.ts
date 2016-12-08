import * as commonTags from 'common-tags';

export function forEach<T>(list: T[], task: (task: T) => boolean | T | Promise<boolean | T>): Promise<T> {
  return list.reduce((promise, entry) => {
    return promise.then(continueReduce => {
      if (continueReduce === false) {
        console.log(`\n${commonTags.stripIndent`
          -------------------------------------------------------------------------------

            Skipping ${entry}

          -------------------------------------------------------------------------------
        `}\n`);
        return false;
      }
      return task(entry);
    });
  }, Promise.resolve(true as any));
}
