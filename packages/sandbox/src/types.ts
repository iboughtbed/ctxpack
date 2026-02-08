export type SandboxProvider = "vercel" | "daytona";
export type RemoteGitIndexingStrategy = "persistent" | "sandbox";

export type SandboxIndexWarningStage = "scan" | "read" | "chunk" | "embed";

export type SandboxIndexWarning = {
  filepath: string;
  stage: SandboxIndexWarningStage;
  message: string;
};

export type GitSandboxResource = {
  id: string;
  url: string | null;
  branch?: string | null;
  commit?: string | null;
  searchPaths?: string[] | null;
};

export type IndexableFileInput = {
  filepath: string;
  code: string;
};

export type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxLike = {
  runCommand: (
    command: string,
    args?: string[],
    cwd?: string,
  ) => Promise<SandboxCommandResult>;
  readFileToBuffer: (file: { path: string; cwd?: string }) => Promise<Buffer | null>;
  stop: () => Promise<void>;
};

export type SandboxGrepMatch = {
  filepath: string;
  line: number;
  text: string;
  submatches: Array<{
    match: string;
    start: number;
    end: number;
  }>;
};

export type SandboxReadParams = {
  resource: GitSandboxResource;
  filepath: string;
  startLine?: number;
  endLine?: number;
};

export type SandboxGrepParams = {
  resource: GitSandboxResource;
  pattern: string;
  paths?: string[];
  caseSensitive?: boolean;
};

export type SandboxListParams = {
  resource: GitSandboxResource;
  paths?: string[];
};

