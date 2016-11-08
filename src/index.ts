import * as util from 'util';
import * as path from 'path';
import * as childProcess from 'child_process';
import * as commonTags from 'common-tags';
import * as NpmRegistryClient from 'npm-registry-client';
import * as conventionalCommitsParser from 'conventional-commits-parser';
import * as semver from 'semver';

import {forEach} from './foreach';
import {PackageJson, packagesDirectory, getPackages, getPackageJson,
  getOrderedPackages, linkDependencies, withPatchedPackageJson} from './packages';
import {Host, DefaultHost} from './io';

const gitlog = util.debuglog('git');
const npmlog = util.debuglog('npm');

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

function getReleaseData(host: Host, packageDir: string, npm: NpmRegistryClient.Data): Promise<ReleaseData> {
  return Promise.resolve()
    .then(() => getPackageJson(host, packageDir)
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

function runOnPackages(host: Host, commands: Commands, command: string, args: string[]): Promise<void> {
  return getOrderedPackages(host)
    .then(packages => {
      return forEach(packages, file => {
        return commands[command].apply(null, ([] as any).concat([file], args));
      });
    });
}

function runCommandBootstrap(host: Host, packageDir: string): Promise<void> {
  return Promise.resolve()
    .then(() => {
      return withPatchedPackageJson(host, packageDir, () => {
        return npm(packageDir, 'install')
          .then(() => npm(packageDir, 'prune'));
      })
      .then(() => linkDependencies(host, packageDir));
    });
}

function runCommandReset(host: Host, packageDir: string): Promise<void> {
  return host.remove(path.join(packagesDirectory, packageDir, 'node_modules'));
}

function updatePackageJson(host: Host, packageDir: string, fn: (input: string) => string): Promise<void> {
  const packageJson = path.join(packagesDirectory, packageDir, 'package.json');
  return host.readfile(packageJson)
    .then(buffer => buffer.toString())
    .then(data => fn(data))
    .then(data => host.writeFile(packageJson, data));
}

function incrementPackageVersion(host: Host, packageDir: string, data: ReleaseData): Promise<void> {
  return updatePackageJson(host, packageDir, content =>
    content.replace(/^(\s*"version"\s*:\s*")\d+(?:\.\d+(?:\.\d+)?)?("\s*(?:,\s*)?)$/gm, `$1${data.nextVersion}$2`));
}

function updateDependencies(host: Host, packageDir: string, data: ReleaseData): Promise<void> {
  return getPackages(host)
    .then(packages => forEach(packages, dependency => {
      if (dependency in data.pkg.devDependencies || dependency in data.pkg.dependencies) {
        return getPackageJson(host, dependency)
          .then(pkg => updatePackageJson(host, packageDir, content =>
            content.replace(new RegExp(
              `^(\\s*"${dependency}"\\s*:\\s*")\\d+(?:\\.\\d+(?:\\.\\d+)?)?("\\s*(?:,\\s*)?)$`, 'gm'),
              `$1${pkg.version}$2`)));
      }
      return Promise.resolve(true);
    }));
}

function runCommandRelease(host: Host, packageDir: string): Promise<void> {
  return git('..', `status --porcelain`)
    .then(stdout => {
      if (stdout !== '') {
        throw new Error('Git workspace not clean!');
      }
    })
    .then(() => remoteNpmGet(packageDir))
    .then(npm => getReleaseData(host, packageDir, npm))
    .then(data => getReleaseCommits(packageDir, data))
    .then(data => getNextVersion(packageDir, data))
    .then(data => {
      if (data.requireRelease) {
        outputReleaseSummary(packageDir, data);
        return incrementPackageVersion(host, packageDir, data)
          .then(() => updateDependencies(host, packageDir, data))
          .then(() => runCommandNpmRun(host, packageDir, 'release'))
          .then(() => runCommandNpmRun(host, packageDir, 'test'))
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

function runCommandTestRelease(host: Host, packageDir: string): Promise<void> {
  return remoteNpmGet(packageDir)
    .then(npm => getReleaseData(host, packageDir, npm))
    .then(data => getReleaseCommits(packageDir, data))
    .then(data => getNextVersion(packageDir, data))
    .then(data => outputReleaseSummary(packageDir, data));
}

function runCommandNpmRun(host: Host, packageDir: string, task: string): Promise<void> {
  return Promise.resolve()
    .then(() => getPackageJson(host, packageDir))
    .then(pkg => task in pkg.scripts)
    .then(hasTask => hasTask ? npm(packageDir, `run ${task}`) : console.log(`No ${task} script for ${packageDir}`));
}

function runCommandNpm(host: Host, packageDir: string, args: string[]): Promise<void> {
  return Promise.resolve()
    .then(() => withPatchedPackageJson(host, packageDir, () => {
      return npm(packageDir, args.join(' '));
    }));
}

function runCommandPublish(host: Host, packageDir: string): Promise<void> {
  return remoteNpmGet(packageDir)
    .then(npm => getReleaseData(host, packageDir, npm))
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
        .then(() => host.remove(path.join(process.cwd(), 'publish-temp')))
        .catch(err => {
          return host.remove(path.join(process.cwd(), 'publish-temp')).then(() => {
            throw err;
          });
        })
        .then(() => false);
    });
}

interface Commands {
  bootstrap(host: Host, packageDir: string): Promise<void>;
  reset(host: Host, packageDir: string): Promise<void>;
  testRelease(host: Host, packageDir: string): Promise<void>;
  release(host: Host, packageDir: string): Promise<void>;
  publish(host: Host, packageDir: string): Promise<void>;
  run(host: Host, packageDir: string, task: string): Promise<void>;
  npm(host: Host, packageDir: string): Promise<void>;
}
const commands: Commands = {
  bootstrap(host, packageDir): Promise<void> {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Bootstrapping ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandBootstrap(host, packageDir);
  },
  reset(host, packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Reset ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandReset(host, packageDir);
  },
  testRelease(host, packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Test ${packageDir} for release

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandTestRelease(host, packageDir);
  },
  release(host, packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Release ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandRelease(host, packageDir);
  },
  publish(host, packageDir): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Publish ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandPublish(host, packageDir);
  },
  run(host, packageDir, task): Promise<void>  {
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Running npm script '${task}' in ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandNpmRun(host, packageDir, task);
  },
  npm(host, packageDir): Promise<void>  {
    const args = Array.prototype.slice.call(arguments).slice(1);

    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Running 'npm ${args.join(' ')}' in ${packageDir}

      -------------------------------------------------------------------------------
    `}\n`);
    return runCommandNpm(host, packageDir, args);
  }
};

if (process.argv.length < 3) {
  console.error('Missing task');
  process.exit(1);
}

const command = process.argv[2];
const commandArguments = process.argv.slice(3);
const start = new Date().getTime();
const host = new DefaultHost();
runOnPackages(host, commands, command, commandArguments)
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
