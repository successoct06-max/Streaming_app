import { describe, it, expect } from "vitest";

declare const simnet: any;

describe("sanity", () => {
  it("runs a basic assertion", () => {
    expect(1).toBe(1);
  });
});
