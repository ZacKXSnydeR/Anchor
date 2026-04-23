import * as fs from "fs";

import { AutoCommitManager } from "../src/git/autocommit";

type GitStatus = {
  not_added: string[];
  created: string[];
  deleted: string[];
  modified: string[];
  renamed: Array<{ from: string; to: string }>;
};

const gitMock = {
  init: jest.fn(async () => undefined),
  addConfig: jest.fn(async () => undefined),
  status: jest.fn<Promise<GitStatus>, []>(async () => ({
    not_added: [],
    created: [],
    deleted: [],
    modified: ["src/file.ts"],
    renamed: [],
  })),
  add: jest.fn(async () => undefined),
  commit: jest.fn(async () => undefined),
  log: jest.fn(async () => ({ all: [] })),
};

jest.mock("simple-git", () => ({
  __esModule: true,
  default: jest.fn(() => gitMock),
}));

jest.mock(
  "vscode",
  () => ({
    window: {
      showInformationMessage: jest.fn(async () => "Later"),
    },
  }),
  { virtual: true },
);

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(() => true),
  };
});

describe("AutoCommitManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("creates a pre-edit commit when changes exist", async () => {
    const manager = new AutoCommitManager();
    await manager.initialize("C:\\workspace");
    await manager.commitBeforeAiEdit("large refactor");

    expect(gitMock.status).toHaveBeenCalledTimes(1);
    expect(gitMock.add).toHaveBeenCalledWith("-A");
    expect(gitMock.commit).toHaveBeenCalledWith(
      "anchor: pre-ai-edit snapshot - large refactor",
    );
    expect(fs.existsSync).toHaveBeenCalled();
  });
});
