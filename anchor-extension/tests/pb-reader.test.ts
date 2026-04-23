import { PbFileReader } from "../src/recovery/pb-reader";

describe("PbFileReader", () => {
  test("extracts printable text blocks from binary content", () => {
    const daemonStub = {
      isConnected: () => true,
      connect: async () => undefined,
      sendMessage: async () => ({ type: "Data", payload: null }),
    };

    const reader = new PbFileReader(daemonStub as never);
    const binary = Buffer.concat([
      Buffer.from([0, 159, 250, 17]),
      Buffer.from(
        "This is the first recovered sentence from protobuf bytes.",
        "utf8",
      ),
      Buffer.from([0, 0, 19, 0]),
      Buffer.from(
        "This is the first recovered sentence from protobuf bytes.",
        "utf8",
      ),
      Buffer.from([31, 200, 7, 9]),
      Buffer.from(
        "Another long recoverable message block from binary payload.",
        "utf8",
      ),
    ]);

    const blocks = reader.extractTextContent(binary);

    expect(blocks).toContain("This is the first recovered sentence from protobuf bytes.");
    expect(blocks).toContain("Another long recoverable message block from binary payload.");
  });
});
