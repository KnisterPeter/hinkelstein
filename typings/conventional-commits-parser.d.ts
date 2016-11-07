declare module 'conventional-commits-parser' {
  module conventionalCommitsParser {
    export interface CommitMessage {
      type: 'fix' | 'feat';
      scope: string;
      hash: string;
      header: string;
      footer?: string;
      updatesPackageJson?: boolean;
    }

    export function sync(message: string): CommitMessage;
  }
  export = conventionalCommitsParser;
}
