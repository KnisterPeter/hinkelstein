declare module 'npm-registry-client' {

  class NpmRegistryClient {
    constructor(opts?: any);
    get(url: string, params: any, callback: (err: any, data: NpmRegistryClient.Data) => void): Promise<NpmRegistryClient.Data>;
  }
  namespace NpmRegistryClient {
    export interface Data {
      'dist-tags': {
        [tag: string]: string;
      }
      versions: {
        [version: string]: {
          name: string;
          version: string;
          gitHead: string;
        };
      };
    }
  }
  export = NpmRegistryClient;
}
