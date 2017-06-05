import * as childProcess from 'child_process';
import * as path from 'path';
import * as util from 'util';

import * as commonTags from 'common-tags';
import * as conventionalCommitsParser from 'conventional-commits-parser';
import * as NpmRegistryClient from 'npm-registry-client';
import * as semver from 'semver';

import {forEach} from './foreach';
import {Host, DefaultHost} from './io';
import {PackageJson, packagesDirectory, getPackages, getPackageJson,
  getOrderedPackages, linkDependencies, withPatchedPackageJson} from './packages';

const gitlog = util.debuglog('git');
const npmlog = util.debuglog('npm');

async function npm(packageDir: string, command: string): Promise<void> {
  const opts = {
    cwd: path.join(packagesDirectory, packageDir),
    env: process.env,
    stdio: 'inherit'
  };
  const cmd = `npm ${command}`;
  npmlog(`executing '${cmd}'`);
  await childProcess.execSync(cmd, opts);
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

function getNpmTag(pkg: PackageJson): string {
  return pkg.publishConfig && pkg.publishConfig.tag ? pkg.publishConfig.tag : 'latest';
}

async function getReleaseData(host: Host, packageDir: string, npm: NpmRegistryClient.Data): Promise<ReleaseData> {
  const pkg = await getPackageJson(host, packageDir);
  const data: Partial<ReleaseData> = {
    npm,
    pkg
  };
  data.tag = getNpmTag(pkg);
  if (data.npm) {
    data.lastVersion = data.npm['dist-tags'][data.tag];
    if (data.lastVersion) {
      const npmVersionData = data.npm.versions[data.lastVersion];
      data.lastGitHash = npmVersionData.gitHead || `${npmVersionData.name}-${npmVersionData.version}`;
    }
  }
  if (!data.lastGitHash) {
    const firstGitHash = await git(packageDir, 'rev-list --abbrev-commit --max-parents=0 HEAD');
    data.lastGitHash = firstGitHash;
  }
  return data as ReleaseData;
}

interface Commit {
  hash: string;
  rawMessage: string;
  message: conventionalCommitsParser.CommitMessage;
}

async function getReleaseCommits(packageDir: string, data: ReleaseData): Promise<ReleaseData> {
  const stdout = await git(packageDir,
    `log --extended-regexp --format=%h==HASH==%B==END== ${data.lastGitHash}..HEAD -- .`);
  const commits = stdout.split('==END==\n')
    .filter(commit => Boolean(commit.trim()))
    .map(commit => {
      const parts = commit.split('==HASH==');
      return {
        hash: parts[0],
        rawMessage: parts[1]
      };
    })
    .map((commit: Commit) => {
      commit.message = conventionalCommitsParser.sync(commit.rawMessage);
      commit.message.hash = commit.hash;
      return commit.message;
    })
    .filter(commit => commit.scope === packageDir);
  data.commits = commits;
  data.requireRelease = data.commits.length > 0;
  const didUpdatePackageJson = async(commit: conventionalCommitsParser.CommitMessage) => {
    const diff = await git(packageDir, `show ${commit.hash}`);
    commit.updatesPackageJson = diff.indexOf(`packages/${packageDir}/package.json`) > -1;
  };
  await forEach<conventionalCommitsParser.CommitMessage, void>(commits, commit => didUpdatePackageJson(commit));
  return data;
}

function isBreakingChange(commit: conventionalCommitsParser.CommitMessage): boolean {
  return Boolean(commit.footer && commit.footer.indexOf('BREAKING CHANGE:\n') > -1);
}

async function getNextVersion(_packageDir: string, data: ReleaseData): Promise<ReleaseData> {
  const releases = ['patch', 'minor', 'major'];
  const typeToReleaseIndex = {
    fix: 0,
    feat: 1
  };
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
}

async function git(packageDir: string, command: string): Promise<string> {
  const opts = {
    cwd: path.join(packagesDirectory, packageDir),
    env: process.env
  };
  const cmd = `git ${command}`;
  gitlog(`executing '${cmd}'`);
  const buffer = await childProcess.execSync(cmd, opts);
  return buffer.toString().trim();
}

async function runOnPackages(host: Host, commands: Commands, command: string, args: string[]): Promise<void> {
  const packages = await getOrderedPackages(host);
  await forEach(packages, file => commands[command].apply(null, ([] as any).concat([file], args)));
}

async function runCommandBootstrap(host: Host, packageDir: string): Promise<void> {
  await withPatchedPackageJson(host, packageDir, async() => {
    await npm(packageDir, 'install');
    await npm(packageDir, 'prune');
  });
  await linkDependencies(host, packageDir);
}

function runCommandReset(host: Host, packageDir: string): Promise<void> {
  return host.remove(path.join(packagesDirectory, packageDir, 'node_modules'));
}

async function updatePackageJson(host: Host, packageDir: string, fn: (input: string) => string): Promise<void> {
  const packageJson = path.join(packagesDirectory, packageDir, 'package.json');
  const buffer = await host.readfile(packageJson);
  const data = await buffer.toString();
  await fn(data);
  await host.writeFile(packageJson, data);
}

function incrementPackageVersion(host: Host, packageDir: string, data: ReleaseData): Promise<void> {
  return updatePackageJson(host, packageDir, content =>
    content.replace(/^(\s*"version"\s*:\s*")\d+(?:\.\d+(?:\.\d+)?)?("\s*(?:,\s*)?)$/gm, `$1${data.nextVersion}$2`));
}

async function updateDependencies(host: Host, packageDir: string, data: ReleaseData): Promise<void> {
  const packages = await getPackages(host);
  await forEach<string, void>(packages, async dependency => {
    if (dependency in data.pkg.devDependencies || dependency in data.pkg.dependencies) {
      const pkg = await getPackageJson(host, dependency);
      updatePackageJson(host, packageDir, content => {
        return content.replace(new RegExp(
          `^(\\s*"${dependency}"\\s*:\\s*")\\d+(?:\\.\\d+(?:\\.\\d+)?)?("\\s*(?:,\\s*)?)$`, 'gm'),
          `$1${pkg.version}$2`);
      });
    }
  });
}

async function runCommandRelease(host: Host, packageDir: string): Promise<void> {
  let stdout = await git('..', `status --porcelain`);
  if (stdout !== '') {
    throw new Error('Git workspace not clean!');
  }
  const npm = await remoteNpmGet(packageDir);
  let data = await getReleaseData(host, packageDir, npm);
  data = await getReleaseCommits(packageDir, data);
  data = await getNextVersion(packageDir, data);
  if (!data.requireRelease) {
    console.log(`No release for ${packageDir} required`);
    return;
  }
  outputReleaseSummary(packageDir, data);
  await incrementPackageVersion(host, packageDir, data);
  await updateDependencies(host, packageDir, data);
  await runCommandNpmRun(host, packageDir, 'release');
  await runCommandNpmRun(host, packageDir, 'test');
  stdout = await git('..', `status --porcelain`);
  if (stdout !== '') {
    const commitMsg = `chore(${packageDir}): releases ${data.nextVersion}\n\n` + getCommitList('* ', '\n', data);
    await git('..', `add .`);
    await git('..', `commit -m "${commitMsg}"`);
  }
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

async function runCommandTestRelease(host: Host, packageDir: string): Promise<void> {
  const npm = await remoteNpmGet(packageDir);
  let data = await getReleaseData(host, packageDir, npm);
  data = await getReleaseCommits(packageDir, data);
  data = await getNextVersion(packageDir, data);
  await outputReleaseSummary(packageDir, data);
}

async function runCommandNpmRun(host: Host, packageDir: string, task: string): Promise<void> {
  const pkg = await getPackageJson(host, packageDir);
  if (task in pkg.scripts) {
    await npm(packageDir, `run ${task}`);
  } else {
    console.log(`No ${task} script for ${packageDir}`);
  }
}

async function runCommandNpm(host: Host, packageDir: string, args: string[]): Promise<void> {
  await withPatchedPackageJson(host, packageDir, () => {
    return npm(packageDir, args.join(' '));
  });
}

async function runCommandPublish(host: Host, packageDir: string): Promise<void> {
  const npmData = await remoteNpmGet(packageDir);
  const data = await getReleaseData(host, packageDir, npmData);
  if (data.lastVersion === data.pkg.version) {
    console.log(`No publish for ${packageDir} requried; Already published to npm`);
    return;
  }
  const tag = `${data.pkg.name}-${data.pkg.version}`;
  try {
    let stdout = await git(packageDir, 'tag');
    if (stdout.match(new RegExp(`^${tag}$`, 'm'))) {
      const hash = await git(packageDir, `rev-list --abbrev-commit -n 1 ${tag}`);
      console.log(`No git tag for ${packageDir} requried; Already tagged commit ${hash}`);
      return;
    }
    await getReleaseCommits(packageDir, data);
    const commit = data.commits.find(commit => commit.updatesPackageJson || false);
    if (!commit) {
      throw new Error('No release commit found');
    }
    await git('..', `tag ${tag} ${commit.hash}`);
    await git('..', 'push --tags');
    stdout = await git('..', 'remote -v');
    const url = (stdout.match(/^\w+\s+([^ ]+)\s+\(\w+\)$/m) as string[])[1];
    await git('..', `clone ${url} publish-temp`);
    await git(path.join('..', 'publish-temp'), `checkout ${tag}`);
    await npm(path.join('..', 'publish-temp', 'packages', packageDir), 'install');
    await npm(path.join('..', 'publish-temp', 'packages', packageDir), 'publish');
  } finally {
    await host.remove(path.join(process.cwd(), 'publish-temp'));
  }
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
(async function(): Promise<void> {
  try {
    await runOnPackages(host, commands, command, commandArguments);
    const end = new Date().getTime();
    console.log(`\n${commonTags.stripIndent`
      -------------------------------------------------------------------------------

        Successful command: ${command} (${((end - start) / 1000)}s)

      -------------------------------------------------------------------------------
    `}\n`);
  } catch (err) {
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
  }
})();
