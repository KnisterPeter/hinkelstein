import test from 'ava';
import {Host} from '../src/io';

import {getPackages, getOrderedPackages} from '../src/packages';

function setup(): Host {
  return {
    readdir(): Promise<string[]> { throw new Error('readir not implemented'); },
    readfile(): Promise<string> { throw new Error('readfile not implemented'); },
    writeFile(): Promise<void> { throw new Error('writefile not implemented'); },
    copy(): Promise<void> { throw new Error('copy not implemented'); },
    move(): Promise<void> { throw new Error('move not implemented'); },
    remove(): Promise<void> { throw new Error('remove not implemented'); },
    readJson(): Promise<any> { throw new Error('readJson not implemented'); },
    writeJson(): Promise<void> { throw new Error('writeJson not implemented'); }
  };
}

test('getPackages should return all paths to packages in this monorepo', t => {
  const host = setup();
  host.readdir = () => {
    return Promise.resolve(['a', 'b']);
  };
  return getPackages(host)
    .then(packages => {
      t.deepEqual(packages, ['a', 'b']);
    });
});

test('getOrderedPackages should return a list of packages ordered by dependency chain', t => {
  const host = setup();
  host.readdir = () => {
    return Promise.resolve(['a', 'b', 'c']);
  };
  host.readJson = path => {
    if (/a[\/\\]package.json$/.test(path)) {
      return Promise.resolve({
        name: 'a',
        dependencies: {
          b: '*'
        }
      });
    }
    if (/b[\/\\]package.json$/.test(path)) {
      return Promise.resolve({
        name: 'b'
      });
    }
    if (/c[\/\\]package.json$/.test(path)) {
      return Promise.resolve({
        name: 'c',
        devDependencies: {
          b: '*'
        }
      });
    }
    throw new Error(`Fail to read json from ${path}`);
  };
  return getOrderedPackages(host).then(packages => {
    t.deepEqual(packages, ['b', 'a', 'c']);
  });
});
