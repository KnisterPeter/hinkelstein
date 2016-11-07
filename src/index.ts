import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import * as commonTags from 'common-tags';
import * as fsExtra from 'fs-extra';
import * as NpmRegistryClient from 'npm-registry-client';
import * as conventionalCommitsParser from 'conventional-commits-parser';
import * as semver from 'semver';

const gitlog = util.debuglog('git');
const npmlog = util.debuglog('npm');

function promisify(fn: Function): (...args: any[]) => Promise<any> {
  return function (...args): Promise<any> {
    return new Promise((resolve, reject) => {
      fn.apply(null, ([] as any[]).concat(args, function (...resultArgs: any[]): void {
        if (resultArgs[0]) {
          return reject(resultArgs[0]);
        }
        resolve.apply(null, resultArgs.slice(1));
      }));
    });
  };
}

const fsReaddir: (path: string) => Promise<string[]> = promisify(fs.readdir);
const fsReadfile: (path: string) => Promise<string> = promisify(fs.readFile);
const fsOutputFile: (path: string, data: string) => Promise<void> = promisify(fsExtra.outputFile);
const fsCopy: (from: string, to: string) => Promise<void> = promisify(fsExtra.copy);
const fsMove: (from: string, to: string, opts?: any) => Promise<void> = promisify((fsExtra  as any).move);
const fsRemove: (path: string) => Promise<void> = promisify(fsExtra.remove);
const fsReadJson: (path: string) => Promise<any> = promisify(fsExtra.readJson);
const fsWriteJson: (path: string, data: any) => Promise<void> = promisify(fsExtra.writeJson);

const packagesDirectory = path.join(process.cwd(), 'packages');

interface PackageJson {
  name: string;
  version: string;
  scripts: {
    [name: string]: string;
  };
  devDependencies: {
    [name: string]: string;
  };
  dependencies: {
    [name: string]: string;
  };
  publishConfig?: any;
}

function forEach<T>(list: T[], task: (task: T) => Promise<boolean>): Promise<void> {
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
  }, Promise.resolve(true));
}

function getPackages(): Promise<string[]> {
  return fsReaddir(packagesDirectory);
}

function readAllPackageJsonFiles(list: string[]): Promise<PackageJson[]> {
  return Promise.all(list.map(file => getPackageJson(file)));
}

function sortDependencys(list: string[], pkgs: PackageJson[]): string[] {
  list.sort((left, right) => {
    let pkg = pkgs.find(needle => right === needle.name);
    if (!pkg) {
      throw new Error('No matching package.json found');
    }
    if (left in pkg.devDependencies || left in pkg.dependencies) {
      return -1;
    }
    pkg = pkgs.find(needle => left === needle.name);
    if (!pkg) {
      throw new Error('No matching package.json found');
    }
    if (right in pkg.devDependencies || right in pkg.dependencies) {
      return 1;
    }
    return 0;
  });
  return list;
}

function getOrderedPackages(): Promise<string[]> {
  return getPackages()
    .then(packages =>
      readAllPackageJsonFiles(packages)
        .then(pkgs => ({packages, pkgs})))
    .then(context => sortDependencys(context.packages, context.pkgs));
}

function getPackageJson(packageDir: string): Promise<PackageJson> {
  return fsReadJson(path.join(packagesDirectory, packageDir, 'package.json'));
}

function patchPackageJson(pkg: PackageJson): Promise<PackageJson> {
  return getPackages()
    .then(packages => {
      packages.forEach(file => delete pkg.devDependencies[file]);
      packages.forEach(file => delete pkg.dependencies[file]);
    })
    .then(() => pkg);
}

function npm(packageDir: string, command: string): Promise<void> {
  return Promise.resolve()
    .then(() => {
      const opts = {
        cwd: path.join(packagesDirectory, packageDir),
        env: process.env,
        stdio: 'inherit'
      };
      const cmd = `npm ${command}`;
      npmlog(`executing '${cmd}'`);
      childProcess.execSync(cmd, opts);
    });
}

function getPackageDependencies(pkg: PackageJson): Promise<string[]> {
  return getPackages()
    .then(packages => {
      return ([] as string[]).concat(
        packages.filter(file => file in pkg.devDependencies),
        packages.filter(file => file in pkg.dependencies)
      );
    });
}

function linkDependencies(packageDir: string): Promise<void> {
  return getPackages()
    .then(() => {
      return getPackageJson(packageDir)
        .then(pkg => getPackageDependencies(pkg))
        .then(dependencies => {
          return forEach(dependencies,
              dependency => {
                const dependecyModulPath = path.join(packagesDirectory, packageDir, 'node_modules', dependency);
                return fsOutputFile(path.join(dependecyModulPath, 'index.js'),
                    `module.exports = require('../../../${dependency}/')`)
                  .then(() => fsOutputFile(path.join(dependecyModulPath, 'index.d.ts'),
                    `export * from '../../../${dependency}/index';`));
              });
        });
    });
}

function withPatchedPackageJson(packageDir: string, fn: () => Promise<void>): Promise<void> {
  const packageJsonPath = path.join(packagesDirectory, packageDir, 'package.json');
  const packageJsonBackupPath = path.join(packagesDirectory, packageDir, 'package.json.orig');
  return fsCopy(packageJsonPath, packageJsonBackupPath)
    .then(() => {
      return fsReadJson(packageJsonPath)
        .then(pkg => patchPackageJson(pkg))
        .then(pkg => fsWriteJson(packageJsonPath, pkg))
        .then(() => fn())
        .catch(err => {
          return fsMove(packageJsonBackupPath, packageJsonPath, {clobber: true})
            .then(() => {
              throw err;
            });
        });
    })
    .then(() => fsMove(packageJsonBackupPath, packageJsonPath, {clobber: true}));
}

function remoteNpmGet(packageDir: string): Promise<NpmRegistryClient.Data> {
  return new Promise((resolve, reject) => {
    const noop = () => undefined;
    const client = new NpmRegistryClient({
      log: {
        error: noop,
        warn: noop,
        info: noop,
        verbose: noop,
        silly: noop,
        http: noop,
        pause: noop,
        resume: noop
      }
    });
    const params = {
      timeout: 1000
    };
    return client
      .get(`https://registry.npmjs.org/${packageDir}`, params, (err, data) => {
        if (err) {
          if (err.statusCode === 404) {
            return resolve(undefined);
          }
          return reject(err);
        }
        resolve(data);
      });
  });
}

interface ReleaseData {
  npm: NpmRegistryClient.Data;
  pkg: PackageJson;
  commits: conventionalCommitsParser.CommitMessage[];
  tag?: string;
  nextVersion?: string;
  release?: string;
  lastVersion?: string;
  lastGitHash?: string;
  requireRelease?: boolean;
}

function getReleaseData(packageDir: string, npm: NpmRegistryClient.Data): Promise<ReleaseData> {
  return Promise.resolve()
    .then(() => getPackageJson(packageDir)
        .then(pkg => ({
          npm,
          pkg
        } as ReleaseData)))
    .then(data => {
      data.tag = ((data.pkg.publishConfig || {}).tag || 'latest') as string;
      if (data.npm) {
        data.lastVersion = data.npm['dist-tags'][data.tag];
        if (data.lastVersion) {
          const npmVersionData = data.npm.versions[data.lastVersion];
          data.lastGitHash = npmVersionData.gitHead || `${npmVersionData.name}-${npmVersionData.version}`;
        }
      }
      return data;
    })
    .then(data => {
      if (!data.lastGitHash) {
        return git(packageDir, 'rev-list --abbrev-commit --max-parents=0 HEAD')
          .then(firstGitHash => {
            data.lastGitHash = firstGitHash;
            return data;
          });
      }
      return data;
    });
}

interface Commit {
  hash: string;
  rawMessage: string;
  message: conventionalCommitsParser.CommitMessage;
}

function getReleaseCommits(packageDir: string, data: ReleaseData): Promise<ReleaseData> {
  return Promise.resolve()
    .then(() => {
      return git(packageDir, `log --extended-regexp --format=%h==HASH==%B==END== ${data.lastGitHash}..HEAD -- .`)
        .then(stdout => stdout.split('==END==\n'))
        .then(commits => commits.filter(commit => Boolean(commit.trim())))
        .then(commits => commits.map(commit => {
          const parts = commit.split('==HASH==');
          return {
            hash: parts[0],
            rawMessage: parts[1]
          } as Commit;
        }))
        .then(commits => commits.map(commit => {
          commit.message = conventionalCommitsParser.sync(commit.rawMessage);
          commit.message.hash = commit.hash;
          return commit.message;
        }))
        .then(commits => commits.filter(commit => commit.scope === packageDir))
        .then(commits => {
          data.commits = commits;
          data.requireRelease = data.commits.length > 0;
        })
        .then(() => {
          const didUpdatePackageJson = (commit: conventionalCommitsParser.CommitMessage) => {
            return git(packageDir, `show ${commit.hash}`)
              .then(diff => {
                commit.updatesPackageJson = diff.indexOf(`packages/${packageDir}/package.json`) > -1;
              });
          };
          return Promise.resolve()
            .then(() => forEach(data.commits, commit => didUpdatePackageJson(commit)))
            .then(() => data);
        });
    });
}

function isBreakingChange(commit: conventionalCommitsParser.CommitMessage): boolean {
  return Boolean(commit.footer && commit.footer.indexOf('BREAKING CHANGE:\n') > -1);
}

function getNextVersion(_packageDir: string, data: ReleaseData): Promise<ReleaseData> {
  const releases = ['patch', 'minor', 'major'];
  const typeToReleaseIndex = {
    fix: 0,
    feat: 1
  };

  return Promise.resolve()
    .then(() => {
      const relaseIndex = data.commits.reduce((release, commit) => {
        let result = release > (typeToReleaseIndex[commit.type] || 0) ?
          release :
          typeToReleaseIndex[commit.type] || release;
        if (isBreakingChange(commit)) {
          result = 2;
        }
        return result;
      }, 0);
      data.release = releases[relaseIndex];
      if (data.lastVersion) {
        data.nextVersion = semver.inc(data.lastVersion, data.release);
      } else {
        data.nextVersion = data.pkg.version;
      }
      return data;
    });
}

function git(packageDir: string, command: string): Promise<string> {
  return Promise.resolve()
    .then(() => {
      const opts = {
        cwd: path.join(packagesDirectory, packageDir),
        env: process.env
      };
      const cmd = `git ${command}`;
      gitlog(`executing '${cmd}'`);
      return childProcess.execSync(cmd, opts);
    })
    .then(buffer => buffer.toString().trim());
}

function runOnPackages(commands: Commands, command: string, args: string[]): Promise<void> {
  return getOrderedPackages()
    .then(packages => {
      return forEach(packages, file => {
        return commands[command].apply(null, ([] as any).concat([file], args));
      });
    });
}

function runCommandBootstrap(packageDir: string): Promise<void> {
  return Promise.resolve()
    .then(() => {
      return withPatchedPackageJson(packageDir, () => {
        return npm(packageDir, 'install')
          .then(() => npm(packageDir, 'prune'));
      })
      .then(() => linkDependencies(packageDir));
    });
}

function runCommandReset(packageDir: string): Promise<void> {
  return fsRemove(path.join(packagesDirectory, packageDir, 'node_modules'));
}

function updatePackageJson(packageDir: string, fn: (input: string) => string): Promise<void> {
  const packageJson = path.join(packagesDirectory, packageDir, 'package.json');
  return fsReadfile(packageJson)
    .then(buffer => buffer.toString())
    .then(data => fn(data))
    .then(data => fsOutputFile(packageJson, data));
}

function incrementPackageVersion(packageDir: string, data: ReleaseData): Promise<void> {
  return updatePackageJson(packageDir, content =>
    content.replace(/^(\s*"version"\s*:\s*")\d+(?:\.\d+(?:\.\d+)?)?("\s*(?:,\s*)?)$/gm, `$1${data.nextVersion}$2`));
}

function updateDependencies(packageDir: string, data: ReleaseData): Promise<void> {
  return getPackages()
    .then(packages => forEach(packages, dependency => {
      if (dependency in data.pkg.devDependencies || dependency in data.pkg.dependencies) {
        return getPackageJson(dependency)
          .then(pkg => updatePackageJson(packageDir, content =>
            content.replace(new RegExp(
              `^(\\s*"${dependency}"\\s*:\\s*")\\d+(?:\\.\\d+(?:\\.\\d+)?)?("\\s*(?:,\\s*)?)$`, 'gm'),
              `$1${pkg.version}$2`)));
      }
      return Promise.resolve(true);
    }));
}

function runCommandRelease(packageDir: string): Promise<void> {
  return git('..', `status --porcelain`)
    .then(stdout => {
      if (stdout !== '') {
        throw new Error('Git workspace not clean!');
      }
    })
    .then(() => remoteNpmGet(packageDir))
    .then(npm => getReleaseData(packageDir, npm))
    .then(data => getReleaseCommits(packageDir, data))
    .then(data => getNextVersion(packageDir, data))
    .then(data => {
      if (data.requireRelease) {
        outputReleaseSummary(packageDir, data);
        return incrementPackageVersion(packageDir, data)
          .then(() => updateDependencies(packageDir, data))
          .then(() => runCommandNpmRun(packageDir, 'release'))
          .then(() => runCommandNpmRun(packageDir, 'test'))
          .then(() => git('..', `status --porcelain`))
          .then(stdout => {
            if (stdout !== '') {
              const commitMsg = `chore(${packageDir}): releases ${data.nextVersion}\n\n` +
                getCommitList('* ', '\n', data);
              return git('..', `add .`)
                .then(() => git('..', `commit -m "${commitMsg}"`))
                .then(() => false);
            }
            return true;
          });
      }
      console.log(`No release for ${packageDir} required`);
      return true;
    });
}

function outputReleaseSummary(packageDir: string, data: ReleaseData): void {
  console.log(commonTags.stripIndent`
    Release test for ${packageDir} results:
      * Required: ${data.requireRelease}
      * Version increment: ${data.release}
      * Next Version: ${data.nextVersion}

      Commits:
  `);
  console.log(getCommitList('    ', '\n', data));
}

function getCommitList(prepend: string, append: string, data: ReleaseData): string {
  return data.commits
    .map(commit => `${prepend}${commit.header}${isBreakingChange(commit) ? ' (BREAKING)' : ''}${append}`)
    .join('');
}

function runCommandTestRelease(packageDir: string): Promise<void> {
  return remoteNpmGet(packageDir)
    .then(npm => getReleaseData(packageDir, npm))
    .then(data => getReleaseCommits(packageDir, data))
    .then(data => getNextVersion(packageDir, data))
    .then(data => outputReleaseSummary(packageDir, data));
}

function runCommandNpmRun(packageDir: string, task: string): Promise<void> {
  return Promise.resolve()
    .then(() => getPackageJson(packageDir))
    .then(pkg => task in pkg.scripts)
    .then(hasTask => hasTask ? npm(packageDir, `run ${task}`) : console.log(`No ${task} script for ${packageDir}`));
}

function runCommandNpm(packageDir: string, args: string[]): Promise<void> {
  return Promise.resolve()
    .then(() => withPatchedPackageJson(packageDir, () => {
      return npm(packageDir, args.join(' '));
    }));
}

function runCommandPublish(packageDir: string): Promise<void> {
  return remoteNpmGet(packageDir)
    .then(npm => getReleaseData(packageDir, npm))
    .then(data => {
      if (data.lastVersion === data.pkg.version) {
        console.log(`No publish for ${packageDir} requried; Already published to npm`);
        return true;
      }
      const tag = `${data.pkg.name}-${data.pkg.version}`;
      return git(packageDir, 'tag')
        .then(stdout => {
          if (stdout.match(new RegExp(`^${tag}$`, 'm'))) {
            return git(packageDir, `rev-list --abbrev-commit -n 1 ${tag}`)
              .then(hash => console.log(`No git tag for ${packageDir} requried; Already tagged commit ${hash}`));
          }
          return getReleaseCommits(packageDir, data)
            .then(() => data.commits.find(commit => commit.updatesPackageJson || false))
            .then(commit => {
              if (!commit) {
                throw new Error('No release commit found');
              }
              return commit;
            })
            .then(commit => git('..', `tag ${tag} ${commit.hash}`));
        })
        .then(() => git('..', 'push --tags'))
        .then(() => git('..', 'remote -v'))
        .then(stdout => (stdout.match(/^\w+\s+([^ ]+)\s+\(\w+\)$/m) as string[])[1])
        .then(url => git('..', `clone ${url} publish-temp`))
        .then(() => git(path.join('..', 'publish-temp'), `checkout ${tag}`))
        .then(() => npm(path.join('..', 'publish-temp', 'packages', packageDir), 'install'))
        .then(() => npm(path.join('..', 'publish-temp', 'packages', packageDir), 'publish'))
        .then(() => fsRemove(path.join(process.cwd(), 'publish-temp')))
        .catch(err => {
          return fsRemove(path.join(process.cwd(), 'publish-temp')).then(() => {
            throw err;
          });
        })
        .then(() => false);
    });
}

interface Commands {
  bootstrap(packageDir: string): Promise<void>;
  reset(packageDir: string): Promise<void>;
  testRelease(packageDir: string): Promise<void>;
  release(packageDir: string): Promise<void>;
  publish(packageDir: string): Promise<void>;
  run(packageDir: string, task: string): Promise<void>;
  npm(packageDir: string): Promise<void>;
}
const commands: Commands = {
  bootstrap(packageDir): Promise<void> {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Bootstrapping ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandBootstrap(packageDir);
  },
  reset(packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Reset ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandReset(packageDir);
  },
  testRelease(packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Test ${packageDir} for release

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandTestRelease(packageDir);
  },
  release(packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Release ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandRelease(packageDir);
  },
  publish(packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Publish ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandPublish(packageDir);
  },
  run(packageDir, task): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Running npm script '${task}' in ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandNpmRun(packageDir, task);
  },
  npm(packageDir): Promise<void>  {
    const args = Array.prototype.slice.call(arguments).slice(1);

    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Running 'npm ${args.join(' ')}' in ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandNpm(packageDir, args);
  }
};

if (process.argv.length < 3) {
  console.error('Missing task');
  process.exit(1);
}

const command = process.argv[2];
const commandArguments = process.argv.slice(3);
const start = new Date().getTime();
runOnPackages(commands, command, commandArguments)
  .then(() => {
    const end = new Date().getTime();
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Successful command: ${command} (${((end - start) / 1000)}s)

      -------------------------------------------------------------------------------
    `}\n`);
  })
  .catch(err => {
    const end = new Date().getTime();
    console.error(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Failed command: ${command}  (${((end - start) / 1000)}s)
          ${err.toString()}

      -------------------------------------------------------------------------------
    `}\n`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  });
