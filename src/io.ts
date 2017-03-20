import * as fs from 'fs';
import * as fsExtra from 'fs-extra';

function promisify(fn: Function): (...args: any[]) => Promise<any> {
  return function(...args): Promise<any> {
    return new Promise((resolve, reject) => {
      fn.apply(null, ([] as any[]).concat(args, function(...resultArgs: any[]): void {
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

export interface Host {
  readdir(path: string): Promise<string[]>;
  readfile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string, opts?: any): Promise<void>;
  remove(path: string): Promise<void>;
  readJson(path: string): Promise<any>;
  writeJson(path: string, data: any): Promise<void>;
}

export class DefaultHost implements Host {

  public readdir(path: string): Promise<string[]> {
    return fsReaddir(path);
  }

  public readfile(path: string): Promise<string> {
    return fsReadfile(path);
  }

  public writeFile(path: string, data: string): Promise<void> {
    return fsOutputFile(path, data);
  }

  public copy(from: string, to: string): Promise<void> {
    return fsCopy(from, to);
  }

  public move(from: string, to: string, opts?: any): Promise<void> {
    return fsMove(from, to, opts);
  }

  public remove(path: string): Promise<void> {
    return fsRemove(path);
  }

  public readJson(path: string): Promise<any> {
    return fsReadJson(path);
  }

  public writeJson(path: string, data: any): Promise<void> {
    return fsWriteJson(path, data);
  }

}
