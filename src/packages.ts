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
  publishConfig?: any;
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
};

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

export function getOrderedPackages(host: Host): Promise<string[]> {
  return getPackages(host)
    .then(packages =>
      readAllPackageJsonFiles(host, packages)
        .then(pkgs => ({packages, pkgs})))
    .then(context => sortDependencys(context.packages, context.pkgs));
}

export function getPackageJson(host: Host, packageDir: string): Promise<PackageJson> {
  return host.readJson(path.join(packagesDirectory, packageDir, 'package.json'));
}

export function patchPackageJson(host: Host, pkg: PackageJson): Promise<PackageJson> {
  return getPackages(host)
    .then(packages => {
      packages.forEach(file => delete pkg.devDependencies[file]);
      packages.forEach(file => delete pkg.dependencies[file]);
    })
    .then(() => pkg);
}

function getPackageDependencies(host: Host, pkg: PackageJson): Promise<string[]> {
  return getPackages(host)
    .then(packages => {
      return ([] as string[]).concat(
        packages.filter(file => file in pkg.devDependencies),
        packages.filter(file => file in pkg.dependencies)
      );
    });
}

export function linkDependencies(host: Host, packageDir: string): Promise<void> {
  return getPackages(host)
    .then(() => {
      return getPackageJson(host, packageDir)
        .then(pkg => getPackageDependencies(host, pkg))
        .then(dependencies => {
          return forEach(dependencies,
              dependency => {
                const dependecyModulPath = path.join(packagesDirectory, packageDir, 'node_modules', dependency);
                return host.writeFile(path.join(dependecyModulPath, 'index.js'),
                    `module.exports = require('../../../${dependency}/')`)
                  .then(() => host.writeFile(path.join(dependecyModulPath, 'index.d.ts'),
                    `export * from '../../../${dependency}/index';`));
              });
        });
    });
}

export function withPatchedPackageJson(host: Host, packageDir: string, fn: () => Promise<void>): Promise<void> {
  const packageJsonPath = path.join(packagesDirectory, packageDir, 'package.json');
  const packageJsonBackupPath = path.join(packagesDirectory, packageDir, 'package.json.orig');
  return host.copy(packageJsonPath, packageJsonBackupPath)
    .then(() => {
      return host.readJson(packageJsonPath)
        .then(pkg => patchPackageJson(host, pkg))
        .then(pkg => host.writeJson(packageJsonPath, pkg))
        .then(() => fn())
        .catch(err => {
          return host.move(packageJsonBackupPath, packageJsonPath, {clobber: true})
            .then(() => {
              throw err;
            });
        });
    })
    .then(() => host.move(packageJsonBackupPath, packageJsonPath, {clobber: true}));
}
