import * as path from 'path';

import {forEach} from './foreach';
import {Host} from './io';

export interface PackageJson {
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
  publishConfig?: {
    tag: string;
  };
}

export const packagesDirectory = path.join(process.cwd(), 'packages');

export function getPackages(host: Host): Promise<string[]> {
  return host.readdir(packagesDirectory);
}

function readAllPackageJsonFiles(host: Host, list: string[]): Promise<PackageJson[]> {
  return Promise.all(list.map(file => getPackageJson(host, file)));
}

function findPkg(needle: string, pkgs: PackageJson[]): PackageJson {
  const pkg = pkgs.find(haystack => needle === haystack.name);
  if (!pkg) {
    throw new Error('No matching package.json found');
  }
  return pkg;
}

function containsDependency(name: string, pkg: PackageJson): boolean {
  return name in (pkg.devDependencies || {}) || name in (pkg.dependencies || {});
}

function sortDependencys(list: string[], pkgs: PackageJson[]): string[] {
  list.sort((left, right) => {
    if (containsDependency(left, findPkg(right, pkgs))) {
      return -1;
    }
    if (containsDependency(right, findPkg(left, pkgs))) {
      return 1;
    }
    return 0;
  });
  return list;
}

export async function getOrderedPackages(host: Host): Promise<string[]> {
  const packages = await getPackages(host);
  const pkgs = await readAllPackageJsonFiles(host, packages);
  return sortDependencys(packages, pkgs);
}

export function getPackageJson(host: Host, packageDir: string): Promise<PackageJson> {
  return host.readJson(path.join(packagesDirectory, packageDir, 'package.json'));
}

export async function patchPackageJson(host: Host, pkg: PackageJson): Promise<PackageJson> {
  const packages = await getPackages(host);
  packages.forEach(file => delete pkg.devDependencies[file]);
  packages.forEach(file => delete pkg.dependencies[file]);
  return pkg;
}

async function getPackageDependencies(host: Host, pkg: PackageJson): Promise<string[]> {
  const packages = await getPackages(host);
  return ([] as string[]).concat(
    packages.filter(file => file in pkg.devDependencies),
    packages.filter(file => file in pkg.dependencies)
  );
}

export async function linkDependencies(host: Host, packageDir: string): Promise<void> {
  await getPackages(host);
  const pkg = await getPackageJson(host, packageDir);
  const dependencies = await getPackageDependencies(host, pkg);
  await forEach<string, void>(dependencies, async dependency => {
    const dependecyModulPath = path.join(packagesDirectory, packageDir, 'node_modules', dependency);
    await host.writeFile(path.join(dependecyModulPath, 'index.js'),
        `module.exports = require('../../../${dependency}/')`);
    await host.writeFile(path.join(dependecyModulPath, 'index.d.ts'),
        `export * from '../../../${dependency}/index';`);
  });
}

export async function withPatchedPackageJson(host: Host, packageDir: string, fn: () => Promise<void>): Promise<void> {
  const packageJsonPath = path.join(packagesDirectory, packageDir, 'package.json');
  const packageJsonBackupPath = path.join(packagesDirectory, packageDir, 'package.json.orig');
  await host.copy(packageJsonPath, packageJsonBackupPath);
  try {
    const pkg = await host.readJson(packageJsonPath);
    await patchPackageJson(host, pkg);
    await host.writeJson(packageJsonPath, pkg);
    await fn();
  } finally {
    await host.move(packageJsonBackupPath, packageJsonPath, {clobber: true});
  }
}
